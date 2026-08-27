import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

integration("PostgreSQL durable queue", () => {
  const repository = pool ? new PostgresMilestoneRepository(pool) : null;
  beforeEach(async () => resetPostgresFixtures(pool!));
  afterAll(async () => pool?.end());

  it("commits ingest and one coordination-only job atomically", async () => {
    const run = await ingestHandoff(handoff, "pg-queue-ingest", repository!);
    const jobs = await pool!.query<any>("select * from pipeline_queue_jobs where run_id=$1", [
      run.run_id,
    ]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ state: "ready", attempt: 0, options: {} });
    expect(Object.keys(jobs.rows[0].options)).not.toContain("handoff");
    await ingestHandoff(handoff, "pg-queue-ingest", repository!);
    expect(
      (await pool!.query("select 1 from pipeline_queue_jobs where run_id=$1", [run.run_id]))
        .rowCount,
    ).toBe(1);
  });

  it("claims with fencing, immutable leased options, durable refresh continuation and bounded retry", async () => {
    const run = await ingestHandoff(handoff, "pg-queue-claim", repository!);
    const lease = await repository!.claimQueueJob("worker-a", 30_000);
    await repository!.enqueueRun(run.run_id, { refresh_link_discovery: true });
    await repository!.enqueueRun(run.run_id, { refresh_link_discovery: true });
    expect(lease).toMatchObject({ run_id: run.run_id, attempt: 1, options: {} });
    expect(
      (
        await pool!.query(
          "select options,pending_refresh,pending_options from pipeline_queue_jobs where id=$1",
          [lease!.id],
        )
      ).rows[0],
    ).toEqual({ options: {}, pending_refresh: true, pending_options: {} });
    const stale = "00000000-0000-4000-8000-000000000000";
    expect(await repository!.heartbeatQueueJob(lease!.id, stale, 30_000)).toBe(false);
    expect(await repository!.finishQueueJob(lease!.id, stale, "completed")).toBe(false);
    expect(await repository!.finishQueueJob(lease!.id, lease!.token, "parked")).toBe(true);
    expect(
      (
        await pool!.query(
          "select state,attempt,options,pending_refresh,pending_options from pipeline_queue_jobs where id=$1",
          [lease!.id],
        )
      ).rows[0],
    ).toEqual({
      state: "ready",
      attempt: 0,
      options: { refresh_link_discovery: true },
      pending_refresh: false,
      pending_options: {},
    });
  });

  it("serialises refresh against the paid boundary: it is promoted or conflicts, never accepted late", async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const run = await ingestHandoff(handoff, `pg-refresh-boundary-${iteration}`, repository!);
      const lease = await repository!.claimQueueJob("worker", 30_000);
      const [close, refresh] = await Promise.allSettled([
        repository!.closeRefreshWindow(lease!.id, lease!.token),
        repository!.enqueueRun(run.run_id, { refresh_link_discovery: true }),
      ]);
      const row = (
        await pool!.query<any>(
          "select state,phase,options,pending_refresh,resume_after_refresh from pipeline_queue_jobs where id=$1",
          [lease!.id],
        )
      ).rows[0];
      if (close.status === "fulfilled" && close.value === "refresh_promoted") {
        expect(refresh.status).toBe("fulfilled");
        expect(row).toMatchObject({
          state: "ready",
          phase: "pre_downstream",
          options: { refresh_link_discovery: true },
          pending_refresh: false,
          resume_after_refresh: true,
        });
      } else {
        expect(close).toMatchObject({ status: "fulfilled", value: "downstream_started" });
        expect(refresh.status).toBe("rejected");
        if (refresh.status !== "rejected") throw new Error("Late refresh unexpectedly succeeded");
        expect(refresh.reason).toBeInstanceOf(Error);
        expect(refresh.reason.message).toContain("after paid downstream processing has started");
        expect(row).toMatchObject({
          state: "leased",
          phase: "downstream_started",
          options: {},
          pending_refresh: false,
        });
      }
    }
  });

  it("serialises concurrent cross-authority requests without merging them", async () => {
    const run = await ingestHandoff(handoff, "pg-queue-authority-isolation", repository!);
    const lease = await repository!.claimQueueJob("worker", 30_000);
    const results = await Promise.allSettled([
      repository!.enqueueRun(run.run_id, { refresh_link_discovery: true }),
      repository!.enqueueRun(run.run_id, { authorise_legacy_draft_recovery: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const row = (
      await pool!.query<any>(
        "select options,pending_refresh,pending_options from pipeline_queue_jobs where id=$1",
        [lease!.id],
      )
    ).rows[0];
    expect(row.options).toEqual({});
    expect(
      (row.pending_refresh && Object.keys(row.pending_options).length === 0) ||
        (!row.pending_refresh &&
          JSON.stringify(row.pending_options) ===
            JSON.stringify({ authorise_legacy_draft_recovery: true })),
    ).toBe(true);
  });

  it("waits behind the longer step lease without consuming queue attempt budget", async () => {
    const run = await ingestHandoff(handoff, "pg-queue-step-lease", repository!);
    const step = await repository!.claimStep(
      run.run_id,
      "internal_link_discovery",
      "crashed-worker",
    );
    await pool!.query(
      "update pipeline_queue_jobs set state='leased',attempt=1,lease_token=$2,lease_owner='old',lease_expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
      [run.run_id, "00000000-0000-4000-8000-000000000099"],
    );
    expect(await repository!.claimQueueJob("replacement", 30_000)).toBeNull();
    expect(
      (
        await pool!.query(
          "select state,attempt,last_error_code from pipeline_queue_jobs where run_id=$1",
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({
      state: "retry_wait",
      attempt: 1,
      last_error_code: "step_lease_coordination_wait",
    });
    await pool!.query(
      "update step_executions set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [step.execution_id],
    );
    await pool!.query("select pg_sleep(1.05)");
    const recoveredQueue = await repository!.claimQueueJob("replacement", 30_000);
    expect(recoveredQueue).toMatchObject({ run_id: run.run_id, attempt: 2 });
    const recoveredStep = await repository!.claimStep(
      run.run_id,
      "internal_link_discovery",
      "replacement",
    );
    expect(
      (
        await pool!.query(
          "select attempt,status from step_executions where run_id=$1 and step='internal_link_discovery' order by attempt",
          [run.run_id],
        )
      ).rows,
    ).toEqual([
      { attempt: 1, status: "retryable_failed" },
      { attempt: 2, status: "running" },
    ]);
    await repository!.failStep(recoveredStep.execution_id, recoveredStep.token, "fixture release");
    await repository!.finishQueueJob(recoveredQueue!.id, recoveredQueue!.token, "operator_action");
  });

  it.each([
    "review_writing_style",
    "review_information_gain",
    "review_fact_checking",
    "review_link_conversion",
  ])("classifies an evidence-free historical %s failure for explicit recovery", async (step) => {
    const run = await ingestHandoff(handoff, `pg-legacy-${step}`, repository!);
    await pool!.query("update runs set status='retryable_failed',current_step=$2 where id=$1", [
      run.run_id,
      step,
    ]);
    await pool!.query("delete from pipeline_queue_jobs where run_id=$1", [run.run_id]);
    const inserted = await pool!.query<any>(
      "insert into pipeline_queue_jobs(run_id) values($1) returning state,last_error_code",
      [run.run_id],
    );
    expect(inserted.rows[0]).toEqual({
      state: "operator_action",
      last_error_code: "legacy_review_explicit_recovery",
    });
    await expect(repository!.enqueueRun(run.run_id)).rejects.toThrow(
      "explicit operator recovery authorisation",
    );
    await repository!.enqueueRun(run.run_id, { authorise_legacy_review_recovery: true });
    expect(
      (
        await pool!.query("select state,options from pipeline_queue_jobs where run_id=$1", [
          run.run_id,
        ])
      ).rows[0],
    ).toEqual({ state: "ready", options: { authorise_legacy_review_recovery: true } });
  });

  it("persists immutable review transitions and replays the exact checkpoint", async () => {
    const run = await ingestHandoff(handoff, "pg-review-checkpoint", repository!);
    const document = await pool!.query<{ id: string }>(
      `with e as (
         insert into step_executions(run_id,step,attempt,status,started_at,completed_at)
         values($1,'draft',1,'succeeded',clock_timestamp(),clock_timestamp()) returning id
       ), a as (
         insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
         select $1,id,'draft','application/json','{}','review-doc-hash',2 from e returning id
       ) insert into document_versions(run_id,artifact_id,revision,content_hash)
         select $1,id,1,'review-doc-hash' from a returning id`,
      [run.run_id],
    );
    await repository!.ensureStep(run.run_id, "review_writing_style");
    const lease = await repository!.claimStep(run.run_id, "review_writing_style", "review-worker");
    const request: any = {
      run_id: run.run_id,
      document_version_id: document.rows[0]!.id,
      step: "review_writing_style",
      handoff,
      draft: {
        title: "Title",
        slug: "title",
        meta_description: "Description",
        og_title: "Title",
        og_description: "Description",
        images: [],
        faqs: [],
        markdown: "# Title",
        claims: [],
      },
      internal_links: [],
      reference_snapshots: [],
      fact_inventory: [],
      prompt: { template_id: "test", template_version: "1" },
      temperature: 0,
      model: "model",
    };
    const operation = await repository!.beginReviewOperation({
      run_id: run.run_id,
      document_version_id: document.rows[0]!.id,
      execution_id: lease.execution_id,
      token: lease.token,
      step: "review_writing_style",
      request,
      provider: "test",
      model: "model",
    });
    await repository!.markReviewProviderInFlight({
      run_id: run.run_id,
      execution_id: lease.execution_id,
      token: lease.token,
      operation_id: operation.operation_id,
    });
    const response: any = {
      request_id: "review-request",
      findings: [],
      sources: [],
      claims: [],
      usage: { input_units: 1, output_units: 1, cost_micros: 0 },
    };
    await repository!.checkpointReviewResponse({
      run_id: run.run_id,
      execution_id: lease.execution_id,
      token: lease.token,
      operation_id: operation.operation_id,
      response,
    });
    expect(
      await repository!.beginReviewOperation({
        run_id: run.run_id,
        document_version_id: document.rows[0]!.id,
        execution_id: lease.execution_id,
        token: lease.token,
        step: "review_writing_style",
        request,
        provider: "test",
        model: "model",
      }),
    ).toEqual({ operation_id: operation.operation_id, response });
    await expect(
      pool!.query("update review_operation_states set provider='changed' where operation_id=$1", [
        operation.operation_id,
      ]),
    ).rejects.toThrow("immutable");
  });

  it("startup recovery excludes waiting/terminal runs and fails closed on ambiguity", async () => {
    const run = await ingestHandoff(handoff, "pg-queue-recovery", repository!);
    await pool!.query(
      "update runs set status='waiting',current_step='findings_review' where id=$1",
      [run.run_id],
    );
    await repository!.recoverQueueJobs();
    expect(
      (await pool!.query("select state from pipeline_queue_jobs where run_id=$1", [run.run_id]))
        .rows[0].state,
    ).toBe("parked");
    expect(await repository!.claimQueueJob("worker", 30_000)).toBeNull();
  });
});

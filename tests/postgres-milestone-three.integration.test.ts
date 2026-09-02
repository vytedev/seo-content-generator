import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash, ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture } from "../src/shared/milestone-three.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { PipelineQueueWorker } from "../src/server/pipeline/queue-worker.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { PostgresMilestoneRepository } from "../src/server/persistence/postgres-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import {
  MockReviewProvider,
  type ReviewProvider,
} from "../src/server/providers/review-provider.js";
import { ChatCompletionReviewProvider } from "../src/server/providers/chat-completion-review-provider.js";
import { ConflictError } from "../src/shared/errors.js";
import { NoNetworkFactVerifier } from "../src/server/providers/fact-verifier.js";
import {
  REFERENCE_DOCUMENT_SEED_MANIFEST,
  generateReferenceSeedSql,
} from "../src/db/reference-seed.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
const handoff = {
  plane_ticket: "MOB-M3-PG",
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
const fixture: DeterministicFixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [],
};
const draft = {
  title: "Designer chair guide",
  slug: "designer-chair-guide",
  meta_description: "A practical guide.",
  og_title: "Designer chair",
  og_description: "A practical guide.",
  images: [],
  faqs: [],
  markdown: "# Designer chair\n\nA short direct answer.\n\n## Conclusion\n\nChoose carefully.",
  claims: [
    {
      text: "Designed by Example Studio",
      type: "provenance" as const,
      status: "unverified" as const,
    },
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};

function informationGainFinding() {
  return {
    stable_key: "useful-comparison",
    category: "information_gain",
    rule_reference: "value.comparison",
    severity: "warning" as const,
    location: { field: "body_markdown" as const },
    issue: "The comparison does not yet explain the practical trade-off.",
    suggested_fix: "Add one concrete, supportable comparison for the reader.",
  };
}

function malformedInformationGainProvider(): {
  provider: ReviewProvider;
  fetcher: ReturnType<typeof vi.fn>;
} {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "malformed-step-1-6",
          choices: [{ message: { content: "{not-json" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const liveShape = new ChatCompletionReviewProvider({
    token: "test_token_not_real",
    model: "review-v1",
    fetcher,
    sleep: () => Promise.resolve(),
  });
  const otherSteps = new MockReviewProvider("review-v1");
  return {
    fetcher,
    provider: {
      provider: liveShape.provider,
      model: liveShape.model,
      review: (request) =>
        request.step === "review_information_gain"
          ? liveShape.review(request)
          : otherSteps.review(request),
    },
  };
}

async function seedReferences() {
  await pool!.query(generateReferenceSeedSql());
  for (const item of REFERENCE_DOCUMENT_SEED_MANIFEST) {
    const body = `# ${item.title}\n\nLocal integration fixture.`;
    const hash = createHash("sha256").update(body).digest("hex");
    await pool!.query(
      `with d as (select id from reference_documents where kind=$1)
       insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes)
       select id,1,$2,$3,$4 from d on conflict(reference_document_id,version) do nothing`,
      [item.kind, body, hash, Buffer.byteLength(body)],
    );
    await pool!.query(
      `insert into reference_approval_attestations(reference_version_id,recorder_identity,approver_identity,evidence_reference,authority_state)
       select v.id,'local-test-recorder','local-test-approver','local-test-evidence','pending_unverified' from reference_versions v
       join reference_documents d on d.id=v.reference_document_id where d.kind=$1
       on conflict (reference_version_id) do nothing`,
      [item.kind],
    );
    await pool!.query(
      `insert into reference_attestation_verifications(attestation_id,verifier_identity,evidence_reference,authority_state)
       select a.id,'local-test-verifier','local-test-evidence','trusted_verified' from reference_approval_attestations a
       join reference_versions v on v.id=a.reference_version_id
       join reference_documents d on d.id=v.reference_document_id where d.kind=$1
       on conflict (attestation_id) do nothing`,
      [item.kind],
    );
    await pool!.query(
      `insert into reference_activations(reference_document_id,reference_version_id)
       select d.id,v.id from reference_documents d join reference_versions v on v.reference_document_id=d.id and v.version=1 where d.kind=$1
       on conflict(reference_document_id) do update set reference_version_id=excluded.reference_version_id`,
      [item.kind],
    );
  }
}

integration("PostgreSQL milestone three", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
    await seedReferences();
  });
  afterAll(async () => pool?.end());

  it("runs through the wait with exact snapshots, immutable findings, usage and provenance evidence", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "waiting", current_step: "findings_review" });
    expect(
      (
        await pool!.query(
          "select count(*)::int count from provider_usage where run_id=$1 and operation like 'review_%'",
          [run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(4);
    expect(
      (
        await pool!.query(
          "select count(*)::int count from step_reference_snapshots s join step_executions e on e.id=s.step_execution_id where e.run_id=$1",
          [run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(9);
    expect(
      (
        await pool!.query(
          "select type,status,hard_flag from claims where run_id=$1 order by type",
          [run.run_id],
        )
      ).rows,
    ).toEqual([
      { type: "dimension", status: "unverified", hard_flag: false },
      { type: "provenance", status: "unverified", hard_flag: true },
    ]);
    expect(
      (
        await pool!.query(
          "select count(*)::int count from claim_sources where run_id=$1 and evidence is not null",
          [run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(2);
    await expect(
      pool!.query("update findings set issue='changed' where run_id=$1", [run.run_id]),
    ).rejects.toThrow("append-only");

    const findings = await repository.listFindings(run.run_id, { disposition: "pending" });
    const version = (await repository.getDraft(run.run_id))!.version;
    const result = await repository.submitDispositions(run.run_id, {
      document_version_id: version.id,
      idempotency_key: "test-disposition-postgres-milestone-three.integration.test-0",
      dispositions: findings.map((finding) => ({
        finding_id: finding.id,
        decision: "accepted" as const,
      })),
    });
    expect(result).toEqual({
      completed: true,
      submitted: findings.length,
      continuation_required: true,
    });
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "running", current_step: "revision_pass" });
    expect(
      (
        await pool!.query(
          "select state from pipeline_queue_jobs where run_id=$1 and state in ('ready','leased','retry_wait')",
          [run.run_id],
        )
      ).rows,
    ).toEqual([{ state: "ready" }]);
    expect((await repository.getRunDetail(run.run_id)).can_retry).toBe(false);
  });

  it("rolls back the Step 1.9 transaction when queueing fails and permits retry", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-disposition-queue-failure", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    await pool!.query(
      "update pipeline_queue_jobs set state='parked',last_error_code='operator_wait' where run_id=$1",
      [run.run_id],
    );
    const queueBefore = (
      await pool!.query(
        `select state,attempt,phase,available_at,lease_token,lease_expires_at,options,
                pending_refresh,resume_after_refresh,pending_options,last_error_code
         from pipeline_queue_jobs where run_id=$1`,
        [run.run_id],
      )
    ).rows;
    const findings = await repository.listFindings(run.run_id, {});
    const version = (await repository.getDraft(run.run_id))!.version;
    const input = {
      document_version_id: version.id,
      idempotency_key: "m3-pg-disposition-queue-failure-key",
      dispositions: findings.map((finding) => ({
        finding_id: finding.id,
        decision: "accepted" as const,
      })),
    };
    const runtime = repository as unknown as {
      enqueueRunClient: (...args: unknown[]) => Promise<void>;
    };
    const originalEnqueue = runtime.enqueueRunClient;
    runtime.enqueueRunClient = vi.fn(async () => {
      throw new Error("injected enqueue failure");
    });
    try {
      await expect(repository.submitDispositions(run.run_id, input)).rejects.toThrow(
        "injected enqueue failure",
      );
    } finally {
      runtime.enqueueRunClient = originalEnqueue;
    }

    expect(
      (
        await pool!.query(
          `select
             (select count(*)::int from finding_review_submissions where run_id=$1) submissions,
             (select count(*)::int from finding_dispositions where run_id=$1) dispositions`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({ submissions: 0, dispositions: 0 });
    expect(
      (
        await pool!.query(
          `select r.status,r.current_step,r.block_reason,e.status execution_status
           from runs r join step_executions e on e.run_id=r.id and e.step='findings_review'
           where r.id=$1 order by e.attempt desc limit 1`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({
      status: "waiting",
      current_step: "findings_review",
      block_reason: null,
      execution_status: "waiting",
    });
    expect(
      (
        await pool!.query(
          `select state,attempt,phase,available_at,lease_token,lease_expires_at,options,
                  pending_refresh,resume_after_refresh,pending_options,last_error_code
           from pipeline_queue_jobs where run_id=$1`,
          [run.run_id],
        )
      ).rows,
    ).toEqual(queueBefore);

    await expect(repository.submitDispositions(run.run_id, input)).resolves.toEqual({
      completed: true,
      submitted: findings.length,
      continuation_required: true,
    });
    expect(
      (
        await pool!.query(
          `select
             (select count(*)::int from finding_review_submissions where run_id=$1) submissions,
             (select count(*)::int from finding_dispositions where run_id=$1) dispositions,
             (select state from pipeline_queue_jobs where run_id=$1) state`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({ submissions: 1, dispositions: findings.length, state: "ready" });
  });

  it("serialises concurrent Step 1.9 replay and reactivates the parked queue exactly once", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-disposition-concurrency", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    await pool!.query(
      "update pipeline_queue_jobs set state='parked',last_error_code='operator_wait' where run_id=$1",
      [run.run_id],
    );
    const findings = await repository.listFindings(run.run_id, {});
    const version = (await repository.getDraft(run.run_id))!.version;
    const input = {
      document_version_id: version.id,
      idempotency_key: "m3-pg-concurrent-disposition-key",
      dispositions: findings.map((finding) => ({
        finding_id: finding.id,
        decision: "accepted" as const,
      })),
    };

    const results = await Promise.all([
      repository.submitDispositions(run.run_id, input),
      repository.submitDispositions(run.run_id, input),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { completed: true, submitted: findings.length, continuation_required: true },
        { completed: true, submitted: findings.length, continuation_required: false },
      ]),
    );
    expect(
      (
        await pool!.query(
          `select
             (select count(*)::int from finding_review_submissions where run_id=$1) submissions,
             (select count(*)::int from finding_dispositions where run_id=$1) dispositions,
             (select count(*)::int from pipeline_queue_jobs where run_id=$1) jobs,
             (select state from pipeline_queue_jobs where run_id=$1) state`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({ submissions: 1, dispositions: findings.length, jobs: 1, state: "ready" });
  });

  it("adopts a pre-dispatch Step 1.5 operation after process loss without duplicate review calls", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-style-adoption", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    const base = new MockReviewProvider("review-v1");
    const review = vi.fn(base.review.bind(base));
    const provider = {
      provider: base.provider,
      model: base.model,
      review,
    } satisfies ReviewProvider;
    let crashed = false;

    await expect(
      new MilestoneThreeOrchestrator(repository, fixture, provider, {
        hit: (boundary) => {
          if (!crashed && boundary === "after_review_begin") {
            crashed = true;
            throw new Error("simulated loss after durable review begin");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("simulated loss after durable review begin");
    expect(review).not.toHaveBeenCalled();

    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(review).toHaveBeenCalledTimes(4);
    expect(
      review.mock.calls.filter(([request]) => request.step === "review_writing_style"),
    ).toHaveLength(1);
    const operation = (
      await pool!.query(
        `select o.operation_id,o.producing_step_execution_id,e.status,e.attempt
         from review_operation_states o join step_executions e on e.id=o.producing_step_execution_id
         where o.run_id=$1 and o.step='review_writing_style'`,
        [run.run_id],
      )
    ).rows[0];
    const history = (
      await pool!.query(
        `select a.from_step_execution_id,a.to_step_execution_id,old.status old_status,
                old.attempt old_attempt,new.status new_status,new.attempt new_attempt
         from review_operation_adoptions a
         join step_executions old on old.id=a.from_step_execution_id
         join step_executions new on new.id=a.to_step_execution_id
         where a.operation_id=$1`,
        [operation.operation_id],
      )
    ).rows;
    expect(history).toEqual([
      expect.objectContaining({
        old_status: "retryable_failed",
        old_attempt: 1,
        new_status: "succeeded",
        new_attempt: 2,
        to_step_execution_id: operation.producing_step_execution_id,
      }),
    ]);
    expect(
      (
        await pool!.query(
          `select step_execution_id from step_outputs
           where run_id=$1 and step='review_writing_style'`,
          [run.run_id],
        )
      ).rows,
    ).toEqual([{ step_execution_id: operation.producing_step_execution_id }]);
    expect(
      (
        await pool!.query(
          `select step_execution_id from provider_usage
           where run_id=$1 and operation='review_writing_style'`,
          [run.run_id],
        )
      ).rows,
    ).toEqual([{ step_execution_id: operation.producing_step_execution_id }]);
    await expect(
      pool!.query(
        `insert into review_operation_adoptions(operation_id,run_id,from_step_execution_id,to_step_execution_id)
         values($1,$2,$3,$4)`,
        [
          operation.operation_id,
          run.run_id,
          history[0]!.from_step_execution_id,
          history[0]!.to_step_execution_id,
        ],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("reconstructs a checkpointed Step 1.5 response before save without provider recall or duplicate output", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-style-checkpoint-replay", repository);
    await milestoneTwo(repository).run(run.run_id);
    const base = new MockReviewProvider("review-v1");
    const review = vi.fn(base.review.bind(base));
    let injected = false;
    const crashingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "checkpointReviewResponse")
          return async (
            input: Parameters<PostgresMilestoneRepository["checkpointReviewResponse"]>[0],
          ) => {
            await target.checkpointReviewResponse(input);
            if (!injected) {
              injected = true;
              throw new Error("simulated loss after response checkpoint");
            }
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const provider = {
      provider: base.provider,
      model: base.model,
      review,
    } satisfies ReviewProvider;

    await expect(
      new MilestoneThreeOrchestrator(crashingRepository, fixture, provider).run(run.run_id),
    ).rejects.toThrow("simulated loss after response checkpoint");
    expect(review).toHaveBeenCalledTimes(1);
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(
      review.mock.calls.filter(([request]) => request.step === "review_writing_style"),
    ).toHaveLength(1);
    expect(
      (
        await pool!.query(
          `select count(*)::int count from step_outputs
           where run_id=$1 and step='review_writing_style'`,
          [run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool!.query(
          `select count(*)::int count from provider_usage
           where run_id=$1 and operation='review_writing_style'`,
          [run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("persists and freezes Step 1.5 advisory-unavailable for operator disposition", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-style-fallback", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    const base = new MockReviewProvider("review-v1");
    const provider: ReviewProvider = {
      provider: base.provider,
      model: base.model,
      review: async (request) => {
        const response = await base.review(request);
        return request.step === "review_writing_style"
          ? {
              ...response,
              findings: [
                {
                  stable_key: "style-advisory-unavailable",
                  category: "style_advisory_unavailable",
                  rule_reference: "style.advisory_unavailable",
                  severity: "warning",
                  location: {
                    field: "body_markdown",
                    line_start: 1,
                    line_end: 1,
                    section: "Designer chair",
                  },
                  issue:
                    "The optional writing-style advisory was unavailable because its response was unusable.",
                  suggested_fix:
                    "Explicitly accept or reject this warning during findings review before the run continues.",
                },
              ],
            }
          : response;
      },
    };
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    const warning = (
      await pool!.query(
        `select f.id,f.rule_reference,f.severity,d.decision disposition
         from findings f left join finding_dispositions d on d.finding_id=f.id
         where f.run_id=$1 and f.rule_reference='style.advisory_unavailable'`,
        [run.run_id],
      )
    ).rows;
    expect(warning).toEqual([
      expect.objectContaining({
        rule_reference: "style.advisory_unavailable",
        severity: "warning",
        disposition: null,
      }),
    ]);
    const frozenIds = (
      await pool!.query(
        `select m.finding_id from finding_review_sets s
         join finding_review_set_members m on m.review_set_id=s.id
         where s.run_id=$1 order by m.ordinal`,
        [run.run_id],
      )
    ).rows.map((row) => row.finding_id);
    expect(frozenIds).toContain(warning[0]!.id);
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "waiting", current_step: "findings_review" });
  });

  it("adopts the exact Step 1.6 operation after begin, rejects its stale owner and persists once", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-value-adoption", repository);
    await milestoneTwo(repository).run(run.run_id);
    const base = new MockReviewProvider("review-v1", {
      review_information_gain: [informationGainFinding()],
    });
    const review = vi.fn(base.review.bind(base));
    let begins = 0;

    await expect(
      new MilestoneThreeOrchestrator(
        repository,
        fixture,
        {
          provider: base.provider,
          model: base.model,
          review,
        },
        {
          hit: (boundary) => {
            if (boundary === "after_review_begin" && ++begins === 2)
              throw new Error("simulated loss after Step 1.6 begin");
          },
        },
      ).run(run.run_id, "first-owner"),
    ).rejects.toThrow("simulated loss after Step 1.6 begin");
    expect(
      review.mock.calls.filter(([request]) => request.step === "review_information_gain"),
    ).toHaveLength(0);

    const stale = (
      await pool!.query(
        `select id,lease_token from step_executions
         where run_id=$1 and step='review_information_gain' order by attempt`,
        [run.run_id],
      )
    ).rows[0]!;
    await new MilestoneThreeOrchestrator(repository, fixture, {
      provider: base.provider,
      model: base.model,
      review,
    }).run(run.run_id, "replacement-owner");

    const operation = (
      await pool!.query(
        `select operation_id,producing_step_execution_id,request_hash,response_hash,status
         from review_operation_states where run_id=$1 and step='review_information_gain'`,
        [run.run_id],
      )
    ).rows[0]!;
    expect(operation).toMatchObject({ status: "checkpointed" });
    expect(
      review.mock.calls.filter(([request]) => request.step === "review_information_gain"),
    ).toHaveLength(1);
    expect(
      (
        await pool!.query(
          `select from_step_execution_id,to_step_execution_id from review_operation_adoptions
           where operation_id=$1`,
          [operation.operation_id],
        )
      ).rows,
    ).toEqual([
      {
        from_step_execution_id: stale.id,
        to_step_execution_id: operation.producing_step_execution_id,
      },
    ]);
    await expect(
      repository.markReviewProviderInFlight({
        run_id: run.run_id,
        execution_id: stale.id,
        token: stale.lease_token ?? "revoked-stale-token",
        operation_id: operation.operation_id,
      }),
    ).rejects.toThrow(/Stale|expired|fencing/i);

    const counts = (
      await pool!.query(
        `select
          (select count(*)::int from findings where run_id=$1 and step='review_information_gain') findings,
          (select count(*)::int from provider_usage where run_id=$1 and operation='review_information_gain') usage,
          (select count(*)::int from artifacts where step_execution_id=$2 and kind in ('review_request','review_response')) artifacts,
          (select count(*)::int from step_outputs where run_id=$1 and step='review_information_gain') outputs`,
        [run.run_id, operation.producing_step_execution_id],
      )
    ).rows[0];
    expect(counts).toEqual({ findings: 1, usage: 1, artifacts: 2, outputs: 1 });
    const artefacts = (
      await pool!.query(
        `select kind,body_text,content_hash from artifacts
         where step_execution_id=$1 and kind in ('review_request','review_response')`,
        [operation.producing_step_execution_id],
      )
    ).rows;
    const requestArtifact = artefacts.find((item) => item.kind === "review_request")!;
    const responseArtifact = artefacts.find((item) => item.kind === "review_response")!;
    expect(operation.request_hash).toBe(canonicalHash(JSON.parse(requestArtifact.body_text)));
    expect(operation.response_hash).toBe(canonicalHash(JSON.parse(responseArtifact.body_text)));
    expect(
      artefacts.every(
        (item) => createHash("sha256").update(item.body_text).digest("hex") === item.content_hash,
      ),
    ).toBe(true);
    await expect(
      pool!.query("update review_operation_states set request_hash=$2 where operation_id=$1", [
        operation.operation_id,
        "0".repeat(64),
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      pool!.query("update review_operation_states set response_hash=$2 where operation_id=$1", [
        operation.operation_id,
        "0".repeat(64),
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it("does not recall Step 1.6 when provider_in_flight has no checkpoint", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-value-ambiguous", repository);
    await milestoneTwo(repository).run(run.run_id);
    const base = new MockReviewProvider("review-v1");
    const review = vi.fn(base.review.bind(base));
    let returns = 0;
    const provider = {
      provider: base.provider,
      model: base.model,
      review,
    } satisfies ReviewProvider;

    await expect(
      new MilestoneThreeOrchestrator(repository, fixture, provider, {
        hit: (boundary) => {
          if (boundary === "after_review_provider" && ++returns === 2)
            throw new Error("simulated loss after Step 1.6 provider return");
        },
      }).run(run.run_id),
    ).rejects.toThrow("simulated loss after Step 1.6 provider return");
    await expect(
      new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id),
    ).rejects.toThrow("Review provider outcome is ambiguous");

    expect(
      review.mock.calls.filter(([request]) => request.step === "review_information_gain"),
    ).toHaveLength(1);
    const reviewOwner = (
      await pool!.query<{ producing_step_execution_id: string }>(
        `select producing_step_execution_id from review_operation_states
         where run_id=$1 and step='review_information_gain'`,
        [run.run_id],
      )
    ).rows[0]!;
    expect((await repository.getRunDetail(run.run_id)).paid_operation_ambiguities).toEqual([
      expect.objectContaining({
        kind: "review",
        owner: `step_execution:${reviewOwner.producing_step_execution_id}`,
      }),
    ]);
    expect(
      (
        await pool!.query(
          `select o.status,
            (select count(*)::int from findings where run_id=$1 and step='review_information_gain') findings,
            (select count(*)::int from provider_usage where run_id=$1 and operation='review_information_gain') usage,
            (select count(*)::int from step_outputs where run_id=$1 and step='review_information_gain') outputs
           from review_operation_states o where o.run_id=$1 and o.step='review_information_gain'`,
          [run.run_id],
        )
      ).rows,
    ).toEqual([{ status: "provider_in_flight", findings: 0, usage: 0, outputs: 0 }]);
  });

  it("replays a checkpointed Step 1.6 response before save without recall or duplicates", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-value-checkpoint", repository);
    await milestoneTwo(repository).run(run.run_id);
    const base = new MockReviewProvider("review-v1", {
      review_information_gain: [informationGainFinding()],
    });
    const review = vi.fn(base.review.bind(base));
    let injected = false;
    const crashingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "checkpointReviewResponse")
          return async (
            input: Parameters<PostgresMilestoneRepository["checkpointReviewResponse"]>[0],
          ) => {
            await target.checkpointReviewResponse(input);
            const operation = await pool!.query(
              "select step from review_operation_states where operation_id=$1",
              [input.operation_id],
            );
            if (!injected && operation.rows[0]?.step === "review_information_gain") {
              injected = true;
              throw new Error("simulated loss after Step 1.6 checkpoint");
            }
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const provider = {
      provider: base.provider,
      model: base.model,
      review,
    } satisfies ReviewProvider;

    await expect(
      new MilestoneThreeOrchestrator(crashingRepository, fixture, provider).run(run.run_id),
    ).rejects.toThrow("simulated loss after Step 1.6 checkpoint");
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);

    expect(
      review.mock.calls.filter(([request]) => request.step === "review_information_gain"),
    ).toHaveLength(1);
    const producer = (
      await pool!.query(
        `select producing_step_execution_id from review_operation_states
         where run_id=$1 and step='review_information_gain'`,
        [run.run_id],
      )
    ).rows[0]!.producing_step_execution_id;
    expect(
      (
        await pool!.query(
          `select
            (select count(*)::int from findings where run_id=$1 and step='review_information_gain') findings,
            (select count(*)::int from provider_usage where run_id=$1 and operation='review_information_gain') usage,
            (select count(*)::int from artifacts where step_execution_id=$2 and kind in ('review_request','review_response')) artifacts,
            (select count(*)::int from step_outputs where run_id=$1 and step='review_information_gain') outputs`,
          [run.run_id, producer],
        )
      ).rows[0],
    ).toEqual({ findings: 1, usage: 1, artifacts: 2, outputs: 1 });
  });

  it("replays a provider-only Step 1.8 checkpoint with the new audit and one model dispatch", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const linkedDraft = {
      ...draft,
      markdown:
        "# Designer chair\n\nSee the [chair collection](https://www.mobelaris.com/chairs).\n\n## Conclusion\n\nChoose carefully.",
    };
    const run = await ingestHandoff(handoff, "m3-pg-link-checkpoint-replay", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
      ]),
      new MockDraftProvider("draft-v1", linkedDraft),
    ).run(run.run_id);
    const base = new MockReviewProvider("review-v1", {
      review_link_conversion: [informationGainFinding()],
    });
    const review = vi.fn(base.review.bind(base));
    const provider = {
      provider: base.provider,
      model: base.model,
      review,
    } satisfies ReviewProvider;
    let verifications = 0;
    const verifier = {
      verify: async () =>
        ++verifications === 1
          ? ({ outcome: "confirmed_non_200", method: "head", status: 404 } as const)
          : ({
              outcome: "redirect",
              method: "head",
              status: 301,
              location: "/chairs-new",
            } as const),
    };
    let injected = false;
    const crashingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "checkpointReviewResponse")
          return async (
            input: Parameters<PostgresMilestoneRepository["checkpointReviewResponse"]>[0],
          ) => {
            await target.checkpointReviewResponse(input);
            const operation = await pool!.query(
              "select step from review_operation_states where operation_id=$1",
              [input.operation_id],
            );
            if (!injected && operation.rows[0]?.step === "review_link_conversion") {
              injected = true;
              throw new Error("simulated loss after provider-only Step 1.8 checkpoint");
            }
          };
        return Reflect.get(target, property, receiver);
      },
    }) as PostgresMilestoneRepository;

    await expect(
      new MilestoneThreeOrchestrator(
        crashingRepository,
        fixture,
        provider,
        undefined,
        new NoNetworkFactVerifier(),
        verifier,
      ).run(run.run_id),
    ).rejects.toThrow("simulated loss after provider-only Step 1.8 checkpoint");
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      provider,
      undefined,
      new NoNetworkFactVerifier(),
      verifier,
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);

    expect(verifications).toBe(2);
    expect(
      review.mock.calls.filter(([request]) => request.step === "review_link_conversion"),
    ).toHaveLength(1);
    const operation = (
      await pool!.query<{
        operation_id: string;
        response: { findings: Array<{ rule_reference: string }> };
        response_hash: string;
      }>(
        "select operation_id,response,response_hash from review_operation_states where run_id=$1 and step='review_link_conversion'",
        [run.run_id],
      )
    ).rows[0]!;
    expect(operation.response.findings).toHaveLength(1);
    expect(operation.response_hash).toBe(canonicalHash(operation.response));
    const persisted = (
      await pool!.query<{
        body_text: string;
        content_hash: string;
        output_hash: string;
        findings: number;
        usage: number;
        artifacts: number;
      }>(
        `select a.body_text,a.content_hash,o.content_hash output_hash,
          (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='review_link_conversion') findings,
          (select count(*)::int from provider_usage u where u.run_id=$1 and u.operation='review_link_conversion') usage,
          (select count(*)::int from artifacts x join step_executions e on e.id=x.step_execution_id where x.run_id=$1 and e.step='review_link_conversion') artifacts
         from artifacts a join step_executions e on e.id=a.step_execution_id
         join step_outputs o on o.step_execution_id=e.id
         where a.run_id=$1 and e.step='review_link_conversion' and a.kind='review_response'`,
        [run.run_id],
      )
    ).rows[0]!;
    const merged = JSON.parse(persisted.body_text) as {
      findings: Array<{ rule_reference: string }>;
    };
    expect(merged.findings.map((finding) => finding.rule_reference)).toContain(
      "link.target_redirect",
    );
    expect(merged.findings.map((finding) => finding.rule_reference)).not.toContain(
      "link.target_status",
    );
    expect(persisted.content_hash).toBe(
      createHash("sha256").update(persisted.body_text).digest("hex"),
    );
    expect(persisted.output_hash).toBe(canonicalHash(merged));
    expect(persisted).toMatchObject({ findings: 2, usage: 1, artifacts: 2 });
    const stale = (
      await pool!.query<{ id: string; lease_token: string | null }>(
        "select id,lease_token from step_executions where run_id=$1 and step='review_link_conversion' order by attempt limit 1",
        [run.run_id],
      )
    ).rows[0]!;
    await expect(
      repository.checkpointReviewResponse({
        run_id: run.run_id,
        execution_id: stale.id,
        token: stale.lease_token ?? "revoked-stale-token",
        operation_id: operation.operation_id,
        response: operation.response as never,
      }),
    ).rejects.toThrow(/Stale|expired|fencing/i);
    await expect(
      pool!.query("update review_operation_states set response_hash=$2 where operation_id=$1", [
        operation.operation_id,
        "0".repeat(64),
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      pool!.query("update review_operation_states set operation_id=$2 where operation_id=$1", [
        operation.operation_id,
        "review-operation_mutated",
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it("rolls back Step 1.8 atomically for a wrong checkpointResponse", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-link-wrong-checkpoint", repository);
    await milestoneTwo(repository).run(run.run_id);
    const saveReview = repository.saveReview.bind(repository);
    const wrongRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "saveReview")
          return async (...args: Parameters<PostgresMilestoneRepository["saveReview"]>) => {
            if (args[4] !== "review_link_conversion") return saveReview(...args);
            const checkpoint = args[9]!;
            args[9] = { ...checkpoint, request_id: `${checkpoint.request_id}-wrong` };
            return saveReview(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    }) as PostgresMilestoneRepository;

    await expect(
      new MilestoneThreeOrchestrator(
        wrongRepository,
        fixture,
        new MockReviewProvider("review-v1"),
      ).run(run.run_id),
    ).rejects.toThrow("exact validated provider checkpoint");
    expect(
      (
        await pool!.query(
          `select
            (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='review_link_conversion') findings,
            (select count(*)::int from provider_usage u where u.run_id=$1 and u.operation='review_link_conversion') usage,
            (select count(*)::int from artifacts a join step_executions e on e.id=a.step_execution_id where a.run_id=$1 and e.step='review_link_conversion') artifacts,
            (select count(*)::int from step_outputs o where o.run_id=$1 and o.step='review_link_conversion') outputs`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({ findings: 0, usage: 0, artifacts: 0, outputs: 0 });
  });

  it("persists and freezes the real Step 1.6 malformed-output fallback for operator disposition", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-value-fallback", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    const { provider, fetcher } = malformedInformationGainProvider();
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(fetcher).toHaveBeenCalledOnce();
    const warning = (
      await pool!.query(
        `select f.id,f.rule_reference,f.severity,d.decision disposition
         from findings f left join finding_dispositions d on d.finding_id=f.id
         where f.run_id=$1 and f.rule_reference='value.advisory_unavailable'`,
        [run.run_id],
      )
    ).rows;
    expect(warning).toEqual([
      expect.objectContaining({
        rule_reference: "value.advisory_unavailable",
        severity: "warning",
        disposition: null,
      }),
    ]);
    const frozenIds = (
      await pool!.query(
        `select m.finding_id from finding_review_sets s
         join finding_review_set_members m on m.review_set_id=s.id
         where s.run_id=$1 order by m.ordinal`,
        [run.run_id],
      )
    ).rows.map((row) => row.finding_id);
    expect(frozenIds).toContain(warning[0]!.id);
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "waiting", current_step: "findings_review" });
  });

  it("persists full fact inventory and advisory-unavailable/verifier findings with PostgreSQL parity", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-fact-fallback", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    const base = new MockReviewProvider("review-v1");
    const provider: ReviewProvider = {
      provider: base.provider,
      model: base.model,
      review: async (request) => {
        const response = await base.review(request);
        return request.step === "review_fact_checking"
          ? {
              ...response,
              findings: [
                {
                  stable_key: "fact-advisory-unavailable",
                  category: "fact_advisory_unavailable",
                  rule_reference: "fact.advisory_unavailable",
                  severity: "warning",
                  location: { field: "body_markdown" },
                  issue:
                    "The optional model fact advisory was unavailable because its response was unusable.",
                  suggested_fix: "Explicitly disposition this warning during findings review.",
                },
              ],
            }
          : response;
      },
    };
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(
      (await pool!.query("select count(*)::int count from claims where run_id=$1", [run.run_id]))
        .rows[0]?.count,
    ).toBe(2);
    expect(
      (await pool!.query("select count(*)::int count from sources where run_id=$1", [run.run_id]))
        .rows[0]?.count,
    ).toBe(2);
    const rules = (
      await pool!.query("select rule_reference from findings where run_id=$1", [run.run_id])
    ).rows.map((row) => row.rule_reference);
    expect(rules).toEqual(
      expect.arrayContaining([
        "fact.advisory_unavailable",
        "facts.unverified",
        "facts.provenance_always_review",
      ]),
    );
  });

  it("rejects cancelled submission/replay, stale replay and a same-key cross-run collision", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const prepare = async (key: string) => {
      const run = await ingestHandoff(handoff, key, repository);
      await new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer(),
        new MockDraftProvider("draft-v1", draft),
      ).run(run.run_id);
      await new MilestoneThreeOrchestrator(
        repository,
        fixture,
        new MockReviewProvider("review-v1"),
      ).run(run.run_id);
      const findings = await repository.listFindings(run.run_id, {});
      const version = (await repository.getDraft(run.run_id))!.version;
      return { run, findings, version };
    };
    const inputFor = (prepared: Awaited<ReturnType<typeof prepare>>, key: string) => ({
      document_version_id: prepared.version.id,
      idempotency_key: key,
      dispositions: prepared.findings.map((finding) => ({
        finding_id: finding.id,
        decision: "accepted" as const,
      })),
    });

    const cancelledSubmission = await prepare("m3-pg-cancelled-submission");
    await pool!.query("update runs set status='cancelled' where id=$1", [
      cancelledSubmission.run.run_id,
    ]);
    await expect(
      repository.submitDispositions(
        cancelledSubmission.run.run_id,
        inputFor(cancelledSubmission, "cancelled-submission-key"),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const completed = await prepare("m3-pg-replay-guards");
    const completedInput = inputFor(completed, "guarded-replay-key");
    await repository.submitDispositions(completed.run.run_id, completedInput);
    await pool!.query("update runs set status='cancelled' where id=$1", [completed.run.run_id]);
    await expect(
      repository.submitDispositions(completed.run.run_id, completedInput),
    ).rejects.toBeInstanceOf(ConflictError);

    await pool!.query("update runs set status='running' where id=$1", [completed.run.run_id]);
    const body = JSON.stringify({ ...draft, title: "Advanced revision" });
    const hash = createHash("sha256").update(body).digest("hex");
    const execution = (
      await pool!.query("select id from step_executions where run_id=$1 and step='draft'", [
        completed.run.run_id,
      ])
    ).rows[0]!.id;
    const artifact = (
      await pool!.query(
        `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
         values($1,$2,'draft_revision','application/json',$3,$4,$5) returning id`,
        [completed.run.run_id, execution, body, hash, Buffer.byteLength(body)],
      )
    ).rows[0]!.id;
    await pool!.query(
      `insert into document_versions(run_id,artifact_id,parent_id,revision,content_hash)
       values($1,$2,$3,2,$4)`,
      [completed.run.run_id, artifact, completed.version.id, hash],
    );
    await expect(
      repository.submitDispositions(completed.run.run_id, completedInput),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await prepare("m3-pg-cross-run");
    await expect(
      repository.submitDispositions(other.run.run_id, inputFor(other, "guarded-replay-key")),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects dispositions for a real historical document version", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-historical", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    const historical = (await repository.getDraft(run.run_id))!.version;
    const historicalFinding = (await repository.listFindings(run.run_id, {}))[0]!;
    const body = JSON.stringify({ ...draft, title: "Revision two" });
    const hash = createHash("sha256").update(body).digest("hex");
    const execution = (
      await pool!.query("select id from step_executions where run_id=$1 and step='draft'", [
        run.run_id,
      ])
    ).rows[0]!.id;
    const artifact = (
      await pool!.query(
        `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
         values($1,$2,'draft_revision','application/json',$3,$4,$5) returning id`,
        [run.run_id, execution, body, hash, Buffer.byteLength(body)],
      )
    ).rows[0]!.id;
    await pool!.query(
      `insert into document_versions(run_id,artifact_id,parent_id,revision,content_hash)
       values($1,$2,$3,2,$4)`,
      [run.run_id, artifact, historical.id, hash],
    );
    // Reads remain bound to immutable Step 1.9 membership even if a newer
    // document version appears after the wait was entered.
    expect((await repository.listFindings(run.run_id, {})).map((item) => item.id)).toContain(
      historicalFinding.id,
    );
    await expect(
      repository.submitDispositions(run.run_id, {
        document_version_id: historical.id,
        idempotency_key: "test-disposition-postgres-milestone-three.integration.test-1",
        dispositions: [{ finding_id: historicalFinding.id, decision: "accepted" }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("retries a persisted review without duplicate durable records", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-retry", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    let fired = false;
    await expect(
      new MilestoneThreeOrchestrator(repository, fixture, new MockReviewProvider("review-v1"), {
        hit: (boundary) => {
          if (!fired && boundary === "after_review_persist") {
            fired = true;
            throw new Error("injected");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("injected");
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    const counts = await pool!.query(
      "select (select count(*)::int from provider_usage where run_id=$1 and operation like 'review_%') usage,(select count(*)::int from claims where run_id=$1) claims,(select count(*)::int from step_outputs where run_id=$1) outputs",
      [run.run_id],
    );
    expect(counts.rows[0]).toEqual({ usage: 4, claims: 2, outputs: 5 });
    const producers = await pool!.query(
      `select count(*)::int count from step_outputs o
       join step_executions e on e.id=o.step_execution_id
       where o.run_id=$1 and e.status='succeeded'`,
      [run.run_id],
    );
    expect(producers.rows[0]?.count).toBe(5);
  });

  function milestoneTwo(repository: PostgresMilestoneRepository) {
    return new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    );
  }

  function stopAtStep15Provider() {
    const base = new MockReviewProvider("review-v1");
    return {
      provider: base.provider,
      model: base.model,
      review: vi.fn(async () => {
        throw new Error("stop safely at Step 1.5 test boundary");
      }),
    } satisfies ReviewProvider;
  }

  function productionWorker(
    repository: PostgresMilestoneRepository,
    milestoneThree: MilestoneThreeOrchestrator,
    owner: string,
  ) {
    const m3Run = vi.spyOn(milestoneThree, "run");
    const m4Run = vi.fn(async () => undefined);
    return {
      worker: new PipelineQueueWorker(
        repository,
        {
          milestoneTwo: milestoneTwo(repository),
          milestoneThree,
          milestoneFour: { run: m4Run } as never,
        },
        owner,
        5_000,
        5,
      ),
      m3Run,
      m4Run,
    };
  }

  async function prepareCrashedStep14(key: string) {
    const repository = new PostgresMilestoneRepository(pool!, 5_000);
    const run = await ingestHandoff(handoff, key, repository);
    await milestoneTwo(repository).run(run.run_id);
    expect(await repository.stepSucceeded(run.run_id, "ingest_handoff")).toBe(true);
    expect(await repository.stepSucceeded(run.run_id, "internal_link_discovery")).toBe(true);
    expect(await repository.stepSucceeded(run.run_id, "draft")).toBe(true);
    const queue = await repository.claimQueueJob("old-worker", 5_000);
    expect(queue).not.toBeNull();
    await repository.closeRefreshWindow(queue!.id, queue!.token);
    const step = await repository.claimStep(run.run_id, "automated_checks", "old-worker");
    return { repository, run, queue: queue!, step };
  }

  async function expireQueue(jobId: string) {
    await pool!.query(
      "update pipeline_queue_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [jobId],
    );
  }

  async function expireStep(executionId: string) {
    await pool!.query(
      "update step_executions set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [executionId],
    );
  }

  it("recovers a durable pre-persistence Step 1.4 process death through the production worker exactly once", async () => {
    const crashed = await prepareCrashedStep14("m3-step14-pre-persistence-death");
    const orphanSnapshots = await crashed.repository.snapshotReferences(
      crashed.run.run_id,
      crashed.step.execution_id,
      crashed.step.token,
    );
    expect(orphanSnapshots.length).toBeGreaterThan(0);
    expect(
      (
        await pool!.query(
          `select
             (select count(*)::int from deterministic_manifests where run_id=$1) manifests,
             (select count(*)::int from step_outputs where run_id=$1 and step='automated_checks') outputs,
             (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='automated_checks') findings`,
          [crashed.run.run_id],
        )
      ).rows[0],
    ).toEqual({ manifests: 0, outputs: 0, findings: 0 });

    await expireQueue(crashed.queue.id);
    const reviewProvider = stopAtStep15Provider();
    const replacement = productionWorker(
      crashed.repository,
      new MilestoneThreeOrchestrator(crashed.repository, fixture, reviewProvider),
      "replacement-worker",
    );
    await replacement.worker.start();
    await vi.waitFor(async () => {
      expect(
        (
          await pool!.query(
            "select state,attempt,last_error_code from pipeline_queue_jobs where id=$1",
            [crashed.queue.id],
          )
        ).rows[0],
      ).toEqual({
        state: "retry_wait",
        attempt: crashed.queue.attempt,
        last_error_code: "step_lease_coordination_wait",
      });
    });
    expect(replacement.m3Run).not.toHaveBeenCalled();
    expect(
      (
        await pool!.query(
          "select count(*)::int count from deterministic_manifests where run_id=$1",
          [crashed.run.run_id],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await replacement.worker.stop();

    await expireStep(crashed.step.execution_id);
    await pool!.query("select pg_sleep(1.05)");
    const recovered = productionWorker(
      crashed.repository,
      new MilestoneThreeOrchestrator(crashed.repository, fixture, reviewProvider),
      "replacement-worker-after-step-expiry",
    );
    await recovered.worker.start();
    await vi.waitFor(async () => expect(recovered.m3Run).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    await vi.waitFor(async () => {
      expect(
        (await pool!.query("select state from pipeline_queue_jobs where id=$1", [crashed.queue.id]))
          .rows[0]?.state,
      ).toBe("operator_action");
    });
    await recovered.worker.stop();
    expect(reviewProvider.review).toHaveBeenCalledTimes(1);
    expect(recovered.m4Run).not.toHaveBeenCalled();

    const baseline = await crashed.repository.getDeterministicManifest(crashed.run.run_id);
    const executions = (
      await pool!.query(
        "select id,attempt,status from step_executions where run_id=$1 and step='automated_checks' order by attempt",
        [crashed.run.run_id],
      )
    ).rows;
    expect(executions).toEqual([
      { id: crashed.step.execution_id, attempt: 1, status: "retryable_failed" },
      { id: baseline.manifest.producing_execution_id, attempt: 2, status: "succeeded" },
    ]);
    const snapshots = (
      await pool!.query(
        `select s.step_execution_id,s.reference_document_id,s.reference_version_id,s.content_hash
         from step_reference_snapshots s join step_executions e on e.id=s.step_execution_id
         where e.run_id=$1 and e.step='automated_checks'
         order by s.step_execution_id,s.reference_document_id`,
        [crashed.run.run_id],
      )
    ).rows;
    const orphan = snapshots.filter((row) => row.step_execution_id === crashed.step.execution_id);
    const authoritative = snapshots.filter(
      (row) => row.step_execution_id === baseline.manifest.producing_execution_id,
    );
    expect(orphan).toHaveLength(orphanSnapshots.length);
    expect(authoritative).toHaveLength(baseline.manifest.references.length);
    expect(
      authoritative
        .map(({ reference_version_id, content_hash }) => ({
          version_id: reference_version_id,
          content_hash,
        }))
        .sort((a, b) => a.version_id.localeCompare(b.version_id)),
    ).toEqual(
      baseline.manifest.references
        .map(({ version_id, content_hash }) => ({ version_id, content_hash }))
        .sort((a, b) => a.version_id.localeCompare(b.version_id)),
    );
    const records = (
      await pool!.query(
        `select m.manifest_hash,m.result_hash,o.content_hash,
          count(distinct f.id)::int finding_count,count(distinct f.stable_key)::int stable_key_count
         from deterministic_manifests m
         join step_outputs o on o.run_id=m.run_id and o.step='automated_checks' and o.step_execution_id=m.step_execution_id
         left join findings f on f.step_execution_id=m.step_execution_id
         where m.run_id=$1 group by m.manifest_hash,m.result_hash,o.content_hash`,
        [crashed.run.run_id],
      )
    ).rows;
    expect(records).toEqual([
      {
        manifest_hash: baseline.manifest.manifest_hash,
        result_hash: baseline.result.result_hash,
        content_hash: baseline.result.result_hash,
        finding_count: baseline.result.findings.length,
        stable_key_count: baseline.result.findings.length,
      },
    ]);
    expect(
      (await pool!.query("select current_step from runs where id=$1", [crashed.run.run_id])).rows[0]
        ?.current_step,
    ).toBe("review_writing_style");
  });

  it("recovers a post-persistence process death without recomputing Step 1.4", async () => {
    const repository = new PostgresMilestoneRepository(pool!, 5_000);
    const run = await ingestHandoff(handoff, "m3-step14-post-persistence-death", repository);
    const reviewProvider = stopAtStep15Provider();
    let injected = false;
    const original = productionWorker(
      repository,
      new MilestoneThreeOrchestrator(repository, fixture, reviewProvider, {
        hit: (boundary) => {
          if (!injected && boundary === "after_deterministic_persist") {
            injected = true;
            throw new Error("simulated process loss after atomic deterministic persistence");
          }
        },
      }),
      "original-worker",
    );
    await original.worker.start();
    await vi.waitFor(async () => {
      expect(
        (await pool!.query("select state from pipeline_queue_jobs where run_id=$1", [run.run_id]))
          .rows[0]?.state,
      ).toBe("operator_action");
    });
    await original.worker.stop();
    expect(original.m3Run).toHaveBeenCalledTimes(1);
    expect(reviewProvider.review).not.toHaveBeenCalled();
    expect(original.m4Run).not.toHaveBeenCalled();

    const before = await repository.getDeterministicManifest(run.run_id);
    const staleExecution = before.manifest.producing_execution_id;
    const staleToken = (
      await pool!.query("select lease_token from step_executions where id=$1", [staleExecution])
    ).rows[0]?.lease_token as string;
    const beforeCounts = (
      await pool!.query(
        `select
          (select count(*)::int from step_executions where run_id=$1 and step='automated_checks') executions,
          (select count(*)::int from deterministic_manifests where run_id=$1) manifests,
          (select count(*)::int from step_outputs where run_id=$1 and step='automated_checks') outputs,
          (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='automated_checks') findings`,
        [run.run_id],
      )
    ).rows[0];
    await repository.enqueueRun(run.run_id);
    const lostQueueLease = await repository.claimQueueJob("lost-process", 5_000);
    expect(lostQueueLease).not.toBeNull();
    await expireQueue(lostQueueLease!.id);

    const replacementProvider = stopAtStep15Provider();
    const replacement = productionWorker(
      repository,
      new MilestoneThreeOrchestrator(repository, fixture, replacementProvider),
      "replacement-worker",
    );
    await replacement.worker.start();
    await vi.waitFor(async () => expect(replacement.m3Run).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      expect(
        (await pool!.query("select state from pipeline_queue_jobs where run_id=$1", [run.run_id]))
          .rows[0]?.state,
      ).toBe("operator_action");
    });
    await replacement.worker.stop();
    expect(replacementProvider.review).toHaveBeenCalledTimes(1);
    expect(replacement.m4Run).not.toHaveBeenCalled();

    expect(await repository.getDeterministicManifest(run.run_id)).toEqual(before);
    expect(
      (
        await pool!.query(
          `select
            (select count(*)::int from step_executions where run_id=$1 and step='automated_checks') executions,
            (select count(*)::int from deterministic_manifests where run_id=$1) manifests,
            (select count(*)::int from step_outputs where run_id=$1 and step='automated_checks') outputs,
            (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='automated_checks') findings`,
          [run.run_id],
        )
      ).rows[0],
    ).toEqual(beforeCounts);

    const progress = (
      await pool!.query("select status,current_step from runs where id=$1", [run.run_id])
    ).rows[0];
    await expect(
      repository.saveDeterministicBaseline({
        run_id: run.run_id,
        document_version_id: before.manifest.baseline_document.id,
        execution_id: staleExecution,
        token: staleToken,
        manifest: before.manifest,
        result: before.result,
        findings: [],
      }),
    ).rejects.toThrow(/Stale|expired|fencing/i);
    await expect(repository.completeStep(staleExecution, staleToken)).rejects.toThrow(
      /Stale|expired|fencing/i,
    );
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual(progress);
  });

  it("fails closed on an immutable Step 1.4 conflict and preserves the authoritative baseline", async () => {
    const repository = new PostgresMilestoneRepository(pool!, 5_000);
    const run = await ingestHandoff(handoff, "m3-step14-immutable-conflict", repository);
    let baselinePersisted = false;
    const baselineWorker = productionWorker(
      repository,
      new MilestoneThreeOrchestrator(repository, fixture, new MockReviewProvider("review-v1"), {
        hit: (boundary) => {
          if (!baselinePersisted && boundary === "after_deterministic_persist") {
            baselinePersisted = true;
            throw new Error("stop safely after Step 1.4 persistence");
          }
        },
      }),
      "baseline-worker",
    );
    await baselineWorker.worker.start();
    await vi.waitFor(async () => expect(baselineWorker.m3Run).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      expect(
        (await pool!.query("select state from pipeline_queue_jobs where run_id=$1", [run.run_id]))
          .rows[0]?.state,
      ).toBe("operator_action");
    });
    await baselineWorker.worker.stop();
    const baseline = await repository.getDeterministicManifest(run.run_id);
    const recordsBefore = (
      await pool!.query(
        `select
          (select count(*)::int from deterministic_manifests where run_id=$1) manifests,
          (select count(*)::int from step_outputs where run_id=$1 and step='automated_checks') outputs,
          (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='automated_checks') findings`,
        [run.run_id],
      )
    ).rows[0];

    const conflictingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "stepSucceeded")
          return async (runId: string, step: string) =>
            step === "automated_checks" ? false : target.stepSucceeded(runId, step as never);
        if (property === "claimStep")
          return async (...args: Parameters<PostgresMilestoneRepository["claimStep"]>) =>
            target.claimStep(args[0], args[1], args[2], true);
        if (property === "hasStepOutput") return async () => false;
        if (property === "saveDeterministicBaseline")
          return async (
            input: Parameters<PostgresMilestoneRepository["saveDeterministicBaseline"]>[0],
          ) =>
            target.saveDeterministicBaseline({
              ...input,
              manifest: { ...input.manifest, manifest_hash: "0".repeat(64) },
            });
        return Reflect.get(target, property, receiver);
      },
    });
    await repository.enqueueRun(run.run_id);
    const conflictWorker = productionWorker(
      conflictingRepository,
      new MilestoneThreeOrchestrator(
        conflictingRepository,
        fixture,
        new MockReviewProvider("review-v1"),
      ),
      "conflict-worker",
    );
    await conflictWorker.worker.start();
    await vi.waitFor(async () => expect(conflictWorker.m3Run).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      expect(
        (
          await pool!.query(
            "select state,last_error_code from pipeline_queue_jobs where run_id=$1",
            [run.run_id],
          )
        ).rows[0],
      ).toEqual({ state: "operator_action", last_error_code: "unsafe_pipeline_failure" });
    });
    await conflictWorker.worker.stop();
    expect(conflictWorker.m4Run).not.toHaveBeenCalled();
    expect(await repository.getDeterministicManifest(run.run_id)).toEqual(baseline);
    expect(
      await pool!.query(
        `select
          (select count(*)::int from deterministic_manifests where run_id=$1) manifests,
          (select count(*)::int from step_outputs where run_id=$1 and step='automated_checks') outputs,
          (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id where f.run_id=$1 and e.step='automated_checks') findings`,
        [run.run_id],
      ),
    ).toMatchObject({ rows: [recordsBefore] });
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "retryable_failed", current_step: "automated_checks" });
  });
});

import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  renderExport,
} from "../src/shared/export.js";
import {
  createDeterministicManifest,
  deterministicHash,
  runVersionedDeterministicChecks,
} from "../src/shared/deterministic-run.js";
import { canonicalHash, ingestHandoff } from "../src/shared/milestone-two.js";
import { RepositoryConflictError } from "../src/shared/errors.js";
import { PostgresGoogleDocsExportService } from "../src/server/export-service.js";
import { PostgresMilestoneRepository } from "../src/server/persistence/postgres-repository.js";
import {
  MilestoneTwoOrchestrator,
  MockLinkDiscoverer,
} from "../src/server/pipeline/milestone-two.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockGoogleDocsAdapter } from "../src/server/providers/google-docs.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
async function seedPassingFinalGate(
  runId: string,
  documentVersionId: string,
  artifactId: string,
  finalExecutionId: string,
) {
  const context = (
    await pool!.query<any>(
      `select r.handoff,d.content_hash,a.body_text from runs r join document_versions d on d.run_id=r.id
       join artifacts a on a.id=d.artifact_id where r.id=$1 and d.id=$2`,
      [runId, documentVersionId],
    )
  ).rows[0];
  const draft = JSON.parse(context.body_text);
  const fixture = { internal_origins: ["https://www.mobelaris.com"], link_verification: [] };
  const checkerInput = {
    primary_keyword: context.handoff.primary_keyword,
    related_keywords: context.handoff.related_keywords,
    body_markdown: draft.markdown,
    on_page: {
      meta_title: draft.title,
      meta_description: draft.meta_description,
      og_title: draft.og_title,
      og_description: draft.og_description,
      slug: draft.slug,
      images: draft.images.map(({ alt, filename }: { alt: string; filename: string }) => ({
        alt,
        filename,
      })),
      faqs: draft.faqs,
    },
    internal_origins: fixture.internal_origins,
    verified_internal_links: [],
  };
  const baselineExecution = (
    await pool!.query<{ id: string }>(
      `insert into step_executions(run_id,step,attempt,status,started_at,completed_at)
       values($1,'automated_checks',1,'succeeded',clock_timestamp(),clock_timestamp()) returning id`,
      [runId],
    )
  ).rows[0]!.id;
  const manifest = createDeterministicManifest({
    run_id: runId,
    document: { id: documentVersionId, content_hash: context.content_hash },
    handoff: context.handoff,
    checker_input: checkerInput,
    fixture: {
      source_identity: "fixture://pg-export",
      content_hash: deterministicHash(fixture),
      content: fixture,
    },
    internal_links_artifact: {
      artifact_id: artifactId,
      content_hash: deterministicHash("[]"),
      body_text: "[]",
      body: [],
      metadata_artifact_id: null,
      metadata_content_hash: null,
      metadata_body_text: null,
      metadata: null,
    },
    references: [],
    producing_execution_id: baselineExecution,
    executed_at: "2026-08-21T00:00:00.000Z",
  });
  const result = runVersionedDeterministicChecks(
    checkerInput,
    { id: documentVersionId, content_hash: context.content_hash },
    manifest,
  );
  await pool!.query(
    `insert into deterministic_manifests(run_id,document_version_id,step_execution_id,manifest_hash,manifest,result_hash,result)
     values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
    [
      runId,
      documentVersionId,
      baselineExecution,
      manifest.manifest_hash,
      JSON.stringify(manifest),
      result.result_hash,
      JSON.stringify(result),
    ],
  );
  const rerunExecution = (
    await pool!.query<{ id: string }>(
      `insert into step_executions(run_id,step,attempt,status,started_at,completed_at)
       values($1,'automated_checks_rerun',1,'succeeded',clock_timestamp(),clock_timestamp()) returning id`,
      [runId],
    )
  ).rows[0]!.id;
  await pool!.query(
    `insert into deterministic_reruns(run_id,document_version_id,step_execution_id,baseline_manifest_hash,result_hash,result,retained_blockers,introduced_blockers)
     values($1,$2,$3,$4,$5,$6::jsonb,0,0)`,
    [
      runId,
      documentVersionId,
      rerunExecution,
      manifest.manifest_hash,
      result.result_hash,
      JSON.stringify(result),
    ],
  );
  await pool!.query(
    `insert into step_outputs(run_id,document_version_id,step,step_execution_id,content_hash)
     values($1,$2,'automated_checks_rerun',$3,$4)`,
    [runId, documentVersionId, rerunExecution, result.result_hash],
  );
  const response = { findings: [], usage: { input_units: 0, output_units: 0, cost_micros: 0 } };
  const request = { fixture: true };
  await pool!.query(
    `insert into coherence_checkpoints(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash,response,response_hash,checkpointed_at)
     values($1,$2,$3,$4,$5,$6::jsonb,$7,clock_timestamp())`,
    [
      `gate:${runId}`,
      runId,
      documentVersionId,
      finalExecutionId,
      canonicalHash(request),
      JSON.stringify(response),
      canonicalHash(response),
    ],
  );
  await pool!.query(
    `insert into provider_operations(operation_id,run_id,document_version_id,step_execution_id,operation,content_hash)
     values($1,$2,$3,$4,'final_coherence_export',$5)`,
    [`gate:${runId}`, runId, documentVersionId, finalExecutionId, canonicalHash(response)],
  );
}

const handoff = {
  plane_ticket: "MOB-PG",
  primary_keyword: "designer dining chairs",
  related_keywords: ["modern dining chair"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};

integration("PostgreSQL milestone two contracts", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
  });
  afterAll(async () => pool?.end());

  it("runs the orchestrator end-to-end and replays without duplicate rows", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "orchestrator-e2e", repository);
    const provider = new MockDraftProvider("mock-v1");
    const orchestrator = new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        {
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          title: "Mobelaris furniture guides",
          relevance: 0.9,
        },
      ]),
      provider,
    );

    await orchestrator.run(run.run_id);

    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "running", current_step: "automated_checks" });
    const counts = async () =>
      (
        await pool!.query(
          `select (select count(*)::int from document_versions where run_id=$1) versions,
                  (select count(*)::int from provider_usage where run_id=$1) usage,
                  (select count(*)::int from artifacts where run_id=$1 and kind='draft') drafts`,
          [run.run_id],
        )
      ).rows[0];
    const first = await counts();
    expect(first).toEqual({ versions: 1, usage: 1, drafts: 1 });
    expect(
      (
        await pool!.query(
          "select revision from document_versions where run_id=$1 order by revision",
          [run.run_id],
        )
      ).rows,
    ).toEqual([{ revision: 1 }]);
    expect(provider.calls).toHaveLength(1);

    await orchestrator.run(run.run_id, "resume-worker");

    expect(await counts()).toEqual(first);
    expect(provider.calls).toHaveLength(1);
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ status: "running", current_step: "automated_checks" });
  });

  it("persistently blocks empty, editorial, unverified and stale discovery before drafting/model spend", async () => {
    const cases = [
      {
        reason: "no_candidates" as const,
        availability: "available" as const,
        counts: {
          deduplicated: 0,
          commercial: 0,
          editorial: 0,
          verification_attempted: 0,
          unresolved: 0,
        },
      },
      {
        reason: "editorial_only" as const,
        availability: "available" as const,
        counts: {
          deduplicated: 2,
          commercial: 0,
          editorial: 2,
          verification_attempted: 0,
          unresolved: 0,
        },
      },
      {
        reason: "verification_failed" as const,
        availability: "available" as const,
        counts: {
          deduplicated: 1,
          commercial: 1,
          editorial: 0,
          verification_attempted: 1,
          unresolved: 1,
        },
      },
      {
        reason: "source_unavailable" as const,
        availability: "stale" as const,
        counts: {
          deduplicated: 1,
          commercial: 1,
          editorial: 0,
          verification_attempted: 1,
          unresolved: 0,
        },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const repository = new PostgresMilestoneRepository(pool!);
      const run = await ingestHandoff(handoff, `blocked-${index}`, repository);
      const provider = new MockDraftProvider("must-not-run");
      const discoverer = {
        discover: async () => ({
          availability: testCase.availability,
          eligibility: "blocked" as const,
          reason: testCase.reason,
          links: [],
          providerStatus: { ghost: "available" as const, gsc: "unavailable" as const },
          counts: {
            ghost_collected: testCase.counts.deduplicated,
            gsc_collected: 0,
            ...testCase.counts,
            direct_200: 0,
            rejected_non_200: 0,
            shortlisted: 0,
          },
          cache:
            testCase.availability === "stale"
              ? {
                  state: "stale" as const,
                  retrieved_at: "2026-01-01T00:00:00.000Z",
                  expires_at: "2026-01-02T00:00:00.000Z",
                }
              : { state: "miss" as const, retrieved_at: null, expires_at: null },
          identity: {
            query_hash: "a".repeat(64),
            config_hash: "b".repeat(64),
            origin_policy_hash: "c".repeat(64),
            request_hash: "d".repeat(64),
          },
        }),
      };
      await expect(
        new MilestoneTwoOrchestrator(repository, discoverer, provider).run(run.run_id),
      ).rejects.toThrow("Link discovery blocked");
      expect(provider.calls).toHaveLength(0);
      const persisted = (
        await pool!.query(
          `select
          (select count(*)::int from document_versions where run_id=$1) versions,
          (select count(*)::int from provider_usage where run_id=$1) usage,
          (select count(*)::int from artifacts where run_id=$1 and kind='draft') drafts,
          (select count(*)::int from artifacts where run_id=$1 and kind='internal_links') links,
          (select count(*)::int from link_discovery_attempts where run_id=$1) evidence`,
          [run.run_id],
        )
      ).rows[0];
      expect(persisted).toEqual({ versions: 0, usage: 0, drafts: 0, links: 0, evidence: 1 });
    }
  });

  it("recovers the same blocked run only through forced fresh discovery and drafts the exact persisted shortlist", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "forced-refresh-recovery", repository);
    const provider = new MockDraftProvider("mock-v1");
    const shortlist = [
      {
        url: "https://www.mobelaris.com/products/fresh-chair",
        title: "Fresh chair",
        relevance: 0.91,
        status: 200 as const,
        hierarchy: "product" as const,
        hierarchy_rank: 4,
      },
    ];
    const calls: Array<{ refresh?: boolean } | undefined> = [];
    const discoverer = {
      discover: async (_keyword: string, options?: { refresh?: boolean }) => {
        calls.push(options);
        if (!options?.refresh)
          return {
            availability: "unavailable" as const,
            eligibility: "blocked" as const,
            reason: "source_unavailable" as const,
            links: [],
            providerStatus: { ghost: "unavailable" as const, gsc: "not_configured" as const },
            counts: {
              ghost_collected: 0,
              gsc_collected: 0,
              deduplicated: 0,
              commercial: 0,
              editorial: 0,
              verification_attempted: 0,
              direct_200: 0,
              rejected_non_200: 0,
              unresolved: 0,
              shortlisted: 0,
            },
            cache: {
              state: "stale" as const,
              retrieved_at: "2026-01-01T00:00:00.000Z",
              expires_at: "2026-01-02T00:00:00.000Z",
            },
            identity: {
              query_hash: "a".repeat(64),
              config_hash: "b".repeat(64),
              origin_policy_hash: "c".repeat(64),
              request_hash: "d".repeat(64),
            },
          };
        return {
          availability: "available" as const,
          eligibility: "eligible" as const,
          reason: "verified_commercial_candidates" as const,
          links: shortlist,
          providerStatus: { ghost: "available" as const, gsc: "not_configured" as const },
          counts: {
            ghost_collected: 1,
            gsc_collected: 0,
            deduplicated: 1,
            commercial: 1,
            editorial: 0,
            verification_attempted: 1,
            direct_200: 1,
            rejected_non_200: 0,
            unresolved: 0,
            shortlisted: 1,
          },
          cache: {
            state: "refreshed" as const,
            retrieved_at: "2026-01-03T00:00:00.000Z",
            expires_at: "2026-01-04T00:00:00.000Z",
          },
          identity: {
            query_hash: "a".repeat(64),
            config_hash: "b".repeat(64),
            origin_policy_hash: "c".repeat(64),
            request_hash: "d".repeat(64),
          },
        };
      },
    };
    const orchestrator = new MilestoneTwoOrchestrator(repository, discoverer, provider);
    await expect(orchestrator.run(run.run_id)).rejects.toThrow("source");
    await orchestrator.run(run.run_id, "retry-worker", { refreshLinkDiscovery: true });
    expect(calls).toEqual([{ refresh: false }, { refresh: true }]);
    expect(provider.calls[0]?.internal_links).toEqual(shortlist);
    expect(await repository.getLinks(run.run_id)).toEqual(shortlist);
    expect(
      (
        await pool!.query("select count(*)::int count from document_versions where run_id=$1", [
          run.run_id,
        ])
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("concurrently replays identical ingest and conflicts different input", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const replayed = await Promise.all([
      ingestHandoff(handoff, "concurrent-ingest", repository),
      ingestHandoff(handoff, "concurrent-ingest", repository),
    ]);
    expect(replayed[1]).toEqual(replayed[0]);
    expect(
      (await pool!.query("select id from runs where idempotency_key='concurrent-ingest'")).rowCount,
    ).toBe(1);

    const changed = { ...handoff, word_count_target: 901 };
    const outcomes = await Promise.allSettled([
      ingestHandoff(handoff, "concurrent-conflict", repository),
      ingestHandoff(changed, "concurrent-conflict", repository),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(RepositoryConflictError) });
  });

  it("serialises claims, preserves failures, increments attempts and recovers an expired running lease", async () => {
    const repository = new PostgresMilestoneRepository(pool!, 30_000);
    const ingest = await ingestHandoff(handoff, "claim-test", repository);
    const claims = await Promise.allSettled([
      repository.claimStep(ingest.run_id, "internal_link_discovery", "a"),
      repository.claimStep(ingest.run_id, "internal_link_discovery", "b"),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const first = claims.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
      execution_id: string;
      token: string;
    }>;
    await pool!.query(
      "update step_executions set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [first.value.execution_id],
    );
    const second = await repository.claimStep(ingest.run_id, "internal_link_discovery", "c");
    expect(second.execution_id).not.toBe(first.value.execution_id);
    const attempts = await pool!.query<{ attempt: number; status: string }>(
      "select attempt,status from step_executions where run_id=$1 and step='internal_link_discovery' order by attempt",
      [ingest.run_id],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, status: "retryable_failed" },
      { attempt: 2, status: "running" },
    ]);
    await repository.failStep(second.execution_id, second.token, "retry");
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [ingest.run_id]))
        .rows[0],
    ).toEqual({ status: "retryable_failed", current_step: "internal_link_discovery" });
  });

  it("atomically fences cache CAS, metadata, artefact and candidates", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "link-cache-atomic", repository);
    const lease = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
    const retrieved = "2026-01-01T00:00:00.000Z";
    const links = [
      {
        url: "https://www.mobelaris.com/products/chair",
        title: "Chair",
        relevance: 0.8,
        status: 200 as const,
        hierarchy: "product" as const,
        hierarchy_rank: 4,
        verified_at: retrieved,
        verification_method: "head" as const,
        source: "ghost_content" as const,
        keyword_overlap: 1,
        topical_score: 1,
        hierarchy_score: 0.5,
        gsc_score: 0,
        ghost_id: "ghost-1",
        ghost_content_type: "post" as const,
        retrieved_at: retrieved,
      },
    ];
    const payload = {
      availability: "available" as const,
      links,
      providerStatus: { ghost: "available" as const, gsc: "not_configured" as const },
      retrievedAt: retrieved,
    };
    const metadata = {
      availability: payload.availability,
      providerStatus: payload.providerStatus,
      cacheWrite: {
        cache_key: "internal-links:v2",
        request_hash: "a".repeat(64),
        response_hash: canonicalHash(payload),
        provider: "ghost-content+gsc",
        retrieved_at: retrieved,
        expires_at: "2026-01-02T00:00:00.000Z",
        payload,
        observed_retrieved_at: null,
      },
    };
    await pool!.query(
      "update step_executions set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [lease.execution_id],
    );
    await expect(
      repository.saveLinks(run.run_id, lease.execution_id, lease.token, links, metadata),
    ).rejects.toThrow("fencing");
    expect(
      (
        await pool!.query(
          "select count(*)::int count from link_discovery_cache where request_hash=$1",
          ["a".repeat(64)],
        )
      ).rows[0]?.count,
    ).toBe(0);

    const retry = await repository.claimStep(run.run_id, "internal_link_discovery", "worker-2");
    await repository.saveLinks(run.run_id, retry.execution_id, retry.token, links, metadata);
    const counts = (
      await pool!.query(
        `select
      (select count(*)::int from link_discovery_cache where request_hash=$2) cache,
      (select count(*)::int from artifacts where run_id=$1 and kind='internal_links') artefact,
      (select count(*)::int from artifacts where run_id=$1 and kind='internal_link_discovery_metadata') metadata,
      (select count(*)::int from link_candidates where run_id=$1) candidates`,
        [run.run_id, "a".repeat(64)],
      )
    ).rows[0];
    expect(counts).toEqual({ cache: 1, artefact: 1, metadata: 1, candidates: 1 });
  });

  it("replays SERP warnings and stores raw-byte hashes", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const first = await ingestHandoff(handoff, "serp", repository, {
      inspect: async () => {
        throw new Error("offline");
      },
    });
    expect(first.warnings[0]?.code).toBe("serp_probe_failed");
    expect(
      (await ingestHandoff(handoff, "serp", new PostgresMilestoneRepository(pool!))).warnings,
    ).toEqual(first.warnings);
    const artifact = await pool!.query<{ valid: boolean }>(
      "select content_hash=encode(digest(convert_to(body_text,'UTF8'),'sha256'),'hex') valid from artifacts where run_id=$1 and kind='ingest_result'",
      [first.run_id],
    );
    expect(artifact.rows[0]?.valid).toBe(true);
  });

  it("rejects malformed draft responses before mutation or fence checks", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "malformed", repository);
    const before = await pool!.query(
      "select (select count(*) from artifacts where run_id=$1) artifacts,(select count(*) from document_versions where run_id=$1) versions,(select count(*) from provider_usage where run_id=$1) usage",
      [run.run_id],
    );
    await expect(
      repository.saveDraft(
        run.run_id,
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000000",
        { request_id: "malformed" } as never,
        "provider",
        "model",
      ),
    ).rejects.toThrow();
    const after = await pool!.query(
      "select (select count(*) from artifacts where run_id=$1) artifacts,(select count(*) from document_versions where run_id=$1) versions,(select count(*) from provider_usage where run_id=$1) usage",
      [run.run_id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("keeps provider request identities run-scoped and rejects conflicting revision one without side effects", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const provider = new MockDraftProvider("mock-v1");
    const runA = await ingestHandoff(handoff, "a", repository);
    const runB = await ingestHandoff({ ...handoff, plane_ticket: "MOB-PG-2" }, "b", repository);
    for (const run of [runA, runB]) {
      const linkLease = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
      await repository.saveLinks(run.run_id, linkLease.execution_id, linkLease.token, []);
      await repository.completeStep(linkLease.execution_id, linkLease.token);
      expect(
        (await pool!.query("select current_step from runs where id=$1", [run.run_id])).rows[0],
      ).toEqual({ current_step: "draft" });
      const draftLease = await repository.claimStep(run.run_id, "draft", "worker");
      const response = await provider.generate({
        handoff: run.handoff,
        internal_links: [],
        model: provider.model,
      });
      await repository.saveDraft(
        run.run_id,
        draftLease.execution_id,
        draftLease.token,
        response,
        provider.provider,
        provider.model,
      );
      if (run === runA) {
        const before = await pool!.query(
          "select (select count(*) from artifacts where run_id=$1) artifacts,(select count(*) from provider_usage where run_id=$1) usage",
          [run.run_id],
        );
        await expect(
          repository.saveDraft(
            run.run_id,
            draftLease.execution_id,
            draftLease.token,
            { ...response, draft: { ...response.draft, title: "Changed" } },
            provider.provider,
            provider.model,
          ),
        ).rejects.toThrow("conflict");
        const after = await pool!.query(
          "select (select count(*) from artifacts where run_id=$1) artifacts,(select count(*) from provider_usage where run_id=$1) usage",
          [run.run_id],
        );
        expect(after.rows).toEqual(before.rows);
      }
    }
    expect(
      (await pool!.query("select count(*)::int count from provider_usage")).rows[0]?.count,
    ).toBe(2);
  });

  it("exports restart-safely, rejects tampered rendering and keeps separate lineage parents", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "export", repository);
    const links = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
    await repository.saveLinks(run.run_id, links.execution_id, links.token, []);
    await repository.completeStep(links.execution_id, links.token);
    const lease = await repository.claimStep(run.run_id, "draft", "worker");
    const provider = new MockDraftProvider("mock-v1");
    const saved = await repository.saveDraft(
      run.run_id,
      lease.execution_id,
      lease.token,
      await provider.generate({ handoff, internal_links: [], model: provider.model }),
      provider.provider,
      provider.model,
    );
    await repository.completeStep(lease.execution_id, lease.token);
    const finalLease = await repository.claimStep(run.run_id, "final_coherence_export", "worker");
    await seedPassingFinalGate(
      run.run_id,
      saved.version.id,
      saved.artifact.id,
      finalLease.execution_id,
    );
    const renderInput = {
      plane_ticket: handoff.plane_ticket,
      draft: saved.draft,
      export_date: "2026-08-21",
      writer_template: DEFAULT_WRITER_TEMPLATE,
      schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
    };
    const rendered = renderExport(renderInput);
    const request = {
      run_id: run.run_id,
      step_execution_id: finalLease.execution_id,
      fencing_token: finalLease.token,
      document_version_id: saved.version.id,
      idempotency_key: "export-key",
      render_input: renderInput,
      rendered,
    };
    await expect(
      new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()).export({
        ...request,
        step_execution_id: lease.execution_id,
        fencing_token: lease.token,
      }),
    ).rejects.toThrow("fencing");
    await expect(
      new PostgresGoogleDocsExportService(pool!, {
        export: async () => {
          throw new Error("mock export unavailable");
        },
      }).export(request),
    ).rejects.toThrow("unavailable");
    expect(
      (
        await pool!.query(
          "select status,last_error from export_operations where run_id=$1 and document_version_id=$2",
          [run.run_id, saved.version.id],
        )
      ).rows[0],
    ).toEqual({ status: "failed", last_error: "EXPORT_PROVIDER_FAILED" });

    const adapter = new MockGoogleDocsAdapter();
    const service = new PostgresGoogleDocsExportService(pool!, adapter);
    const first = await service.export(request);
    const replay = await new PostgresGoogleDocsExportService(
      pool!,
      new MockGoogleDocsAdapter(),
    ).export(request);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()).export({
        ...request,
        idempotency_key: "tampered",
        rendered: { ...rendered, markdown: `${rendered.markdown}x` },
      }),
    ).rejects.toThrow("hash");
    const unrelatedMarkdown = `${rendered.markdown}\nUnrelated but self-consistent content.`;
    await expect(
      new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()).export({
        ...request,
        idempotency_key: "unrelated",
        rendered: {
          ...rendered,
          markdown: unrelatedMarkdown,
          content_hash: createHash("sha256").update(unrelatedMarkdown).digest("hex"),
        },
      }),
    ).rejects.toThrow("immutable inputs");
    const lineage = await pool!.query(
      "select a.parent_id artifact_parent,d.parent_id document_parent from document_versions d join artifacts a on a.id=d.artifact_id where d.id=$1",
      [saved.version.id],
    );
    expect(lineage.rows[0]).toEqual({ artifact_parent: null, document_parent: null });
    expect(
      (
        await pool!.query(
          "select count(*)::int count from exports where idempotency_key='export-key'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    const hashes = await pool!.query<{ valid: boolean }>(
      `select content_hash=encode(digest(convert_to(body_text,'UTF8'),'sha256'),'hex') valid
       from artifacts where run_id=$1 and kind in ('draft','google_docs_export') order by kind`,
      [run.run_id],
    );
    expect(hashes.rows.every((row) => row.valid)).toBe(true);
    expect(
      (
        await pool!.query<{ valid: boolean }>(
          `select content_hash=encode(digest(convert_to(body_text,'UTF8'),'sha256'),'hex') valid
           from artifacts where run_id=$1 and kind='internal_links'`,
          [run.run_id],
        )
      ).rows[0]?.valid,
    ).toBe(true);
    await expect(
      pool!.query("update exports set status='failed' where idempotency_key='export-key'"),
    ).rejects.toThrow("append-only");
    await expect(
      pool!.query("delete from exports where idempotency_key='export-key'"),
    ).rejects.toThrow("append-only");
  });

  it("canonicalises concurrent export keys to one provider call", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "concurrent-export", repository);
    const links = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
    await repository.saveLinks(run.run_id, links.execution_id, links.token, []);
    await repository.completeStep(links.execution_id, links.token);
    const draftLease = await repository.claimStep(run.run_id, "draft", "worker");
    const provider = new MockDraftProvider("mock-v1");
    const saved = await repository.saveDraft(
      run.run_id,
      draftLease.execution_id,
      draftLease.token,
      await provider.generate({ handoff, internal_links: [], model: provider.model }),
      provider.provider,
      provider.model,
    );
    await repository.completeStep(draftLease.execution_id, draftLease.token);
    const finalLease = await repository.claimStep(run.run_id, "final_coherence_export", "worker");
    await seedPassingFinalGate(
      run.run_id,
      saved.version.id,
      saved.artifact.id,
      finalLease.execution_id,
    );
    const renderInput = {
      plane_ticket: handoff.plane_ticket,
      draft: saved.draft,
      writer_template: DEFAULT_WRITER_TEMPLATE,
      schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
    };
    const rendered = renderExport(renderInput);
    const delegate = new MockGoogleDocsAdapter();
    let calls = 0;
    const adapter = {
      export: async (key: string, value: typeof rendered) => {
        calls += 1;
        return delegate.export(key, value);
      },
    };
    const service = new PostgresGoogleDocsExportService(pool!, adapter);
    const base = {
      run_id: run.run_id,
      step_execution_id: finalLease.execution_id,
      fencing_token: finalLease.token,
      document_version_id: saved.version.id,
      render_input: renderInput,
      rendered,
    };
    const results = await Promise.all([
      service.export({ ...base, idempotency_key: "concurrent-a" }),
      service.export({ ...base, idempotency_key: "concurrent-b" }),
    ]);
    expect(calls).toBe(1);
    expect(results[1]!.external_document_id).toBe(results[0]!.external_document_id);
  });

  it("surfaces legacy draft placeholders through the run-detail read path", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "legacy-read", repository);
    const links = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
    await repository.saveLinks(run.run_id, links.execution_id, links.token, []);
    await repository.completeStep(links.execution_id, links.token);
    const lease = await repository.claimStep(run.run_id, "draft", "worker");
    const provider = new MockDraftProvider("mock-v1");
    const saved = await repository.saveDraft(
      run.run_id,
      lease.execution_id,
      lease.token,
      await provider.generate({ handoff, internal_links: [], model: provider.model }),
      provider.provider,
      provider.model,
    );
    await repository.completeStep(lease.execution_id, lease.token);

    const currentDetail = await repository.getRunDetail(run.run_id);
    expect(currentDetail.current_document?.legacy_derived_fields ?? []).toEqual([]);

    // Historical bytes: a newer version whose artifact was written before draft-owned
    // on-page fields existed (artifacts are append-only, so insert fresh immutable rows).
    const legacyBody = JSON.stringify({
      title: saved.draft.title,
      slug: saved.draft.slug,
      meta_description: saved.draft.meta_description,
      markdown: saved.draft.markdown,
      claims: saved.draft.claims,
    });
    const legacyArtifact = (
      await pool!.query<{ id: string }>(
        `insert into artifacts(id,run_id,step_execution_id,parent_id,kind,media_type,body_text,content_hash,size_bytes)
         values(gen_random_uuid(),$1,$2,$3,'draft','application/json',$4,$5,$6) returning id`,
        [
          run.run_id,
          lease.execution_id,
          saved.artifact.id,
          legacyBody,
          createHash("sha256").update(legacyBody).digest("hex"),
          Buffer.byteLength(legacyBody),
        ],
      )
    ).rows[0]!.id;
    await pool!.query(
      "insert into document_versions(run_id,artifact_id,revision,content_hash) values($1,$2,2,$3)",
      [run.run_id, legacyArtifact, createHash("sha256").update(legacyBody).digest("hex")],
    );
    const legacyDetail = await repository.getRunDetail(run.run_id);
    expect(legacyDetail.current_document?.legacy_derived_fields).toEqual([
      // meta_title is a distinct stored field now, so legacy bytes derive it too.
      "meta_title",
      "og_title",
      "og_description",
      "images",
      "faqs",
    ]);
    expect(legacyDetail.current_document?.draft.og_title).toBe("Legacy draft field unavailable");

    const intermediateBody = JSON.stringify({
      title: saved.draft.title,
      slug: saved.draft.slug,
      meta_description: saved.draft.meta_description,
      og_title: saved.draft.og_title,
      og_description: saved.draft.og_description,
      images: saved.draft.images.map(({ alt, filename }) => ({ alt, filename })),
      faqs: saved.draft.faqs,
      markdown: saved.draft.markdown,
      claims: saved.draft.claims,
    });
    const intermediateArtifact = (
      await pool!.query<{ id: string }>(
        `insert into artifacts(id,run_id,step_execution_id,parent_id,kind,media_type,body_text,content_hash,size_bytes)
         values(gen_random_uuid(),$1,$2,$3,'draft','application/json',$4,$5,$6) returning id`,
        [
          run.run_id,
          lease.execution_id,
          legacyArtifact,
          intermediateBody,
          createHash("sha256").update(intermediateBody).digest("hex"),
          Buffer.byteLength(intermediateBody),
        ],
      )
    ).rows[0]!.id;
    await pool!.query(
      "insert into document_versions(run_id,artifact_id,revision,content_hash) values($1,$2,3,$3)",
      [
        run.run_id,
        intermediateArtifact,
        createHash("sha256").update(intermediateBody).digest("hex"),
      ],
    );
    const intermediateDetail = await repository.getRunDetail(run.run_id);
    expect(intermediateDetail.current_document?.legacy_derived_fields).toEqual([
      "meta_title",
      "images",
    ]);
    expect(intermediateDetail.current_document?.draft).toMatchObject({
      og_title: saved.draft.og_title,
      og_description: saved.draft.og_description,
      faqs: saved.draft.faqs,
      images: [],
    });
  });
});

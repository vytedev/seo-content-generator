import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture } from "../src/shared/milestone-three.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { PostgresMilestoneRepository } from "../src/server/persistence/postgres-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import {
  MockReviewProvider,
  type ReviewProvider,
} from "../src/server/providers/review-provider.js";
import { ConflictError } from "../src/shared/errors.js";
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
    // The run is resting, waiting for an explicit resume trigger into
    // milestone four — the operator must see a way to continue, not a dead end.
    expect((await repository.getRunDetail(run.run_id)).can_retry).toBe(true);
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

  it("persists and freezes Step 1.6 advisory-unavailable for operator disposition", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-pg-value-fallback", repository);
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
        return request.step === "review_information_gain"
          ? {
              ...response,
              findings: [
                {
                  stable_key: "value-advisory-unavailable",
                  category: "information_gain_advisory_unavailable",
                  rule_reference: "value.advisory_unavailable",
                  severity: "warning",
                  location: {
                    field: "body_markdown",
                    line_start: 1,
                    line_end: 1,
                    section: "Designer chair",
                  },
                  issue:
                    "The optional information-gain advisory was unavailable because its response was unusable.",
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

  it("reconciles a deterministic output boundary to its producing attempt", async () => {
    const repository = new PostgresMilestoneRepository(pool!);
    const run = await ingestHandoff(handoff, "m3-deterministic-retry", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    let fired = false;
    await expect(
      new MilestoneThreeOrchestrator(repository, fixture, new MockReviewProvider("review-v1"), {
        hit: (boundary) => {
          if (!fired && boundary === "after_deterministic_persist") {
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
    const output = await pool!.query(
      `select e.status from step_outputs o join step_executions e on e.id=o.step_execution_id
       where o.run_id=$1 and o.step='automated_checks'`,
      [run.run_id],
    );
    expect(output.rows).toEqual([{ status: "succeeded" }]);
  });
});

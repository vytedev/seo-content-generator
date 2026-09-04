import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFERENCE_DOCUMENT_SEED_MANIFEST,
  generateReferenceSeedSql,
} from "../src/db/reference-seed.js";
import { PostgresGoogleDocsExportService } from "../src/server/export-service.js";
import { MilestoneFourOrchestrator } from "../src/server/milestone-four-orchestrator.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { PostgresMilestoneRepository } from "../src/server/persistence/postgres-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockGoogleDocsAdapter } from "../src/server/providers/google-docs.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../src/server/providers/milestone-four-providers.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import {
  ChatCompletionRevisionProvider,
  RevisionProviderError,
} from "../src/server/providers/chat-completion-revision-provider.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture, ReviewFinding } from "../src/shared/milestone-three.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
const words = (count: number) => Array.from({ length: count }, () => "plain").join(" ");
const link = { url: "https://www.mobelaris.com/en/chair", title: "Chair", relevance: 1 };
const fixture: DeterministicFixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [{ url: link.url, status: 200, hierarchy: "product", hierarchy_rank: 4 }],
};
const draft = {
  title: "Designer chair guide".padEnd(55, "x"),
  slug: "designer-chair-guide",
  meta_description: "Designer chair guidance".padEnd(150, "x"),
  og_title: "Designer chair",
  og_description: "Designer chair guidance",
  images: [{ alt: "Chair", filename: "chair.jpg", placement: { marker: "chair" } }],
  faqs: [1, 2, 3].map((n) => ({ question: `Question ${n}`, answer: words(40) })),
  markdown: [
    "# Designer chair guide",
    "<!-- MOBELARIS_IMAGE:chair -->",
    `Designer chair ${words(38)}`,
    "## Key Takeaways",
    "- Fit matters",
    "- Comfort matters",
    "- Scale matters",
    "## How a designer chair fits",
    `Modern seating works with a [chair](${link.url}) in a measured room.`,
    "> Measure first.",
    "## Conclusion",
    "Choose a designer chair that fits the room and its use.",
  ].join("\n\n"),
  claims: [
    {
      text: "Designed by Example Studio",
      type: "provenance" as const,
      status: "unverified" as const,
    },
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};
const handoff = {
  plane_ticket: "MOB-M4-PG",
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
/**
 * A deterministic blocker no correction route can resolve: a meta description
 * below the deterministic shortening band, which the allowlisted planner
 * refuses and which never reaches the model. It reaches the two-cycle cap the
 * way a genuinely unrepairable article does, rather than through an introduced
 * blocker that the Step 1.10 candidate preflight now reverts.
 */
const UNREPAIRABLE_META = "A".repeat(120);
/** Deliberately high Flesch-Kincaid prose, so the frozen readability rule blocks. */
const COMPLEX_PROSE =
  "Consequently the extraordinarily sophisticated manufacturing methodology demonstrates considerable environmental responsibility whenever comparatively substantial quantities of internationally certified hardwood materials are systematically incorporated throughout the entire production infrastructure.";
const STILL_COMPLEX_PROSE =
  "Additionally the remarkably complicated manufacturing methodology demonstrates extraordinary environmental accountability whenever proportionally significant quantities of internationally accredited hardwood materials are meticulously integrated throughout the complete production infrastructure.";

const blocker: ReviewFinding = {
  stable_key: "conflict",
  category: "inconsistency",
  rule_reference: "coherence.inconsistency",
  severity: "blocker",
  location: { field: "body_markdown", line_start: 17 },
  issue: "Conflict remains.",
  suggested_fix: "Resolve it.",
};

async function seedReferences() {
  await pool!.query(generateReferenceSeedSql());
  for (const item of REFERENCE_DOCUMENT_SEED_MANIFEST) {
    const body = `# ${item.title}\n\nIntegration fixture.`;
    const hash = createHash("sha256").update(body).digest("hex");
    await pool!.query(
      `with d as (select id from reference_documents where kind=$1) insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes) select id,1,$2,$3,$4 from d on conflict(reference_document_id,version) do nothing`,
      [item.kind, body, hash, Buffer.byteLength(body)],
    );
    await pool!.query(
      `insert into reference_approval_attestations(reference_version_id,recorder_identity,approver_identity,evidence_reference,authority_state) select v.id,'local-test-recorder','local-test-approver','local-test-evidence','pending_unverified' from reference_versions v join reference_documents d on d.id=v.reference_document_id where d.kind=$1 on conflict (reference_version_id) do nothing`,
      [item.kind],
    );
    await pool!.query(
      `insert into reference_attestation_verifications(attestation_id,verifier_identity,evidence_reference,authority_state) select a.id,'local-test-verifier','local-test-evidence','trusted_verified' from reference_approval_attestations a join reference_versions v on v.id=a.reference_version_id join reference_documents d on d.id=v.reference_document_id where d.kind=$1 on conflict (attestation_id) do nothing`,
      [item.kind],
    );
    await pool!.query(
      `insert into reference_activations(reference_document_id,reference_version_id) select d.id,v.id from reference_documents d join reference_versions v on v.reference_document_id=d.id and v.version=1 where d.kind=$1 on conflict(reference_document_id) do update set reference_version_id=excluded.reference_version_id`,
      [item.kind],
    );
  }
}

async function setup(key: string, seedDraft: typeof draft = draft) {
  const repository = new PostgresMilestoneRepository(pool!, 2_000, {
    writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
    schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
    allow_local_pending: true,
  });
  const run = await ingestHandoff(handoff, key, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([link]),
    // Seeding through the draft provider keeps the Step 1.4 frozen manifest,
    // the artefact body and its content hash consistent with each other.
    new MockDraftProvider("draft-v1", seedDraft),
  ).run(run.run_id);
  await new MilestoneThreeOrchestrator(
    repository,
    fixture,
    new MockReviewProvider("review-v1"),
  ).run(run.run_id);
  const findings = await repository.listFindings(run.run_id, {});
  await repository.submitDispositions(run.run_id, {
    document_version_id: (await repository.getDraft(run.run_id))!.version.id,
    idempotency_key: "test-disposition-postgres-milestone-four.integration.test-0",
    dispositions: findings.map((finding, index) => ({
      finding_id: finding.id,
      decision: index === 0 ? ("rejected" as const) : ("accepted" as const),
    })),
  });
  return { repository, run, findings };
}
function orchestrator(
  repository: PostgresMilestoneRepository,
  coherence = new MockCoherenceProvider("coherence-v1"),
  failure?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5],
  selectedFixture = fixture,
  revision: ConstructorParameters<typeof MilestoneFourOrchestrator>[2] = new MockRevisionProvider(
    "revision-v1",
  ),
  exports: ConstructorParameters<
    typeof MilestoneFourOrchestrator
  >[4] = new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()),
) {
  return new MilestoneFourOrchestrator(
    repository,
    selectedFixture,
    revision,
    coherence,
    exports,
    failure,
  );
}

integration("PostgreSQL milestone four", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
    await seedReferences();
  });
  afterAll(async () => pool?.end());

  it("fences identical Step 1.11 replay while preserving active observational idempotency", async () => {
    const { repository, run } = await setup("m4-pg-rerun-replay-fence");
    const originalSaveRerun = repository.saveRerun.bind(repository);
    let persistedInput: Parameters<typeof repository.saveRerun>[0] | undefined;
    repository.saveRerun = async (input) => {
      persistedInput = structuredClone(input);
      return originalSaveRerun(input);
    };
    await orchestrator(repository).run(run.run_id);

    const stale = persistedInput!;
    await expect(originalSaveRerun(stale)).rejects.toThrow(/Stale|expired|fencing/i);

    const replay = await repository.claimStep(
      run.run_id,
      "automated_checks_rerun",
      "active-replay",
      true,
    );
    await expect(
      originalSaveRerun({ ...stale, execution_id: replay.execution_id, token: replay.token }),
    ).resolves.toBe("continue");
    const count = await pool!.query<{ count: number }>(
      "select count(*)::int count from deterministic_reruns where run_id=$1",
      [run.run_id],
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  it("preserves dispositions, revision/claim/source lineage and consistent final execution/export replay", async () => {
    const { repository, run, findings } = await setup("m4-pg-success");
    await orchestrator(repository).run(run.run_id);
    const current = (await repository.getDraft(run.run_id))!;
    expect(current.artifact.kind).toBe("draft_revision");
    expect(current.artifact.content_hash).toBe(current.version.content_hash);
    const lineage = (
      await pool!.query(
        `select d.revision,d.parent_id,a.parent_id artifact_parent,(select count(*)::int from claims c where c.document_version_id=d.id) claims,(select count(*)::int from claim_sources cs join claims c on c.id=cs.claim_id where c.document_version_id=d.id) sources from document_versions d join artifacts a on a.id=d.artifact_id where d.run_id=$1 order by revision`,
        [run.run_id],
      )
    ).rows;
    // The fact inventory now covers every FAQ answer as a whole assertion, so
    // the fixture's three FAQ answers plus its two structured claims persist
    // five claims (and their per-claim unresolved sources) into each revision.
    expect(lineage[1]).toMatchObject({ revision: 2, claims: 5, sources: 5 });
    expect(lineage[1].parent_id).toBeTruthy();
    expect(lineage[1].artifact_parent).toBeTruthy();
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "succeeded",
      counts: { unverified: 5, hard_flags: 1, rejected_findings: 1 },
    });
    expect(findings.length).toBeGreaterThan(0);
    const final = (
      await pool!.query(
        `select e.status,x.status export_status,x.step_execution_id=e.id consistent from step_executions e join exports x on x.step_execution_id=e.id where e.run_id=$1 and e.step='final_coherence_export'`,
        [run.run_id],
      )
    ).rows;
    expect(final).toContainEqual({
      status: "succeeded",
      export_status: "succeeded",
      consistent: true,
    });
    await orchestrator(repository).run(run.run_id);
    expect(
      (await pool!.query("select count(*)::int count from exports where run_id=$1", [run.run_id]))
        .rows[0].count,
    ).toBe(1);
  });

  it("selects the configured persisted template version and does not follow later activation-like rows", async () => {
    const repository = new PostgresMilestoneRepository(pool!, 2_000, {
      writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
      schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
      allow_local_pending: true,
    });
    const before = await repository.getContentTemplates();
    const body = { section_order: ["Changed"], required_metadata: [] };
    await pool!.query(
      `insert into content_templates(template_id,version,kind,status,body,content_hash)
       values('mobelaris.writer-submission','2.0.0','writer_submission','approved',$1::jsonb,$2)`,
      [JSON.stringify(body), createHash("sha256").update(JSON.stringify(body)).digest("hex")],
    );
    const after = await repository.getContentTemplates();
    expect(after.writer_template).toEqual(before.writer_template);
    expect(after.writer_template.version).toBe("1.0.0");
  });

  it("durably blocks after two Step 1.11 repair cycles and ignores the current fixture", async () => {
    const { repository, run } = await setup("m4-pg-deterministic-block", {
      ...draft,
      meta_description: UNREPAIRABLE_META,
    });
    const coherence = new MockCoherenceProvider("coherence-v1");
    await orchestrator(
      repository,
      coherence,
      undefined,
      { ...fixture, link_verification: [] },
      new MockRevisionProvider("revision-v1"),
    ).run(run.run_id);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "blocked",
      current_step: "automated_checks_rerun",
      deterministic_repair_cycles: 2,
      blocked_for_operator: true,
      block_reason: "deterministic_blockers",
      block_counts: { deterministic_blockers: 1, coherence_blockers: 0 },
    });
    expect(
      (await pool!.query("select block_reason from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({ block_reason: "deterministic_blockers" });
    expect(
      (
        await pool!.query(
          "select revision_source from document_versions where run_id=$1 order by revision",
          [run.run_id],
        )
      ).rows.map((row) => row.revision_source),
    ).toEqual([null, "operator_findings", "deterministic_repair", "deterministic_repair"]);
    const blockedContext = await repository.getCoherenceRevisionContext(
      run.run_id,
      (await repository.getDraft(run.run_id))!.version.id,
    );
    expect(blockedContext.revision_reason).toBe("deterministic_repair");
    // Persisted reason remains authoritative even when separately calculated evidence is ambiguous.
    const blockedDocument = (await repository.getDraft(run.run_id))!.version.id;
    const finalExecution = (
      await pool!.query<{ id: string }>(
        "insert into step_executions(run_id,step,attempt,status) values($1,'final_coherence_export',1,'blocked') returning id",
        [run.run_id],
      )
    ).rows[0]!.id;
    await pool!.query(
      `insert into findings(run_id,document_version_id,step_execution_id,stable_key,category,
       rule_reference,severity,location,issue,suggested_fix,hard_flag)
       values($1,$2,$3,'ambiguous-extra-coherence','inconsistency','coherence.inconsistency',
       'blocker',$4::jsonb,'Historical ambiguity.','Review it.',false)`,
      [run.run_id, blockedDocument, finalExecution, JSON.stringify(blocker.location)],
    );
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      block_reason: "deterministic_blockers",
      block_counts: { deterministic_blockers: 1, coherence_blockers: 1 },
    });
    expect(coherence.calls).toHaveLength(0);
    expect(
      (await pool!.query("select count(*)::int count from exports where run_id=$1", [run.run_id]))
        .rows[0].count,
    ).toBe(0);

    // Recovery is authorised by the latest document's persisted Step 1.11 row and
    // the blocker tied to that exact producing execution, never by Step 1.9 findings.
    await pool!.query("update runs set deterministic_repair_cycles=0 where id=$1", [run.run_id]);
    const recoveryInput = await repository.getRevisionFindings(run.run_id, blockedDocument);
    expect(recoveryInput).toMatchObject({
      source: "deterministic_repair",
      findings: [
        {
          rule_reference: "on_page.meta_description.length",
          severity: "blocker",
          origin_document_version_id: blockedDocument,
        },
      ],
    });
    await expect(repository.recoverDeterministicBlock(run.run_id)).resolves.toBe(true);
  });

  it("binds exceptional repair to the exact latest Step 1.11 blockers and never coherence or Step 1.9", async () => {
    // Readability is locationless, so it exercises the application-owned
    // binding, and it is bounded-paragraph repairable, so an authorisation is
    // genuinely useful rather than spent on a blocker nothing can resolve.
    const { repository, run } = await setup("m4-pg-exceptional-repair", {
      ...draft,
      markdown: draft.markdown.replace("> Measure first.", `${COMPLEX_PROSE}\n\n> Measure first.`),
    });
    const ineffective = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(COMPLEX_PROSE, STILL_COMPLEX_PROSE),
    }));
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      ineffective,
    ).run(run.run_id);
    const blocked = (await repository.getDraft(run.run_id))!;
    const blockedMarkdown = blocked.draft.markdown;
    const key = `exceptional:${run.run_id}:postgres`;
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).resolves.toBe("authorised");
    const input = await repository.getRevisionFindings(run.run_id, blocked.version.id);
    expect(input.source).toBe("operator_authorised_repair");
    expect(input.findings).toHaveLength(1);
    expect(input.findings[0]).toMatchObject({
      rule_reference: "style.readability_grade_8",
      origin_document_version_id: blocked.version.id,
    });
    // The persisted binding must be one exact block range, never the whole field.
    expect(input.findings[0]!.location.line_start).toBeGreaterThan(0);
    expect(input.findings[0]!.location.line_end).toBeGreaterThanOrEqual(
      input.findings[0]!.location.line_start!,
    );
    const binding = (
      await pool!.query(
        `select deterministic_rerun_step_execution_id,blocker_set_hash,blocker_bindings
         from exceptional_correction_authorisations where run_id=$1`,
        [run.run_id],
      )
    ).rows[0];
    expect(binding.blocker_set_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.blocker_bindings).toHaveLength(1);

    const recovery = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(COMPLEX_PROSE, STILL_COMPLEX_PROSE),
    }));
    await orchestrator(repository, undefined, undefined, fixture, recovery).run(run.run_id);
    // Exactly one bounded exceptional model request, and the candidate preflight
    // still refuses to persist prose that leaves the frozen grade above 8.
    expect(recovery.calls).toHaveLength(1);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toBe(blockedMarkdown);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("blocked");
    expect(
      (await pool!.query("select count(*)::int count from exports where run_id=$1", [run.run_id]))
        .rows[0].count,
    ).toBe(0);
    // Same-key replay must be purely observational: it may not reopen the
    // blocked child, mint a document version, start a revision operation, pay
    // for another provider call, or extend the one-time correction. This is the
    // exact behaviour the in-memory repository already had.
    const snapshot = async () => ({
      run: (
        await pool!.query(
          "select status,current_step,block_reason,deterministic_repair_cycles from runs where id=$1",
          [run.run_id],
        )
      ).rows[0],
      documents: (
        await pool!.query("select count(*)::int c from document_versions where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].c,
      currentVersion: (await repository.getDraft(run.run_id))!.version.id,
      operations: (
        await pool!.query("select count(*)::int c from revision_operation_states where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].c,
      authorisations: (
        await pool!.query(
          "select count(*)::int c from exceptional_correction_authorisations where run_id=$1",
          [run.run_id],
        )
      ).rows[0].c,
    });
    const before = await snapshot();
    const callsBefore = recovery.calls.length;
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).resolves.toBe("replay");
    expect(await snapshot()).toEqual(before);
    expect(recovery.calls).toHaveLength(callsBefore);
    expect(before.run.status).toBe("blocked");
    // No second exceptional action, and no further revision operation can start.
    const detail = await repository.getRunDetail(run.run_id);
    expect(detail.exceptional_correction.available).toBe(false);
    await orchestrator(repository, undefined, undefined, fixture, recovery)
      .run(run.run_id)
      .catch(() => undefined);
    expect(await snapshot()).toEqual(before);
    expect(recovery.calls).toHaveLength(callsBefore);

    // A DIFFERENT key on an already-authorised run is a conflict, never a
    // replay, and mutates nothing.
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: `${key}:other`,
        explicit_confirmation: true,
      }),
    ).rejects.toThrow(/already has an exceptional authorisation/i);
    expect(await snapshot()).toEqual(before);

    // The SAME key owned by another run is a key conflict, and mutates nothing.
    // Key ownership is checked before any run lookup, so an unrelated run id is
    // enough and avoids disturbing this suite's shared fixtures.
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: "00000000-0000-0000-0000-0000000000ff",
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).rejects.toThrow(/Authorisation key conflict/i);
    expect(await snapshot()).toEqual(before);
  });

  it("fails closed on an ambiguous coherence return instead of paying twice", async () => {
    const { repository, run } = await setup("m4-pg-coherence-ambiguous");
    const coherence = new MockCoherenceProvider("coherence-v1");
    let crash = true;
    await expect(
      orchestrator(repository, coherence, {
        hit(boundary) {
          if (crash && boundary === "after_coherence_provider_return") {
            crash = false;
            throw new Error("crash after the coherence provider returned");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence provider returned");
    expect(coherence.calls).toHaveLength(1);
    expect(
      (
        await pool!.query<{ status: string }>(
          "select status from coherence_checkpoints where run_id=$1",
          [run.run_id],
        )
      ).rows[0]?.status,
    ).toBe("provider_in_flight");

    await expect(orchestrator(repository, coherence).run(run.run_id)).rejects.toThrow(/ambiguous/i);
    expect(coherence.calls).toHaveLength(1);
    expect(
      (await pool!.query("select count(*)::int c from exports where run_id=$1", [run.run_id]))
        .rows[0].c,
    ).toBe(0);
  });

  it("replays a checkpointed coherence response without another provider call", async () => {
    const { repository, run } = await setup("m4-pg-coherence-replay");
    const coherence = new MockCoherenceProvider("coherence-v1");
    let crash = true;
    await expect(
      orchestrator(repository, coherence, {
        hit(boundary) {
          if (crash && boundary === "after_coherence_provider") {
            crash = false;
            throw new Error("crash after the coherence checkpoint");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence checkpoint");
    expect(coherence.calls).toHaveLength(1);
    expect(
      (
        await pool!.query<{ status: string }>(
          "select status from coherence_checkpoints where run_id=$1",
          [run.run_id],
        )
      ).rows[0]?.status,
    ).toBe("checkpointed");

    await orchestrator(repository, coherence).run(run.run_id);
    expect(coherence.calls).toHaveLength(1);
    expect(
      (await pool!.query("select count(*)::int c from exports where run_id=$1", [run.run_id]))
        .rows[0].c,
    ).toBe(1);
    expect(
      (
        await pool!.query(
          "select count(*)::int c from coherence_recoveries where run_id=$1 and outcome='export'",
          [run.run_id],
        )
      ).rows[0].c,
    ).toBe(1);
    const lineage = (
      await pool!.query<{ coherence: Record<string, unknown> }>(
        "select manifest->'exact_lineage'->'coherence' coherence from export_manifests where run_id=$1",
        [run.run_id],
      )
    ).rows[0]!.coherence;
    expect(lineage.request).toBeTruthy();
    expect(lineage.producing_step_execution_id).toBeTruthy();
    expect(lineage.persistence_step_execution_id).toBeTruthy();
    expect(lineage.recovery_step_execution_ids).toHaveLength(1);
  });

  it("anchors chained coherence recovery to the immutable checkpoint producer", async () => {
    const { repository, run } = await setup("m4-pg-coherence-chained-replay");
    const coherence = new MockCoherenceProvider("coherence-v1");
    let checkpointCrash = true;
    await expect(
      orchestrator(repository, coherence, {
        hit(boundary) {
          if (checkpointCrash && boundary === "after_coherence_provider") {
            checkpointCrash = false;
            throw new Error("crash after the coherence checkpoint");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence checkpoint");

    let persistenceCrash = true;
    await expect(
      orchestrator(repository, coherence, {
        hit(boundary) {
          if (persistenceCrash && boundary === "after_coherence_persist") {
            persistenceCrash = false;
            throw new Error("crash after coherence persistence");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after coherence persistence");

    await orchestrator(repository, coherence).run(run.run_id);
    expect(coherence.calls).toHaveLength(1);
    expect(
      (await pool!.query("select count(*)::int c from exports where run_id=$1", [run.run_id]))
        .rows[0].c,
    ).toBe(1);
    const lineage = (
      await pool!.query<{
        checkpoint_producer: string;
        recovery_producers: string[];
        recoveries: number;
      }>(
        `select c.producing_step_execution_id checkpoint_producer,
          array_agg(r.producing_step_execution_id order by r.created_at) recovery_producers,
          count(r.*)::int recoveries
         from coherence_checkpoints c join coherence_recoveries r on r.operation_id=c.operation_id
         where c.run_id=$1 group by c.producing_step_execution_id`,
        [run.run_id],
      )
    ).rows[0]!;
    expect(lineage.recoveries).toBe(2);
    expect(lineage.recovery_producers).toEqual([
      lineage.checkpoint_producer,
      lineage.checkpoint_producer,
    ]);
    const manifestLineage = (
      await pool!.query<{ coherence: Record<string, unknown> }>(
        "select manifest->'exact_lineage'->'coherence' coherence from export_manifests where run_id=$1",
        [run.run_id],
      )
    ).rows[0]!.coherence;
    expect(manifestLineage.request).toBeTruthy();
    expect(manifestLineage.producing_step_execution_id).toBe(lineage.checkpoint_producer);
    expect(manifestLineage.persistence_step_execution_id).toBeTruthy();
    expect(manifestLineage.recovery_step_execution_ids).toHaveLength(2);
  });

  it("routes an eligible coherence blocker through one controlled recovery cycle", async () => {
    const { repository, run } = await setup("m4-pg-cycles");
    const changedRevision = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(
        /Modern seating works with a \[chair\]\([^)]+\) in a measured room(?: for revision \d+)?\./,
        `Modern seating works with a [chair](${link.url}) in a measured room for revision ${request.revision}.`,
      ),
    }));
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1", [[blocker], []]),
      undefined,
      fixture,
      changedRevision,
    ).run(run.run_id);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "succeeded",
      coherence_return_cycles: 1,
    });
    expect(
      (
        await pool!.query("select count(*)::int count from document_versions where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].count,
    ).toBe(3);
  });

  it("reports the coherence cap only when saved coherence blockers remain after two cycles", async () => {
    const { repository, run } = await setup("m4-pg-cycle-cap");
    await orchestrator(repository).run(run.run_id);
    const final = (
      await pool!.query<{ document_version_id: string; step_execution_id: string }>(
        `select d.id document_version_id,e.id step_execution_id from document_versions d
         join step_executions e on e.run_id=d.run_id and e.step='final_coherence_export'
         where d.run_id=$1 order by d.revision desc,e.attempt desc limit 1`,
        [run.run_id],
      )
    ).rows[0]!;
    await pool!.query(
      `insert into findings(run_id,document_version_id,step_execution_id,stable_key,category,
         rule_reference,severity,location,issue,suggested_fix,hard_flag)
       values($1,$2,$3,'historical-coherence-cap','inconsistency','coherence.inconsistency',
         'blocker',$4::jsonb,'Conflict remains.','Resolve it.',false)`,
      [
        run.run_id,
        final.document_version_id,
        final.step_execution_id,
        JSON.stringify(blocker.location),
      ],
    );
    await pool!.query("update step_executions set status='blocked',completed_at=null where id=$1", [
      final.step_execution_id,
    ]);
    await pool!.query(
      "update runs set status='blocked',coherence_return_cycles=2,block_reason='coherence_cycle_cap' where id=$1",
      [run.run_id],
    );

    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "blocked",
      coherence_return_cycles: 2,
      blocked_for_operator: true,
      block_reason: "coherence_cycle_cap",
      block_counts: { deterministic_blockers: 0, coherence_blockers: 1 },
    });
  });

  it("maps a historical blocked row with a null reason to unknown without inferring from counts", async () => {
    const { repository, run } = await setup("m4-pg-legacy-null-reason");
    await orchestrator(repository).run(run.run_id);
    const current = (await repository.getDraft(run.run_id))!;
    const finalExecution = (
      await pool!.query<{ id: string }>(
        "select id from step_executions where run_id=$1 and step='final_coherence_export' order by attempt desc limit 1",
        [run.run_id],
      )
    ).rows[0]!.id;
    await pool!.query(
      `insert into findings(run_id,document_version_id,step_execution_id,stable_key,category,
       rule_reference,severity,location,issue,suggested_fix,hard_flag)
       values($1,$2,$3,'legacy-coherence-evidence','inconsistency','coherence.inconsistency',
       'blocker',$4::jsonb,'Legacy blocker.','Review it.',false)`,
      [run.run_id, current.version.id, finalExecution, JSON.stringify(blocker.location)],
    );
    await pool!.query(
      "update runs set status='blocked',coherence_return_cycles=2,block_reason=null where id=$1",
      [run.run_id],
    );

    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "blocked",
      blocked_for_operator: true,
      block_reason: "unknown",
      block_counts: { deterministic_blockers: 0, coherence_blockers: 1 },
    });
  });

  it("persists an HTTP 200 safe fallback once, records all subjective findings unable and advances Step 1.11", async () => {
    const { repository, run } = await setup("m4-pg-http-200-fallback");
    let calls = 0;
    const fallback = {
      provider: "openrouter",
      model: "compact-v2",
      async revise(request: Parameters<MockRevisionProvider["revise"]>[0]) {
        calls += 1;
        return {
          document: request.current_document,
          finding_results: request.accepted_findings.map((finding) => ({
            finding_id: finding.id,
            status: "unable" as const,
            reason: "The model response could not be used safely.",
          })),
          usage: { input_units: 20, output_units: 3, cost_micros: 1 },
        };
      },
    };
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      fallback,
    ).run(run.run_id);
    const current = (await repository.getDraft(run.run_id))!;
    expect(calls).toBe(1);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
    expect(
      await repository.hasStepOutput(run.run_id, current.version.id, "automated_checks_rerun"),
    ).toBe(true);
    const audits = (
      await pool!.query(
        "select status,reason from revision_finding_audits where run_id=$1 order by ordinal",
        [run.run_id],
      )
    ).rows;
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((row) => row.status === "unable")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("unsafe upstream");
    expect(
      (
        await pool!.query(
          "select count(*)::int count from revision_provider_failures where run_id=$1",
          [run.run_id],
        )
      ).rows[0].count,
    ).toBe(0);
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      fallback,
    ).run(run.run_id);
    expect(calls).toBe(1);
  });

  it("preserves a failed HF operation while a new OpenRouter/model operation checkpoints and resumes once", async () => {
    const { repository, run } = await setup("m4-pg-revision-config-switch");
    let hfCalls = 0;
    const huggingFace = {
      provider: "huggingface",
      model: "hf-revision-v1",
      async revise() {
        hfCalls += 1;
        throw new RevisionProviderError(
          "REVISION_PROVIDER_CONFIGURATION",
          "Revision provider configuration is invalid",
          "configuration",
        );
      },
    };
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        huggingFace,
      ).run(run.run_id),
    ).rejects.toThrow("configuration is invalid");

    const failed = (
      await pool!.query(
        "select operation_id,provider,model,failure_category from revision_provider_failures where run_id=$1",
        [run.run_id],
      )
    ).rows[0];
    const delegate = new MockRevisionProvider("openrouter-revision-v2");
    const openRouter = {
      provider: "openrouter",
      model: "openrouter-revision-v2",
      revise: delegate.revise.bind(delegate),
    };
    let crashOnce = true;
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        {
          hit(boundary) {
            if (crashOnce && boundary === "after_revision_provider") {
              crashOnce = false;
              throw new Error("checkpoint recovery probe");
            }
          },
        },
        fixture,
        openRouter,
      ).run(run.run_id),
    ).rejects.toThrow("checkpoint recovery probe");

    expect(delegate.calls).toHaveLength(1);
    expect(delegate.calls[0]!.operation_id).not.toBe(failed.operation_id);
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      openRouter,
    ).run(run.run_id);
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      openRouter,
    ).run(run.run_id);

    expect(hfCalls).toBe(1);
    expect(delegate.calls).toHaveLength(1);
    expect(failed).toMatchObject({
      provider: "huggingface",
      model: "hf-revision-v1",
      failure_category: "configuration",
    });
    const states = (
      await pool!.query(
        "select operation_id,status,response_hash from revision_operation_states where run_id=$1 order by created_at",
        [run.run_id],
      )
    ).rows;
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      operation_id: failed.operation_id,
      status: "provider_in_flight",
    });
    expect(states[1]).toMatchObject({
      operation_id: delegate.calls[0]!.operation_id,
      status: "checkpointed",
      response_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      (
        await pool!.query("select count(*)::int count from document_versions where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].count,
    ).toBe(2);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
  });

  it("rejects reasonless direct releases for every paid-operation state", async () => {
    const { repository, run } = await setup("m4-pg-reasonless-release");
    const document = (
      await pool!.query<{ id: string }>(
        "select id from document_versions where run_id=$1 order by revision desc limit 1",
        [run.run_id],
      )
    ).rows[0]!.id;
    const executionIds = new Map<string, string>();
    for (const step of [
      "draft",
      "review_writing_style",
      "revision_pass",
      "final_coherence_export",
    ] as const) {
      const execution = await repository.claimStep(run.run_id, step, `reasonless-${step}`, true);
      executionIds.set(step, execution.execution_id);
      await pool!.query(
        `update step_executions set status='retryable_failed',lease_token=null,lease_owner=null,
           lease_expires_at=null,completed_at=null,updated_at=clock_timestamp() where id=$1`,
        [execution.execution_id],
      );
    }
    const execution = (step: string) => executionIds.get(step)!;
    await pool!.query(
      `insert into draft_operation_states(operation_id,run_id,producing_step_execution_id,request_hash,provider,model,contract_identity,purpose,status,ambiguity_reason)
       values('reasonless-draft',$1,$2,'hash','test','model','contract','initial','provider_in_flight','provider_in_flight_without_checkpoint')`,
      [run.run_id, execution("draft")],
    );
    await pool!.query(
      `insert into review_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,step,request_hash,provider,model,status,ambiguity_reason)
       values('reasonless-review',$1,$2,$3,'review_writing_style','hash','test','model','provider_in_flight','provider_in_flight_without_checkpoint')`,
      [run.run_id, document, execution("review_writing_style")],
    );
    await pool!.query(
      `insert into revision_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash,status,ambiguity_reason)
       values('reasonless-revision',$1,$2,$3,'hash','provider_in_flight','provider_in_flight_without_checkpoint')`,
      [run.run_id, document, execution("revision_pass")],
    );
    await pool!.query(
      `insert into coherence_checkpoints(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash,status,ambiguity_reason)
       values('reasonless-coherence',$1,$2,$3,'hash','provider_in_flight','provider_in_flight_without_checkpoint')`,
      [run.run_id, document, execution("final_coherence_export")],
    );

    for (const [table, operationId] of [
      ["draft_operation_states", "reasonless-draft"],
      ["review_operation_states", "reasonless-review"],
      ["revision_operation_states", "reasonless-revision"],
      ["coherence_checkpoints", "reasonless-coherence"],
    ]) {
      await expect(
        pool!.query(
          `update ${table} set status='started',ambiguity_reason=null where operation_id=$1`,
          [operationId],
        ),
      ).rejects.toThrow(/invalid|violates check constraint/i);
      await expect(
        pool!.query(`update ${table} set ambiguity_reason=null where operation_id=$1`, [
          operationId,
        ]),
      ).rejects.toThrow(/invalid|violates check constraint/i);
    }
  });

  it("persists revision model-mismatch release and safely retries the same operation", async () => {
    const { repository, run } = await setup("m4-pg-revision-model-mismatch");
    const fetcher = vi.fn();
    const pinned = new ChatCompletionRevisionProvider({
      token: "test-token",
      model: "pinned-model",
      fetcher,
    });
    const mismatch = {
      provider: pinned.provider,
      model: "request-model",
      revise: pinned.revise.bind(pinned),
    };
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        mismatch,
      ).run(run.run_id),
    ).rejects.toThrow("does not match");
    expect(fetcher).not.toHaveBeenCalled();

    const released = (
      await pool!.query(
        "select status,release_reason,ambiguity_reason from revision_operation_states where run_id=$1",
        [run.run_id],
      )
    ).rows[0];
    expect(released).toEqual({
      status: "started",
      release_reason: "configuration_before_dispatch",
      ambiguity_reason: null,
    });

    const retry = new MockRevisionProvider("request-model");
    const retryProvider = {
      provider: mismatch.provider,
      model: mismatch.model,
      revise: retry.revise.bind(retry),
    };
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      retryProvider,
    ).run(run.run_id);
    expect(retry.calls).toHaveLength(1);
    expect(
      (
        await pool!.query(
          "select status,release_reason,ambiguity_reason from revision_operation_states where run_id=$1",
          [run.run_id],
        )
      ).rows[0],
    ).toMatchObject({ status: "checkpointed", ambiguity_reason: null });
  });

  it("fails closed across the exact provider-return/checkpoint crash gap", async () => {
    const { repository, run } = await setup("m4-pg-revision-ambiguous");
    const first = new MockRevisionProvider("revision-v1");
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        {
          hit(boundary) {
            if (boundary === "after_revision_provider_return")
              throw new Error("crash after provider return before checkpoint");
          },
        },
        fixture,
        first,
      ).run(run.run_id),
    ).rejects.toThrow("crash after provider return before checkpoint");
    expect(first.calls).toHaveLength(1);

    const retry = new MockRevisionProvider("revision-v1");
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        retry,
      ).run(run.run_id),
    ).rejects.toThrow("outcome is ambiguous");
    expect(retry.calls).toHaveLength(0);
    expect(
      (
        await pool!.query(
          "select status,release_reason,ambiguity_reason from revision_operation_states where run_id=$1",
          [run.run_id],
        )
      ).rows[0],
    ).toEqual({
      status: "provider_in_flight",
      release_reason: null,
      ambiguity_reason: "provider_in_flight_without_checkpoint",
    });
  });

  it("checkpoints a validated revision response and fences concurrent recovery without provider recall", async () => {
    const { repository, run } = await setup("m4-pg-revision-recovery");
    const first = new MockRevisionProvider("revision-v1");
    let fired = false;
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        {
          hit(boundary) {
            if (!fired && boundary === "after_revision_provider") {
              fired = true;
              throw new Error("crash after revision response checkpoint");
            }
          },
        },
        fixture,
        first,
      ).run(run.run_id),
    ).rejects.toThrow();
    expect(first.calls).toHaveLength(1);
    const recovery = new MockRevisionProvider("revision-v1");
    await Promise.allSettled([
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        recovery,
      ).run(run.run_id, "revision-worker-a"),
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        recovery,
      ).run(run.run_id, "revision-worker-b"),
    ]);
    expect(recovery.calls).toHaveLength(0);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
    const state = (
      await pool!.query(
        "select status,response_hash from revision_operation_states where run_id=$1",
        [run.run_id],
      )
    ).rows;
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      status: "checkpointed",
      response_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("recovers a persisted coherence outcome without provider recall and fences concurrent resume", async () => {
    const { repository, run } = await setup("m4-pg-recovery");
    const first = new MockCoherenceProvider("coherence-v1");
    let fired = false;
    await expect(
      orchestrator(repository, first, {
        hit(boundary) {
          if (!fired && boundary === "after_coherence_persist") {
            fired = true;
            throw new Error("unsafe upstream body secret=hidden");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow();
    const recoveryProvider = new MockCoherenceProvider("coherence-v1");
    await Promise.allSettled([
      orchestrator(repository, recoveryProvider).run(run.run_id, "worker-a"),
      orchestrator(repository, recoveryProvider).run(run.run_id, "worker-b"),
    ]);
    expect(recoveryProvider.calls).toHaveLength(0);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
    const recoveries = (
      await pool!.query(
        "select producing_step_execution_id,recovery_step_execution_id,outcome from coherence_recoveries where run_id=$1",
        [run.run_id],
      )
    ).rows;
    expect(recoveries.length).toBeGreaterThanOrEqual(1);
    expect(recoveries.every((row) => row.outcome === "export")).toBe(true);
    expect(
      recoveries.every((row) => row.producing_step_execution_id !== row.recovery_step_execution_id),
    ).toBe(true);
    const errors = (
      await pool!.query(
        "select error->>'message' message from step_executions where run_id=$1 and error is not null",
        [run.run_id],
      )
    ).rows;
    expect(JSON.stringify(errors)).not.toContain("secret=hidden");
    expect(
      (
        await pool!.query<{ count: number }>(
          "select count(*)::int count from exports where run_id=$1 and status='succeeded'",
          [run.run_id],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  it("rejects recovered-checkpoint export with a forged authoritative checkpoint hash", async () => {
    const { repository, run } = await setup("m4-pg-recovery-export-hash-negative");
    let captured:
      | Parameters<ConstructorParameters<typeof MilestoneFourOrchestrator>[4]["export"]>[0]
      | undefined;
    const capturingExport = {
      async export(input: NonNullable<typeof captured>) {
        captured = input;
        throw new Error("stop before Google");
      },
    };
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        new MockRevisionProvider("revision-v1"),
        capturingExport,
      ).run(run.run_id),
    ).rejects.toThrow("stop before Google");
    expect(captured).toBeDefined();

    const checkpoint = (
      await pool!.query<{
        operation_id: string;
        producing_step_execution_id: string;
        document_version_id: string;
      }>(
        `select operation_id,producing_step_execution_id,document_version_id
         from coherence_checkpoints where run_id=$1`,
        [run.run_id],
      )
    ).rows[0]!;
    const current = await repository.claimStep(
      run.run_id,
      "final_coherence_export",
      "hash-forgery-recovery",
      true,
    );
    await pool!.query(
      `insert into coherence_recoveries(operation_id,run_id,document_version_id,
        producing_step_execution_id,recovery_step_execution_id,outcome)
       values($1,$2,$3,$4,$5,'export')`,
      [
        checkpoint.operation_id,
        run.run_id,
        checkpoint.document_version_id,
        checkpoint.producing_step_execution_id,
        current.execution_id,
      ],
    );
    await pool!.query(
      "alter table coherence_checkpoints disable trigger coherence_checkpoints_transition",
    );
    await pool!.query(
      "update coherence_checkpoints set response_hash=repeat('0',64) where operation_id=$1",
      [checkpoint.operation_id],
    );
    await pool!.query(
      "alter table coherence_checkpoints enable trigger coherence_checkpoints_transition",
    );

    const adapter = { export: vi.fn() };
    const service = new PostgresGoogleDocsExportService(pool!, adapter);
    await expect(
      service.export({
        ...captured!,
        step_execution_id: current.execution_id,
        fencing_token: current.token,
      }),
    ).rejects.toThrow("Final blocker gate does not permit export");
    expect(adapter.export).not.toHaveBeenCalled();
  });

  it("rejects recovered-checkpoint export without an exact recovery for the current execution", async () => {
    const { repository, run } = await setup("m4-pg-recovery-export-negative");
    let captured:
      | Parameters<ConstructorParameters<typeof MilestoneFourOrchestrator>[4]["export"]>[0]
      | undefined;
    const capturingExport = {
      async export(input: NonNullable<typeof captured>) {
        captured = input;
        throw new Error("stop before Google");
      },
    };
    await expect(
      orchestrator(
        repository,
        new MockCoherenceProvider("coherence-v1"),
        undefined,
        fixture,
        new MockRevisionProvider("revision-v1"),
        capturingExport,
      ).run(run.run_id),
    ).rejects.toThrow("stop before Google");
    expect(captured).toBeDefined();

    const operation = (
      await pool!.query<{
        operation_id: string;
        step_execution_id: string;
        document_version_id: string;
      }>(
        `select operation_id,step_execution_id,document_version_id from provider_operations
         where run_id=$1 and operation='final_coherence_export'`,
        [run.run_id],
      )
    ).rows[0]!;
    const unrelated = await repository.claimStep(
      run.run_id,
      "final_coherence_export",
      "unrelated-recovery",
      true,
    );
    await pool!.query(
      `insert into coherence_recoveries(operation_id,run_id,document_version_id,
        producing_step_execution_id,recovery_step_execution_id,outcome)
       values($1,$2,$3,$4,$5,'export')`,
      [
        operation.operation_id,
        run.run_id,
        operation.document_version_id,
        operation.step_execution_id,
        unrelated.execution_id,
      ],
    );
    await repository.failStep(unrelated.execution_id, unrelated.token, "test retry");
    const current = await repository.claimStep(
      run.run_id,
      "final_coherence_export",
      "current-recovery",
      true,
    );
    const adapter = { export: vi.fn() };
    const service = new PostgresGoogleDocsExportService(pool!, adapter);
    await expect(
      service.export({
        ...captured!,
        step_execution_id: current.execution_id,
        fencing_token: current.token,
      }),
    ).rejects.toThrow("Final blocker gate does not permit export");
    expect(adapter.export).not.toHaveBeenCalled();
  });
});

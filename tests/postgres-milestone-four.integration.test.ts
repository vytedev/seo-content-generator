import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import { RevisionProviderError } from "../src/server/providers/chat-completion-revision-provider.js";
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

async function setup(key: string) {
  const repository = new PostgresMilestoneRepository(pool!, 2_000, {
    writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
    schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
    allow_local_pending: true,
  });
  const run = await ingestHandoff(handoff, key, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([link]),
    new MockDraftProvider("draft-v1", draft),
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
) {
  return new MilestoneFourOrchestrator(
    repository,
    selectedFixture,
    revision,
    coherence,
    new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()),
    failure,
  );
}

integration("PostgreSQL milestone four", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
    await seedReferences();
  });
  afterAll(async () => pool?.end());

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
    const { repository, run } = await setup("m4-pg-deterministic-block");
    const coherence = new MockCoherenceProvider("coherence-v1");
    const linkRemovingRevision = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(`[chair](${link.url})`, "chair"),
    }));
    await orchestrator(
      repository,
      coherence,
      undefined,
      { ...fixture, link_verification: [] },
      linkRemovingRevision,
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
          rule_reference: "links.verified_internal_presence",
          severity: "blocker",
          origin_document_version_id: blockedDocument,
        },
      ],
    });
    await expect(repository.recoverDeterministicBlock(run.run_id)).resolves.toBe(true);
  });

  it("binds exceptional repair to the exact latest Step 1.11 blockers and never coherence or Step 1.9", async () => {
    const { repository, run } = await setup("m4-pg-exceptional-repair");
    const removing = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(`[chair](${link.url})`, "chair"),
    }));
    await orchestrator(
      repository,
      new MockCoherenceProvider("coherence-v1"),
      undefined,
      fixture,
      removing,
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
      rule_reference: "links.verified_internal_presence",
      origin_document_version_id: blocked.version.id,
    });
    const binding = (
      await pool!.query(
        `select deterministic_rerun_step_execution_id,blocker_set_hash,blocker_bindings
         from exceptional_correction_authorisations where run_id=$1`,
        [run.run_id],
      )
    ).rows[0];
    expect(binding.blocker_set_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.blocker_bindings).toHaveLength(1);

    const recovery = new MockRevisionProvider("revision-v1");
    await orchestrator(repository, undefined, undefined, fixture, recovery).run(run.run_id);
    expect(recovery.calls).toHaveLength(0);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toBe(blockedMarkdown);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("blocked");
    expect(
      (await pool!.query("select count(*)::int count from exports where run_id=$1", [run.run_id]))
        .rows[0].count,
    ).toBe(0);
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).resolves.toBe("replay");
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
      status: "response_validated",
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
        await pool!.query("select status from revision_operation_states where run_id=$1", [
          run.run_id,
        ])
      ).rows[0],
    ).toEqual({ status: "provider_in_flight" });
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
      status: "response_validated",
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
        "select producing_step_execution_id,recovery_step_execution_id from coherence_recoveries where run_id=$1",
        [run.run_id],
      )
    ).rows;
    expect(recoveries.length).toBeGreaterThanOrEqual(1);
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
  });
});

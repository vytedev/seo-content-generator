import { createHash } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { MilestoneTwoOrchestrator } from "../src/server/pipeline/milestone-two.js";
import { MilestoneThreeOrchestrator } from "../src/server/pipeline/milestone-three.js";
import { MilestoneFourOrchestrator } from "../src/server/pipeline/milestone-four.js";
import { EditorialCorrectionOrchestrator } from "../src/server/pipeline/editorial-correction.js";
import { MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../src/server/providers/milestone-four-providers.js";
import { MockGoogleDocsAdapter } from "../src/server/providers/google-docs.js";
import { PostgresGoogleDocsExportService } from "../src/server/services/export-service.js";
import { mapDeterministicInput } from "../src/shared/milestone-three.js";
import type { ReviewRequest, ReviewResponse } from "../src/shared/milestone-three.js";
import type { FactVerifier } from "../src/server/providers/fact-verifier.js";
import type {
  DraftLinkVerifier,
  LinkVerificationOutcome,
} from "../src/shared/link-conversion-review.js";
import type { DeterministicFixture } from "../src/shared/milestone-three.js";
import {
  DETERMINISTIC_BUILD_ID,
  DETERMINISTIC_CHECKER_VERSION_V1,
  DETERMINISTIC_CHECKER_VERSION_V2,
  DETERMINISTIC_INPUT_VERSION,
  DETERMINISTIC_RULE_INVENTORY_V1,
  DETERMINISTIC_RULE_INVENTORY_V2,
  deterministicHash,
  runVersionedDeterministicChecks,
} from "../src/shared/deterministic-run.js";
import {
  hasDanglingTitleEnding,
  suspiciousFaqPairIndexes,
} from "../src/shared/editorial-integrity.js";
import { resetPostgresFixtures, tableRowCounts } from "./helpers/postgres-reset.js";
import { seedReferenceFixtures } from "./helpers/seed-references.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

const PRIMARY_KEYWORD = "designer chair";
const V2_ONLY_RULES = ["on_page.title.complete", "structure.faq_pair_alignment"] as const;

const link = { url: "https://www.mobelaris.com/en/chair", title: "Chair", relevance: 1 };
const handoff = {
  plane_ticket: "MOB-EC-E2E",
  primary_keyword: PRIMARY_KEYWORD,
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
const fixture: DeterministicFixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [{ url: link.url, status: 200, hierarchy: "product", hierarchy_rank: 4 }],
};

/**
 * Three FAQs whose first two answers belong to each other's questions: exactly
 * the rotation the v2 pair-alignment rule detects, and the defect the real
 * frozen run carries. Every answer stays inside v1's 40-80 word range, so v1
 * sees a completely clean document and raises nothing.
 */
const LEATHER_QUESTION = "How should leather upholstery be cleaned?";
const OAK_QUESTION = "Which oak frame suits modern dining rooms?";
const DELIVERY_QUESTION = "When will delivery arrive after ordering?";
const LEATHER_ANSWER =
  "Wipe leather upholstery gently with a barely damp cloth, then dry it straight away. Condition the hide twice yearly using a product made for finished leather. Keep radiators and strong sunlight far from the surface, because dry heat hardens the finish and makes it crack.";
const OAK_ANSWER =
  "An oak frame suits modern dining rooms once its grain matches your table and the legs leave space underneath. Choose a matt lacquer if you want pale timber, or an oiled finish where you prefer a warmer tone that deepens gradually across many years.";
const DELIVERY_ANSWER =
  "Delivery usually arrives within three weeks of your order being confirmed, and our carrier telephones you the previous day to agree a two hour slot. Larger items travel on a dedicated van, so please measure doorways, stairs and lifts before booking any vehicle.";
const ROTATED_FAQS = [
  { question: LEATHER_QUESTION, answer: OAK_ANSWER },
  { question: OAK_QUESTION, answer: LEATHER_ANSWER },
  { question: DELIVERY_QUESTION, answer: DELIVERY_ANSWER },
];
const CORRECTED_FAQS = [
  { question: LEATHER_QUESTION, answer: LEATHER_ANSWER },
  { question: OAK_QUESTION, answer: OAK_ANSWER },
  { question: DELIVERY_QUESTION, answer: DELIVERY_ANSWER },
];

/** 57 characters, in range for the v1 length rule, but ending on a dangling "for". */
const DANGLING_META_TITLE = "Designer chair styles every calm modern home is ready for";
/** 59 characters, still in range, keyword retained, and no longer dangling. */
const CORRECTED_META_TITLE = "Designer chair styles every calm modern home is ready today";

/** A canned Step 1.4 finding at an authorised on_page field, so accepting it in
 * round 1 produces a real revised child through the ordinary revision path. */
const ROUND_ONE_STYLE_FINDING = {
  stable_key: "style-tone-1",
  category: "writing_style",
  rule_reference: "style.tone_consistency",
  severity: "blocker" as const,
  location: { field: "og_description" },
  issue: "The social description does not match the article's tone.",
  suggested_fix: "Rewrite the social description in the house tone.",
};
const CORRECTED_OG_DESCRIPTION = "A calm, practical guide to designer chairs.";

const words = (count: number) => Array.from({ length: count }, () => "plain").join(" ");
const draft = {
  title: "Designer chair guide".padEnd(55, "x"),
  meta_title: DANGLING_META_TITLE,
  slug: "designer-chair-guide",
  meta_description: "Designer chair guidance".padEnd(150, "x"),
  og_title: "Designer chair",
  og_description: "Designer chair guidance",
  images: [{ alt: "Chair", filename: "chair.jpg", placement: { marker: "chair" } }],
  faqs: ROTATED_FAQS,
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
  claims: [],
};

/**
 * The correction a model returns. It repairs only the authorised fields, and
 * only for the findings the operator actually accepted, so a round that accepts
 * one defect must leave the other in place.
 */
function correctingTransform(request: {
  current_document: typeof draft;
  accepted_findings: ReadonlyArray<{ rule_reference: string }>;
}) {
  const document = structuredClone(request.current_document);
  const accepted = new Set(request.accepted_findings.map((finding) => finding.rule_reference));
  if (accepted.has("on_page.title.complete")) document.meta_title = CORRECTED_META_TITLE;
  // Each pair is corrected as one object; the answers are never rotated again.
  if (accepted.has("structure.faq_pair_alignment")) document.faqs = CORRECTED_FAQS;
  if (accepted.has("style.tone_consistency")) document.og_description = CORRECTED_OG_DESCRIPTION;
  return document;
}

/** Fixed observation time: the fixtures must not depend on wall-clock drift. */
const LOCAL_EVIDENCE_AT = "2026-01-05T00:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);

/**
 * Evidence-declaring local verifiers.
 *
 * Step 1.6 inventories every FAQ answer whole and Step 1.7 audits every draft
 * link, and the production offline doubles answer "unverified" and
 * "no_network" to all of them. That is correct with no network, but it leaves
 * any local run permanently blocked, so a v2-only editorial defect could never
 * be the thing under test.
 *
 * These doubles supply the evidence a configured verifier would, and only for
 * what the fixture declares: an undeclared claim is still unverified and an
 * undeclared link is still unresolved, so neither gate is weakened.
 */
class DeclaredEvidenceFactVerifier implements FactVerifier {
  constructor(private readonly verified: ReadonlySet<string>) {}

  async verify(request: ReviewRequest, review: ReviewResponse): Promise<ReviewResponse> {
    const sources = request.fact_inventory.map((item) => {
      const proven = this.verified.has(item.text);
      return {
        stable_key: `source-local-${digest(item.stable_key)}`,
        uri: `mock://editorial-correction-fixture/${item.stable_key}`,
        title: proven ? "Declared local fixture evidence" : "No approved evidence available",
        source_type: proven ? ("approved_gateway" as const) : ("unresolved" as const),
        retrieved_at: LOCAL_EVIDENCE_AT,
        snapshot: { production_verified: proven },
        evidence: proven
          ? "Declared verbatim by the local editorial-correction fixture."
          : "No approved evidence available.",
      };
    });
    const provenance = (item: (typeof request.fact_inventory)[number]) =>
      item.classification === "attribution_provenance" || item.claim_type === "provenance";
    return {
      ...review,
      sources,
      claims: request.fact_inventory.map((item, index) => ({
        stable_key: `claim-local-${digest(item.stable_key)}`,
        inventory_key: item.stable_key,
        claim_text: item.text,
        type:
          item.classification === "attribution_provenance"
            ? ("provenance" as const)
            : item.claim_type,
        status: this.verified.has(item.text) ? ("verified" as const) : ("unverified" as const),
        location: item.location,
        hard_flag: provenance(item),
        source_key: sources[index]!.stable_key,
      })),
      findings: [
        ...review.findings,
        ...request.fact_inventory
          .filter((item) => !this.verified.has(item.text))
          .map((item) => ({
            stable_key: `fact-local-${digest(`${item.stable_key}:unverified`)}`,
            category: provenance(item) ? "provenance" : "fact_checking",
            rule_reference: provenance(item)
              ? "facts.provenance_always_review"
              : "facts.unverified",
            severity: "blocker" as const,
            location: item.location,
            issue: `Factual claim is unverified: ${item.text}`,
            suggested_fix:
              "Review the evidence and correct, source, or remove this claim before approval.",
          })),
      ],
    };
  }
}

class DeclaredFixtureLinkVerifier implements DraftLinkVerifier {
  constructor(private readonly declared: DeterministicFixture["link_verification"]) {}

  async verify(url: string): Promise<LinkVerificationOutcome> {
    const entry = this.declared.find((item) => item.url === url);
    return entry && entry.status === 200
      ? {
          outcome: "direct_200",
          method: "head",
          verified_at: LOCAL_EVIDENCE_AT,
          hierarchy: entry.hierarchy,
        }
      : { outcome: "unresolved_transport", reason: "no_network" };
  }
}

/** Exactly the assertions this fixture's article makes; nothing else is proven. */
const DECLARED_FACTS = new Set([LEATHER_ANSWER, OAK_ANSWER, DELIVERY_ANSWER]);

function harness(
  transform = correctingTransform,
  reviewOutputs: Partial<Record<"review_writing_style", (typeof ROUND_ONE_STYLE_FINDING)[]>> = {},
) {
  // Mirror the local application's composition exactly. The seeded export
  // templates are deliberately pending until editorial approval, and the local
  // wiring uses the schema's traceable local_pending_explicit policy; the guard
  // itself is left untouched.
  const repository = new PostgresMilestoneRepository(pool!, 300_000, {
    writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
    schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
    allow_local_pending: true,
  });
  const revisions = new MockRevisionProvider("revision-v1", transform as never);
  const milestoneFour = new MilestoneFourOrchestrator(
    repository,
    fixture,
    revisions,
    new MockCoherenceProvider("coherence-v1"),
    new PostgresGoogleDocsExportService(pool!, new MockGoogleDocsAdapter()),
  );
  const app = createApp({
    auth: { mode: "disabled" },
    serveClient: false,
    findingsRepository: repository,
    milestoneTwo: {
      repository,
      orchestrator: new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer([link]),
        new MockDraftProvider("draft-v1", draft as never),
      ),
    },
    milestoneThree: {
      repository,
      orchestrator: new MilestoneThreeOrchestrator(
        repository,
        fixture,
        new MockReviewProvider("review-v1", reviewOutputs as never),
        undefined,
        new DeclaredEvidenceFactVerifier(DECLARED_FACTS),
        new DeclaredFixtureLinkVerifier(fixture.link_verification),
      ),
      editorialCorrection: new EditorialCorrectionOrchestrator(repository, fixture),
    },
    milestoneFour: { repository, orchestrator: milestoneFour },
  });
  return { app, repository, revisions };
}

/**
 * Runs fixture surgery that has to look like pre-existing history. Append-only
 * rows cannot be replaced while their immutability triggers are armed, so each
 * named trigger is lifted for the statement and restored immediately after,
 * whatever happens. Production behaviour is never left altered: the suite
 * asserts the guards still fire afterwards.
 */
async function asHistoricalData(
  tables: readonly string[],
  work: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool!.connect();
  try {
    for (const table of tables)
      await client.query(`alter table ${table} disable trigger ${table}_immutable`);
    await work(client);
  } finally {
    for (const table of tables)
      await client.query(`alter table ${table} enable trigger ${table}_immutable`);
    client.release();
  }
}

/**
 * Rewrites the stored baseline into a genuinely historical v1 freeze and removes
 * the findings a v1 run could never have raised. This is the only state in which
 * a rule is "newly applicable", and it is what an existing run has on disk.
 *
 * Nothing is fabricated: the v1 manifest is assembled from the frozen v1
 * registry constants and the v1 result is produced by the real versioned runner,
 * which revalidates the manifest and would reject any inconsistency.
 */
async function freezeBaselineAsV1(repository: PostgresMilestoneRepository, runId: string) {
  const stored = await pool!.query<{
    manifest: Record<string, unknown>;
    document_version_id: string;
    step_execution_id: string;
  }>(
    "select manifest,document_version_id,step_execution_id from deterministic_manifests where run_id=$1",
    [runId],
  );
  const inventory = DETERMINISTIC_RULE_INVENTORY_V1.map((rule) => ({ ...rule }));
  const { manifest_hash: _discarded, ...previous } = stored.rows[0]!.manifest;
  const core = {
    ...previous,
    checker_version: DETERMINISTIC_CHECKER_VERSION_V1,
    build_id: DETERMINISTIC_BUILD_ID,
    rule_inventory: inventory,
    rule_inventory_hash: deterministicHash(inventory),
    config_hash: deterministicHash({
      checker_version: DETERMINISTIC_CHECKER_VERSION_V1,
      input_version: DETERMINISTIC_INPUT_VERSION,
      build_id: DETERMINISTIC_BUILD_ID,
      inventory,
    }),
  };
  const manifest = { ...core, manifest_hash: deterministicHash(core) };

  const current = (await repository.getDraft(runId))!;
  const links = (await repository.getLinks(runId)) ?? [];
  const result = runVersionedDeterministicChecks(
    mapDeterministicInput({
      run_id: runId,
      document_version_id: current.version.id,
      handoff: await repository.getHandoff(runId),
      draft: current.draft,
      persisted_links: links,
      fixture,
    }),
    { id: current.version.id, content_hash: current.version.content_hash },
    manifest as never,
  );
  // The frozen baseline is append-only in production, which is exactly the
  // guarantee under test. The historical row is therefore installed by lifting
  // only the immutability trigger for the replacement and restoring it at once;
  // the insert validator stays armed, so the v1 row is checked by production
  // rules on the way in.
  const row = stored.rows[0]!;
  await asHistoricalData(["deterministic_manifests"], async (client) => {
    await client.query("delete from deterministic_manifests where run_id=$1", [runId]);
    await client.query(
      `insert into deterministic_manifests(run_id,document_version_id,step_execution_id,manifest_hash,manifest,result_hash,result)
       values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
      [
        runId,
        row.document_version_id,
        row.step_execution_id,
        manifest.manifest_hash,
        JSON.stringify(manifest),
        result.result_hash,
        JSON.stringify(result),
      ],
    );
  });
  // A v1 freeze never produced the v2-only findings, so neither the finding rows
  // nor their round 1 review-set membership may exist.
  await asHistoricalData(
    ["findings", "finding_review_set_members", "finding_review_sets"],
    async (client) => {
      await client.query(
        `delete from finding_review_set_members m using findings f
         where m.finding_id=f.id and f.run_id=$1 and f.rule_reference = any($2::text[])`,
        [runId, [...V2_ONLY_RULES]],
      );
      await client.query(
        "delete from findings where run_id=$1 and rule_reference = any($2::text[])",
        [runId, [...V2_ONLY_RULES]],
      );
      // The review set carries a denormalised count; a historical set must not
      // claim members it never had.
      await client.query(
        `update finding_review_sets rs set finding_count =
           (select count(*) from finding_review_set_members m where m.review_set_id=rs.id)
         where rs.run_id=$1`,
        [runId],
      );
    },
  );
  return manifest;
}

async function frozenV1Run(
  key: string,
  transform = correctingTransform,
  reviewOutputs: Parameters<typeof harness>[1] = {},
) {
  const built = harness(transform, reviewOutputs);
  const run = await ingestHandoff(handoff, key, built.repository);
  await request(built.app)
    .post(`/api/runs/${run.run_id}/milestone-two/resume`)
    .send({})
    .expect(200);
  await request(built.app)
    .post(`/api/runs/${run.run_id}/milestone-three/resume`)
    .send({})
    .expect(200);
  await freezeBaselineAsV1(built.repository, run.run_id);
  const frozen = (await built.repository.getDraft(run.run_id))!;

  // An existing frozen run has already been through review round 1. Rejecting
  // its remaining findings is what leaves the frozen version current: the
  // controlled revision completes as a no-op and creates no child, which is the
  // only state in which a v1 baseline can still be corrected.
  const pending = await request(built.app).get(`/api/runs/${run.run_id}/findings`).expect(200);
  if (pending.body.findings.length > 0) {
    const submitted = await request(built.app)
      .post(`/api/runs/${run.run_id}/findings/dispositions`)
      .send({
        document_version_id: frozen.version.id,
        idempotency_key: `${key}-round-1`,
        dispositions: (pending.body.findings as Array<{ id: string; rule_reference: string }>).map(
          (finding) => ({
            finding_id: finding.id,
            // Only a canned, authorised finding is accepted; everything the real
            // reviewers raised is rejected so the frozen version stays current
            // unless the fixture deliberately asks for a revised child.
            decision:
              finding.rule_reference === ROUND_ONE_STYLE_FINDING.rule_reference
                ? "accepted"
                : "rejected",
          }),
        ),
      });
    // 202 is the expected outcome, not a failure: the decisions commit, then the
    // no-op revision leaves the run with no revised parent/current pair, which
    // Step 1.12 requires. The correction round is what produces that child.
    expect([200, 202]).toContain(submitted.status);
  }

  // The preconditions the correction actually depends on, asserted rather than
  // assumed: no round may still be waiting.
  const reviewed = await pool!.query<{ count: number }>(
    "select count(*)::int count from step_executions where run_id=$1 and step='findings_review' and status='waiting'",
    [run.run_id],
  );
  expect(reviewed.rows[0]!.count).toBe(0);
  return { ...built, runId: run.run_id, frozen };
}

async function documentRows(runId: string) {
  return (
    await pool!.query<{
      id: string;
      revision: number;
      parent_id: string | null;
      content_hash: string;
      body_text: string;
    }>(
      `select d.id,d.revision,d.parent_id,d.content_hash,a.body_text
       from document_versions d join artifacts a on a.id=d.artifact_id
       where d.run_id=$1 order by d.revision`,
      [runId],
    )
  ).rows;
}

integration("editorial correction end to end", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
    await seedReferenceFixtures(pool!);
    // Any outbound HTTP at all is a failure: the Google adapter is mocked and
    // the whole flow must complete without touching the network.
    fetchSpy = vi.fn(() => {
      throw new Error("Unexpected network request during a local export");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => pool?.end());

  it("carries a frozen v1 run through correction, revision, gates and export", async () => {
    const { app, repository, runId, frozen } = await frozenV1Run("ec-e2e-happy");

    // The baseline is genuinely historical and carries none of the v2 rules.
    const baseline = await repository.getDeterministicManifest(runId);
    expect(baseline.manifest.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V1);
    expect(baseline.manifest.rule_inventory.map((rule) => rule.id)).not.toEqual(
      expect.arrayContaining([...V2_ONLY_RULES]),
    );
    const roundOne = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    for (const rule of V2_ONLY_RULES)
      expect(
        roundOne.body.findings.map((f: { rule_reference: string }) => f.rule_reference),
      ).not.toContain(rule);
    const roundOneIds = roundOne.body.findings.map((f: { id: string }) => f.id).sort();

    // No export may exist before the operator has decided anything.
    expect(
      (await pool!.query("select count(*)::int c from exports where run_id=$1", [runId])).rows[0].c,
    ).toBe(0);

    // 1. Open the correction through the real route.
    const opened = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    expect(opened.body.status).toBe("opened");
    expect(opened.body.round).toBe(2);
    expect(opened.body.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
    expect([...opened.body.newly_applicable_rule_ids].sort()).toEqual([...V2_ONLY_RULES].sort());

    // 2. Only the newly applicable rules are offered; nothing already dispositioned.
    const queue = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    const offered = queue.body.findings as Array<{ id: string; rule_reference: string }>;
    expect(new Set(offered.map((f) => f.rule_reference))).toEqual(new Set(V2_ONLY_RULES));
    expect(offered.some((f) => roundOneIds.includes(f.id))).toBe(false);

    // Round 1 is untouched and the frozen version is still current.
    expect(
      (
        await pool!.query(
          "select count(*)::int c from finding_review_sets where run_id=$1 and round=1",
          [runId],
        )
      ).rows[0].c,
    ).toBe(1);
    const beforeRevision = await documentRows(runId);
    expect(beforeRevision).toHaveLength(1);
    expect(beforeRevision[0]!.id).toBe(frozen.version.id);

    // Approval is required. Resuming the pipeline while the correction round is
    // open and undecided is accepted as a no-op rather than refused, so assert
    // the contract that matters: nothing is revised, nothing is exported, and
    // the run stays parked on the operator.
    await request(app).post(`/api/runs/${runId}/milestone-four/resume`).send({});
    expect(
      (await pool!.query("select count(*)::int c from exports where run_id=$1", [runId])).rows[0].c,
    ).toBe(0);
    expect(await documentRows(runId)).toHaveLength(1);
    const parked = await request(app).get(`/api/runs/${runId}`).expect(200);
    expect(parked.body).toMatchObject({ status: "waiting", current_step: "findings_review" });
    expect(
      (
        await pool!.query(
          `select count(*)::int c from finding_dispositions d
           join finding_review_set_members m on m.finding_id=d.finding_id
           join finding_review_sets rs on rs.id=m.review_set_id
           where rs.run_id=$1 and rs.round=2`,
          [runId],
        )
      ).rows[0].c,
    ).toBe(0);

    // 3. Accept every correction through the real dispositions route, which runs
    //    the controlled revision, the deterministic rerun and the export.
    const accepted = await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: frozen.version.id,
        idempotency_key: "ec-e2e-accept-round-2",
        dispositions: offered.map((f) => ({ finding_id: f.id, decision: "accepted" })),
      });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ completed: true, continuation: "completed" });

    // 4. A new immutable child exists and the source is byte-identical.
    const after = await documentRows(runId);
    expect(after).toHaveLength(2);
    const [source, child] = after;
    expect(source!.id).toBe(beforeRevision[0]!.id);
    expect(source!.content_hash).toBe(beforeRevision[0]!.content_hash);
    expect(source!.body_text).toBe(beforeRevision[0]!.body_text);
    expect(child!.parent_id).toBe(source!.id);
    expect(child!.revision).toBe(source!.revision + 1);
    expect(child!.content_hash).not.toBe(source!.content_hash);

    // 5. The editorial defects are gone from the child.
    const corrected = (await repository.getDraft(runId))!;
    expect(corrected.version.id).toBe(child!.id);
    expect(corrected.draft.meta_title).toBe(CORRECTED_META_TITLE);
    expect(hasDanglingTitleEnding(corrected.draft.meta_title!)).toBe(false);
    expect(suspiciousFaqPairIndexes(corrected.draft.faqs, PRIMARY_KEYWORD)).toEqual([]);
    // Each pair moved as one object: questions and their answers now belong together.
    expect(corrected.draft.faqs).toEqual(CORRECTED_FAQS);
    // The untouched third pair is carried through unchanged.
    expect(corrected.draft.faqs[2]).toEqual(draft.faqs[2]);

    // 6. The deterministic gate ran again against the corrected child, and was
    //    checked against the frozen v1 baseline rather than a fresh one.
    const rerun = await pool!.query<{
      baseline_manifest_hash: string;
      retained_blockers: number;
      introduced_blockers: number;
    }>(
      `select baseline_manifest_hash,retained_blockers,introduced_blockers
       from deterministic_reruns where run_id=$1 and document_version_id=$2`,
      [runId, child!.id],
    );
    expect(rerun.rows).toHaveLength(1);
    expect(rerun.rows[0]!.baseline_manifest_hash).toBe(baseline.manifest.manifest_hash);
    expect(rerun.rows[0]!.retained_blockers).toBe(0);
    expect(rerun.rows[0]!.introduced_blockers).toBe(0);

    // 7. The corrected child is the exported document, and nothing hit the network.
    const exported = await pool!.query<{ document_version_id: string; external_url: string }>(
      "select document_version_id,external_url from exports where run_id=$1",
      [runId],
    );
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0]!.document_version_id).toBe(child!.id);
    expect(exported.rows[0]!.external_url).toContain("docs.google.local");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replays an already-open correction and needs none once the child is clean", async () => {
    const { app, runId, frozen } = await frozenV1Run("ec-e2e-idempotent");

    const first = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    expect(first.body.status).toBe("opened");

    // Repeats are replays: the same round, no extra findings, no extra rows.
    const afterFirst = await tableRowCounts(pool!);
    for (const attempt of [1, 2]) {
      const repeated = await request(app)
        .post(`/api/runs/${runId}/editorial-correction/open`)
        .send({ explicit_confirmation: true })
        .expect(200);
      expect(repeated.body.status, `attempt ${attempt}`).toBe("already_open");
      expect(repeated.body.round).toBe(first.body.round);
      expect(repeated.body.finding_count).toBe(first.body.finding_count);
    }
    expect(await tableRowCounts(pool!)).toEqual(afterFirst);

    // Once every accepted correction has been applied, the corrected child has
    // no newly applicable defect left, so a further open is a no-op that writes
    // nothing rather than looping.
    const queue = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: frozen.version.id,
        idempotency_key: "ec-e2e-idempotent-accept",
        dispositions: (queue.body.findings as Array<{ id: string }>).map((f) => ({
          finding_id: f.id,
          decision: "accepted",
        })),
      })
      .expect(200);

    const beforeSettled = await tableRowCounts(pool!);
    const settled = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    expect(settled.body.status).toBe("not_required");
    expect(await tableRowCounts(pool!)).toEqual(beforeSettled);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens a correction on an existing child and creates a grandchild", async () => {
    // The real frozen run is two revisions past its baseline, so this is the
    // shape that matters: the historical manifest supplies the rule inventory
    // while the CURRENT version supplies the content being evaluated.
    const { app, repository, runId, frozen } = await frozenV1Run("ec-e2e-lineage");
    const baseline = await repository.getDeterministicManifest(runId);

    // Round 2 corrects the title only; the rotated FAQ pair is left in place.
    await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    const roundTwo = (await request(app).get(`/api/runs/${runId}/findings`).expect(200)).body
      .findings as Array<{ id: string; rule_reference: string }>;
    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: frozen.version.id,
        idempotency_key: "ec-e2e-lineage-title",
        dispositions: roundTwo.map((finding) => ({
          finding_id: finding.id,
          decision: finding.rule_reference === "on_page.title.complete" ? "accepted" : "rejected",
        })),
      });
    const child = (await repository.getDraft(runId))!;
    expect(child.version.parent_id).toBe(frozen.version.id);
    expect(child.draft.meta_title).toBe(CORRECTED_META_TITLE);
    // The FAQ defect survived, because that finding was rejected.
    expect(suspiciousFaqPairIndexes(child.draft.faqs, PRIMARY_KEYWORD)).toEqual([0, 1]);

    // Round 3 opens against the CHILD, which the old baseline-identity guard
    // made impossible. The inventory still comes from the frozen v1 manifest.
    const onChild = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    expect(onChild.body).toMatchObject({ status: "opened", round: 3 });
    expect([...onChild.body.newly_applicable_rule_ids].sort()).toEqual([...V2_ONLY_RULES].sort());
    expect(baseline.manifest.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V1);
    expect(baseline.manifest.baseline_document.id).toBe(frozen.version.id);

    // Only the still-present defect is offered: the title rule no longer fires
    // against the child, so the current content is what was evaluated.
    const roundThree = (await request(app).get(`/api/runs/${runId}/findings`).expect(200)).body
      .findings as Array<{ id: string; rule_reference: string }>;
    expect(new Set(roundThree.map((finding) => finding.rule_reference))).toEqual(
      new Set(["structure.faq_pair_alignment"]),
    );

    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: child.version.id,
        idempotency_key: "ec-e2e-lineage-faqs",
        dispositions: roundThree.map((finding) => ({
          finding_id: finding.id,
          decision: "accepted",
        })),
      });

    // baseline -> child -> grandchild, with both ancestors byte-identical.
    const versions = await documentRows(runId);
    expect(versions.map((row) => row.revision)).toEqual([1, 2, 3]);
    const [baselineRow, childRow, grandchild] = versions;
    expect(baselineRow!.id).toBe(frozen.version.id);
    expect(baselineRow!.parent_id).toBeNull();
    expect(baselineRow!.content_hash).toBe(frozen.version.content_hash);
    expect(childRow!.id).toBe(child.version.id);
    expect(childRow!.parent_id).toBe(baselineRow!.id);
    expect(childRow!.content_hash).toBe(child.version.content_hash);
    expect(grandchild!.parent_id).toBe(childRow!.id);

    const corrected = (await repository.getDraft(runId))!;
    expect(corrected.version.id).toBe(grandchild!.id);
    expect(corrected.draft.meta_title).toBe(CORRECTED_META_TITLE);
    expect(suspiciousFaqPairIndexes(corrected.draft.faqs, PRIMARY_KEYWORD)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is eligible for the real frozen run's structural shape", async () => {
    // The real frozen run (read-only diagnostic) has: a v1 baseline whose rule
    // inventory predates the two v2 rules, a current version that is a
    // DESCENDANT of that baseline rather than the baseline itself, no waiting
    // findings-review execution, and active round 1. That shape is reproduced
    // here through the ordinary revision path - no correction involved - and
    // must be eligible.
    const { app, repository, runId, frozen } = await frozenV1Run("ec-e2e-shape", undefined, {
      review_writing_style: [ROUND_ONE_STYLE_FINDING],
    });
    const baseline = await repository.getDeterministicManifest(runId);
    const current = (await repository.getDraft(runId))!;

    // Shape assertions, mirroring the read-only diagnostic field by field.
    expect(baseline.manifest.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V1);
    expect(baseline.manifest.rule_inventory.length).toBeLessThan(
      DETERMINISTIC_RULE_INVENTORY_V2.length,
    );
    expect(baseline.manifest.baseline_document.id).toBe(frozen.version.id);
    expect(current.version.id).not.toBe(frozen.version.id);
    expect(current.version.parent_id).toBe(frozen.version.id);
    expect(current.draft.og_description).toBe(CORRECTED_OG_DESCRIPTION);
    expect(
      (
        await pool!.query(
          "select coalesce(max(round),0)::int r from finding_review_sets where run_id=$1",
          [runId],
        )
      ).rows[0].r,
    ).toBe(1);
    expect(
      (
        await pool!.query(
          "select count(*)::int c from step_executions where run_id=$1 and step='findings_review' and status='waiting'",
          [runId],
        )
      ).rows[0].c,
    ).toBe(0);

    // Eligible: the correction opens against the descendant, not the baseline.
    const opened = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    expect(opened.body).toMatchObject({ status: "opened", round: 2 });
    const offered = (await request(app).get(`/api/runs/${runId}/findings`).expect(200)).body
      .findings as Array<{ document_version_id: string; rule_reference: string }>;
    expect(new Set(offered.map((finding) => finding.rule_reference))).toEqual(
      new Set(V2_ONLY_RULES),
    );
    // Every raised finding is bound to the CURRENT version, never the baseline.
    for (const finding of offered) expect(finding.document_version_id).toBe(current.version.id);
  });

  it("targets the active review round deterministically when another execution waits", async () => {
    const { app, runId, frozen } = await frozenV1Run("ec-e2e-active-round");
    const opened = await request(app)
      .post(`/api/runs/${runId}/editorial-correction/open`)
      .send({ explicit_confirmation: true })
      .expect(200);
    const activeSet = (
      await pool!.query<{ id: string }>(
        "select id from finding_review_sets where run_id=$1 and round=$2",
        [runId, opened.body.round],
      )
    ).rows[0]!;

    // A decoy waiting findings-review execution with no review set: selecting
    // "the" waiting execution by row order could pick this one and strand the
    // operator's decisions.
    await pool!.query(
      `insert into step_executions(run_id,step,attempt,status,started_at)
       values($1,'findings_review',(select max(attempt)+1 from step_executions where run_id=$1 and step='findings_review'),'waiting',clock_timestamp())`,
      [runId],
    );

    const queue = (await request(app).get(`/api/runs/${runId}/findings`).expect(200)).body
      .findings as Array<{ id: string }>;
    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: frozen.version.id,
        idempotency_key: "ec-e2e-active-round-accept",
        dispositions: queue.map((finding) => ({ finding_id: finding.id, decision: "accepted" })),
      })
      .expect(200);

    // The decisions landed on the active round's frozen set, not the decoy.
    const submissions = await pool!.query<{ review_set_id: string }>(
      "select review_set_id from finding_review_submissions where run_id=$1 order by created_at",
      [runId],
    );
    expect(submissions.rows.map((row) => row.review_set_id)).toContain(activeSet.id);
  });

  it("returns 409 rather than 500 when a review round is still awaiting decisions", async () => {
    // Two waiting rounds would leave two operator queues, so this must fail
    // closed - and as an actionable conflict, not an internal error.
    const built = harness();
    const run = await ingestHandoff(handoff, "ec-e2e-409", built.repository);
    await request(built.app)
      .post(`/api/runs/${run.run_id}/milestone-two/resume`)
      .send({})
      .expect(200);
    await request(built.app)
      .post(`/api/runs/${run.run_id}/milestone-three/resume`)
      .send({})
      .expect(200);
    await freezeBaselineAsV1(built.repository, run.run_id);
    expect(
      (
        await pool!.query(
          "select count(*)::int c from step_executions where run_id=$1 and step='findings_review' and status='waiting'",
          [run.run_id],
        )
      ).rows[0].c,
    ).toBe(1);

    const before = await tableRowCounts(pool!);
    const conflicted = await request(built.app)
      .post(`/api/runs/${run.run_id}/editorial-correction/open`)
      .send({ explicit_confirmation: true });
    expect(conflicted.status).toBe(409);
    expect(conflicted.body.error).toMatchObject({ code: "CONFLICT" });
    expect(conflicted.body.error.message).toMatch(/already awaiting decisions/);
    expect(await tableRowCounts(pool!)).toEqual(before);
  });
});

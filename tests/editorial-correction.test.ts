import { describe, expect, it } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture } from "../src/shared/milestone-three.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { EditorialCorrectionOrchestrator } from "../src/server/pipeline/editorial-correction.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import { hasDanglingTitleEnding } from "../src/shared/editorial-integrity.js";
import { planEditorialCorrection } from "../src/shared/editorial-correction.js";
import {
  DETERMINISTIC_CHECKER_VERSION_V1,
  DETERMINISTIC_CHECKER_VERSION_V2,
  DETERMINISTIC_RULE_INVENTORY_V1,
} from "../src/shared/deterministic-run.js";

const handoff = {
  plane_ticket: "MOB-EC",
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
const fixture: DeterministicFixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [
    {
      url: "https://www.mobelaris.com/chairs",
      status: 200,
      hierarchy: "collection",
      hierarchy_rank: 1,
    },
  ],
};

/** A draft whose title dangles on "for" — the defect observed on the live run. */
const draft = {
  title: "Designer chairs: a practical UK guide for",
  slug: "designer-chair-guide",
  meta_description: "A concise guide.",
  og_title: "Designer chair",
  og_description: "A concise guide.",
  images: [],
  faqs: [],
  markdown:
    "# Designer chair\n\nA short answer with a [chair collection](https://www.mobelaris.com/chairs).\n\n## Conclusion\n\nChoose carefully.",
  claims: [
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};

/** Builds a run frozen at its Step 1.4 deterministic baseline. */
async function frozenRun(key = "ec") {
  const repository = new InMemoryMilestoneRepository();
  const run = await ingestHandoff(handoff, key, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([
      { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
    ]),
    new MockDraftProvider("draft-v1", draft),
  ).run(run.run_id);
  await new MilestoneThreeOrchestrator(
    repository,
    fixture,
    new MockReviewProvider("review-v1"),
  ).run(run.run_id);
  freezeAsV1(repository, run.run_id);
  await decideRoundOne(repository, run.run_id, key);
  return { repository, run };
}

/**
 * An existing frozen run has already been through review round 1. A correction
 * may only be opened once no round is still awaiting decisions, so the fixture
 * decides round 1 the way the operator already had.
 */
async function decideRoundOne(repository: InMemoryMilestoneRepository, runId: string, key: string) {
  const pending = await repository.listFindings(runId, {});
  if (pending.length === 0) return;
  await repository.submitDispositions(runId, {
    document_version_id: (await repository.getDraft(runId))!.version.id,
    idempotency_key: `${key}-round-1`,
    dispositions: pending.map((finding) => ({
      finding_id: finding.id,
      decision: "rejected" as const,
    })),
  });
}

/**
 * Rewrites the stored baseline to look like a genuinely historical v1 freeze:
 * the manifest records the v1 checker version and only the v1 rule inventory.
 * This is what an existing run such as the live one actually has on disk, and
 * it is the only state in which any rule can be "newly applicable".
 */
function freezeAsV1(repository: InMemoryMilestoneRepository, runId: string) {
  const stored = repository.deterministicBaselines.get(runId);
  if (!stored) throw new Error("fixture run has no deterministic baseline");
  repository.deterministicBaselines.set(runId, {
    ...stored,
    manifest: {
      ...stored.manifest,
      checker_version: DETERMINISTIC_CHECKER_VERSION_V1,
      rule_inventory: DETERMINISTIC_RULE_INVENTORY_V1.map((rule) => ({ ...rule })),
    } as never,
  });
}

describe("controlled editorial correction", () => {
  it("raises only rules absent from the frozen baseline", () => {
    // A baseline frozen under v1 never evaluated the two v2 editorial rules, so
    // exactly those may be raised now — nothing already dispositioned.
    const manifest = {
      checker_version: DETERMINISTIC_CHECKER_VERSION_V1,
      rule_inventory: DETERMINISTIC_RULE_INVENTORY_V1.map((rule) => ({ ...rule })),
      baseline_document: { id: "v1", content_hash: "a".repeat(64) },
    } as never;
    const plan = planEditorialCorrection({
      manifest,
      checkerInput: {
        primary_keyword: "designer chair",
        related_keywords: ["modern seating"],
        internal_origins: ["https://www.mobelaris.com"],
        verified_internal_links: [],
        body_markdown: "# Designer chair\n\nCopy.\n",
        on_page: {
          meta_title: draft.title,
          meta_description: "A concise guide.".padEnd(150, "."),
          og_title: draft.og_title,
          og_description: draft.og_description,
          slug: draft.slug,
          images: [],
          faqs: [],
        },
      } as never,
    });
    expect(plan.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
    expect(plan.newly_applicable_rule_ids).toEqual([
      "on_page.title.complete",
      "structure.faq_pair_alignment",
    ]);
    // Only the newly applicable rule produced a finding; no v1 rule is re-raised.
    expect(plan.findings.map((finding) => finding.rule_reference)).toEqual([
      "on_page.title.complete",
    ]);
    for (const finding of plan.findings)
      expect(
        DETERMINISTIC_RULE_INVENTORY_V1.some((rule) => rule.id === finding.rule_reference),
      ).toBe(false);
  });

  it("opens a second review round on the same immutable version and parks the run for review", async () => {
    // Every run past Step 1.4 has a frozen review set, and listFindings only
    // ever returns that set. Adding findings now would store blockers the
    // operator could never see, so the correction must refuse before writing.
    const { repository, run } = await frozenRun("ec-open");
    const before = await repository.getDraft(run.run_id);
    const roundOneSet = repository.findingReviewSets.find((set) => set.round === 1)!;
    const roundOneMembers = [...roundOneSet.finding_ids];
    const outcome = await new EditorialCorrectionOrchestrator(repository, fixture).open(run.run_id);

    expect(outcome.status).toBe("opened");
    expect(outcome.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
    expect(outcome).toMatchObject({
      round: 2,
      newly_applicable_rule_ids: ["on_page.title.complete", "structure.faq_pair_alignment"],
    });
    const detail = await repository.getRunDetail(run.run_id);
    expect(detail).toMatchObject({ status: "waiting", current_step: "findings_review" });

    // Round 1 is immutable and still queryable.
    const stillRoundOne = repository.findingReviewSets.find((set) => set.round === 1)!;
    expect(stillRoundOne.finding_ids).toEqual(roundOneMembers);
    expect(stillRoundOne.membership_hash).toBe(roundOneSet.membership_hash);

    // The operator queue is the correction round only.
    const queue = await repository.listFindings(run.run_id, {});
    expect(queue.map((finding) => finding.rule_reference)).toEqual(["on_page.title.complete"]);

    // The frozen version is untouched: same id, same content hash.
    const after = await repository.getDraft(run.run_id);
    expect(after!.version.id).toBe(before!.version.id);
    expect(after!.version.content_hash).toBe(before!.version.content_hash);
    expect(after!.draft).toEqual(before!.draft);

    // The frozen manifest still records its own historical version.
    const { manifest } = await repository.getDeterministicManifest(run.run_id);
    expect(manifest.baseline_document.id).toBe(before!.version.id);
  });

  it("is idempotent: repeated invocation duplicates neither findings nor versions", async () => {
    const { repository, run } = await frozenRun("ec-idem");
    const orchestrator = new EditorialCorrectionOrchestrator(repository, fixture);
    const findingsBefore = structuredClone(repository.findings);
    const versionsBefore = repository.documentVersions.length;

    const first = await orchestrator.open(run.run_id);
    const second = await orchestrator.open(run.run_id);
    const third = await orchestrator.open(run.run_id);

    expect([first.status, second.status, third.status]).toEqual([
      "opened",
      "already_open",
      "already_open",
    ]);
    // Exactly one correction round, no duplicate findings or versions.
    expect(repository.findingReviewSets.filter((set) => set.round > 1)).toHaveLength(1);
    expect(
      repository.findings.filter((f) => f.stable_key.startsWith("editorial-correction:")),
    ).toHaveLength(1);
    expect(repository.documentVersions).toHaveLength(versionsBefore);
    expect(findingsBefore.length).toBeLessThan(repository.findings.length);
  });

  it("leaves existing dispositions untouched", async () => {
    const { repository, run } = await frozenRun("ec-disp");
    // The fixture already decided round 1; those decisions must survive intact.
    expect(repository.dispositions.length).toBeGreaterThan(0);
    const before = structuredClone(repository.dispositions);

    await new EditorialCorrectionOrchestrator(repository, fixture).open(run.run_id);

    expect(repository.dispositions).toEqual(before);
  });

  it("fails closed and writes nothing on a stale source version id or content hash", async () => {
    // The correction is fenced on the CURRENT version, so these are the two
    // ways a concurrent revision can invalidate a planned round.
    const { repository, run } = await frozenRun("ec-conflict");
    const current = (await repository.getDraft(run.run_id))!;
    const before = structuredClone(repository.findings);
    const setsBefore = structuredClone(repository.findingReviewSets);
    const correction = {
      run_id: run.run_id,
      checker_version: DETERMINISTIC_CHECKER_VERSION_V2,
      findings: [
        {
          stable_key: "editorial-correction:stale",
          category: "deterministic",
          rule_reference: "on_page.title.complete",
          severity: "blocker" as const,
          location: { field: "on_page.meta_title" },
          issue: "meta title ends with a dangling connector or preposition.",
          suggested_fix: "Complete the title at the editorial boundary.",
          hard_flag: false,
        },
      ],
    };

    await expect(
      repository.openEditorialCorrectionRound({
        ...correction,
        document_version_id: "00000000-0000-4000-8000-0000000000ff",
        expected_content_hash: current.version.content_hash,
      }),
    ).rejects.toThrow(/no longer the current document version/);
    await expect(
      repository.openEditorialCorrectionRound({
        ...correction,
        document_version_id: current.version.id,
        expected_content_hash: "f".repeat(64),
      }),
    ).rejects.toThrow(/content hash changed/);

    expect(repository.findings).toEqual(before);
    expect(repository.findingReviewSets).toEqual(setsBefore);
  });

  it("refuses to open while an earlier review round is still awaiting decisions", async () => {
    // Two waiting rounds would leave two open operator queues and disposition
    // submission would have to choose between them.
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "ec-waiting", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
      ]),
      new MockDraftProvider("draft-v1", draft),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    freezeAsV1(repository, run.run_id);
    const before = structuredClone(repository.findings);
    const setsBefore = structuredClone(repository.findingReviewSets);

    await expect(
      new EditorialCorrectionOrchestrator(repository, fixture).open(run.run_id),
    ).rejects.toThrow(/already awaiting decisions/);
    expect(repository.findings).toEqual(before);
    expect(repository.findingReviewSets).toEqual(setsBefore);
  });

  it("raises nothing when the frozen version has no newly applicable defect", async () => {
    const repository = new InMemoryMilestoneRepository();
    const clean = { ...draft, title: "Designer chairs: a practical UK guide" };
    expect(hasDanglingTitleEnding(clean.title)).toBe(false);
    const run = await ingestHandoff(handoff, "ec-clean", repository);
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
      ]),
      new MockDraftProvider("draft-v1", clean),
    ).run(run.run_id);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    freezeAsV1(repository, run.run_id);
    const before = structuredClone(repository.findings);

    const outcome = await new EditorialCorrectionOrchestrator(repository, fixture).open(run.run_id);

    // The v2 rules are newly applicable, but this draft trips none of them.
    expect(outcome.status).toBe("not_required");
    expect(repository.findings).toEqual(before);
  });

  it("keeps export blocked until the dangling title is actually corrected", async () => {
    // The editorial gate is independent of the correction entry point: it keeps
    // refusing until the content itself is fixed, so opening a correction can
    // never by itself make a malformed version exportable.
    const { assertEditoriallyExportable } = await import("../src/shared/editorial-integrity.js");
    expect(() => assertEditoriallyExportable(draft as never, handoff.primary_keyword)).toThrow(
      /controlled correction before export/,
    );
    const corrected = { ...draft, title: "Designer chairs: a practical UK guide" };
    expect(() =>
      assertEditoriallyExportable(corrected as never, handoff.primary_keyword),
    ).not.toThrow();
  });
});

describe("editorial correction fixtures", () => {
  it("uses a title that genuinely dangles, so the suite cannot pass vacuously", () => {
    expect(hasDanglingTitleEnding(draft.title)).toBe(true);
  });
});

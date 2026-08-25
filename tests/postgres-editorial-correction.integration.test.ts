import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture } from "../src/shared/milestone-three.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { PostgresMilestoneRepository } from "../src/server/persistence/postgres-repository.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";
import { seedReferenceFixtures } from "./helpers/seed-references.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

const handoff = {
  plane_ticket: "MOB-EC-PG",
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
  meta_title: "Designer chairs: a practical UK guide".padEnd(58, "x"),
  slug: "designer-chair-guide",
  meta_description: "A practical guide.".padEnd(152, "."),
  og_title: "Designer chair",
  og_description: "A practical guide.",
  images: [],
  faqs: [],
  markdown: "# Designer chair\n\nA short answer.\n\n## Conclusion\n\nChoose carefully.",
  claims: [],
};

/** The correction findings the planner would produce; content is never invented here. */
const correctionFindings = [
  {
    stable_key: "editorial-correction:det_title",
    category: "deterministic",
    rule_reference: "on_page.title.complete",
    severity: "blocker" as const,
    location: { field: "on_page.meta_title" },
    issue: "meta title ends with a dangling connector or preposition.",
    suggested_fix: "Complete the title at the editorial boundary.",
    hard_flag: false,
  },
];

async function frozenRun(key: string) {
  const repository = new PostgresMilestoneRepository(pool!);
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
  const current = (
    await pool!.query(
      "select id,content_hash from document_versions where run_id=$1 order by revision desc limit 1",
      [run.run_id],
    )
  ).rows[0];
  // An existing frozen run has already been through review round 1. A
  // correction may only open once no round is still awaiting decisions, so the
  // fixture decides round 1 the way the operator already had. Rejecting leaves
  // the frozen version current, because the revision completes as a no-op.
  const pending = await repository.listFindings(run.run_id, {});
  if (pending.length > 0)
    await repository.submitDispositions(run.run_id, {
      document_version_id: current.id,
      idempotency_key: `${key}-round-1`,
      dispositions: pending.map((finding) => ({
        finding_id: finding.id,
        decision: "rejected" as const,
      })),
    });
  return { repository, run, current };
}

integration("PostgreSQL editorial correction rounds", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
    await seedReferenceFixtures(pool!);
  });
  afterAll(async () => pool?.end());

  it("opens round 2 without mutating round 1, and makes it the active operator queue", async () => {
    const { repository, run, current } = await frozenRun("ec-pg-open");
    const roundOne = (
      await pool!.query(
        "select id,membership_hash,finding_count,round from finding_review_sets where run_id=$1",
        [run.run_id],
      )
    ).rows[0];
    expect(roundOne.round).toBe(1);
    const roundOneMembers = (
      await pool!.query(
        "select finding_id from finding_review_set_members where review_set_id=$1 order by ordinal",
        [roundOne.id],
      )
    ).rows.map((row) => row.finding_id);

    const opened = await repository.openEditorialCorrectionRound({
      run_id: run.run_id,
      document_version_id: current.id,
      expected_content_hash: current.content_hash,
      checker_version: "2.0.0",
      findings: correctionFindings,
    });
    expect(opened).toMatchObject({ status: "opened", round: 2 });

    // Round 1 is byte-identical and still queryable: full auditability.
    const roundOneAfter = (
      await pool!.query(
        "select id,membership_hash,finding_count,round from finding_review_sets where id=$1",
        [roundOne.id],
      )
    ).rows[0];
    expect(roundOneAfter).toEqual(roundOne);
    expect(
      (
        await pool!.query(
          "select finding_id from finding_review_set_members where review_set_id=$1 order by ordinal",
          [roundOne.id],
        )
      ).rows.map((row) => row.finding_id),
    ).toEqual(roundOneMembers);
    expect(
      (
        await pool!.query("select count(*)::int c from finding_review_sets where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].c,
    ).toBe(2);

    // The operator queue is the correction round only.
    const queue = await repository.listFindings(run.run_id, {});
    expect(queue.map((finding) => finding.rule_reference)).toEqual(["on_page.title.complete"]);

    // Controlled reopening returned the run to the ordinary operator wait.
    expect(
      (await pool!.query("select status,current_step from runs where id=$1", [run.run_id])).rows[0],
    ).toEqual({
      status: "waiting",
      current_step: "findings_review",
    });
  });

  it("is idempotent across three calls and creates exactly one round", async () => {
    const { repository, run, current } = await frozenRun("ec-pg-idem");
    const request = {
      run_id: run.run_id,
      document_version_id: current.id,
      expected_content_hash: current.content_hash,
      checker_version: "2.0.0",
      findings: correctionFindings,
    };
    const first = await repository.openEditorialCorrectionRound(request);
    const second = await repository.openEditorialCorrectionRound(request);
    const third = await repository.openEditorialCorrectionRound(request);

    expect([first.status, second.status, third.status]).toEqual(["opened", "replayed", "replayed"]);
    expect(new Set([first.review_set_id, second.review_set_id, third.review_set_id]).size).toBe(1);
    expect(
      (
        await pool!.query("select count(*)::int c from finding_review_sets where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].c,
    ).toBe(2);
    expect(
      (
        await pool!.query(
          "select count(*)::int c from findings where run_id=$1 and stable_key like 'editorial-correction:%'",
          [run.run_id],
        )
      ).rows[0].c,
    ).toBe(1);
  });

  it("creates exactly one round under concurrent opens", async () => {
    const { repository, run, current } = await frozenRun("ec-pg-concurrent");
    const request = {
      run_id: run.run_id,
      document_version_id: current.id,
      expected_content_hash: current.content_hash,
      checker_version: "2.0.0",
      findings: correctionFindings,
    };
    const results = await Promise.allSettled([
      repository.openEditorialCorrectionRound(request),
      repository.openEditorialCorrectionRound(request),
      repository.openEditorialCorrectionRound(request),
    ]);
    // The run row lock serialises them; whichever lose either replay or fail
    // closed, but the database must hold exactly one correction round.
    expect(
      (
        await pool!.query(
          "select count(*)::int c from finding_review_sets where run_id=$1 and round>1",
          [run.run_id],
        )
      ).rows[0].c,
    ).toBe(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("fails closed with zero mutations on a content-hash conflict", async () => {
    const { repository, run, current } = await frozenRun("ec-pg-conflict");
    const before = (
      await pool!.query("select count(*)::int sets from finding_review_sets where run_id=$1", [
        run.run_id,
      ])
    ).rows[0].sets;
    const findingsBefore = (
      await pool!.query("select count(*)::int c from findings where run_id=$1", [run.run_id])
    ).rows[0].c;
    // The invariant is that the failed open changes nothing, so compare against
    // the state it started from rather than a hardcoded status.
    const statusBefore = (
      await pool!.query<{ status: string }>("select status from runs where id=$1", [run.run_id])
    ).rows[0]!.status;

    await expect(
      repository.openEditorialCorrectionRound({
        run_id: run.run_id,
        document_version_id: current.id,
        expected_content_hash: "f".repeat(64),
        checker_version: "2.0.0",
        findings: correctionFindings,
      }),
    ).rejects.toThrow(/content hash changed/i);

    expect(
      (
        await pool!.query("select count(*)::int sets from finding_review_sets where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].sets,
    ).toBe(before);
    expect(
      (await pool!.query("select count(*)::int c from findings where run_id=$1", [run.run_id]))
        .rows[0].c,
    ).toBe(findingsBefore);
    expect(
      (await pool!.query("select status from runs where id=$1", [run.run_id])).rows[0].status,
    ).toBe(statusBefore);
  });

  it("fails closed when the source is no longer the current document version", async () => {
    const { repository, run, current } = await frozenRun("ec-pg-version");
    await expect(
      repository.openEditorialCorrectionRound({
        run_id: run.run_id,
        document_version_id: "00000000-0000-4000-8000-000000000000",
        expected_content_hash: current.content_hash,
        checker_version: "2.0.0",
        findings: correctionFindings,
      }),
    ).rejects.toThrow(/no longer the current document version/i);
    expect(
      (
        await pool!.query("select count(*)::int c from finding_review_sets where run_id=$1", [
          run.run_id,
        ])
      ).rows[0].c,
    ).toBe(1);
  });

  it("matches the in-memory repository's observable behaviour", async () => {
    // Parity: the same sequence against both implementations must agree on
    // round numbering, status and the resulting operator queue.
    const { repository, run, current } = await frozenRun("ec-pg-parity");
    const pgOpened = await repository.openEditorialCorrectionRound({
      run_id: run.run_id,
      document_version_id: current.id,
      expected_content_hash: current.content_hash,
      checker_version: "2.0.0",
      findings: correctionFindings,
    });
    const pgQueue = (await repository.listFindings(run.run_id, {})).map((f) => f.rule_reference);

    const memory = new InMemoryMilestoneRepository();
    const memoryRun = await ingestHandoff(handoff, "ec-mem-parity", memory);
    await new MilestoneTwoOrchestrator(
      memory,
      new MockLinkDiscoverer(),
      new MockDraftProvider("draft-v1", draft),
    ).run(memoryRun.run_id);
    await new MilestoneThreeOrchestrator(memory, fixture, new MockReviewProvider("review-v1")).run(
      memoryRun.run_id,
    );
    const memoryCurrent = (await memory.getDraft(memoryRun.run_id))!;
    // Same precondition as the PostgreSQL fixture: round 1 already decided.
    const memoryPending = await memory.listFindings(memoryRun.run_id, {});
    if (memoryPending.length > 0)
      await memory.submitDispositions(memoryRun.run_id, {
        document_version_id: memoryCurrent.version.id,
        idempotency_key: "ec-mem-parity-round-1",
        dispositions: memoryPending.map((finding) => ({
          finding_id: finding.id,
          decision: "rejected" as const,
        })),
      });
    const memoryOpened = await memory.openEditorialCorrectionRound({
      run_id: memoryRun.run_id,
      document_version_id: memoryCurrent.version.id,
      expected_content_hash: memoryCurrent.version.content_hash,
      checker_version: "2.0.0",
      findings: correctionFindings,
    });
    const memoryQueue = (await memory.listFindings(memoryRun.run_id, {})).map(
      (f) => f.rule_reference,
    );

    expect(memoryOpened.status).toBe(pgOpened.status);
    expect(memoryOpened.round).toBe(pgOpened.round);
    expect(memoryQueue).toEqual(pgQueue);
    expect((await memory.getRunDetail(memoryRun.run_id)).status).toBe("waiting");
  });
});

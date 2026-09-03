import { describe, expect, it, vi } from "vitest";
import { ingestHandoff, stableId } from "../src/shared/milestone-two.js";
import type { DeterministicFixture, ReviewFinding } from "../src/shared/milestone-three.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import {
  MilestoneFourOrchestrator,
  REVISION_PROMPT_VERSION,
  revisionOperationId,
} from "../src/server/milestone-four-orchestrator.js";
import {
  READABILITY_SELECTOR_VERSION,
  REVISION_BINDING_VERSION,
  REVISION_PLANNING_VERSION,
  bindRevisionFindingsWithAuthority,
  planRevisionRequest,
} from "../src/shared/revision-planning.js";
import { bindExceptionalBlockers } from "../src/shared/exceptional-recovery.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../src/server/providers/milestone-four-providers.js";
import { createApp } from "../src/server/app.js";
import {
  assertCoherenceBlockerEligibility,
  assertSafeRevision,
  CoherenceRequestSchema,
} from "../src/shared/milestone-four.js";
import type { RevisionFinding, RevisionRequest } from "../src/shared/milestone-four.js";
import request from "supertest";
import { logger } from "../src/server/logger.js";
import {
  ChatCompletionRevisionProvider,
  RevisionProviderError,
} from "../src/server/providers/chat-completion-revision-provider.js";

const handoff = {
  plane_ticket: "MOB-M4",
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
const words = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index > 0 && index % 10 === 0 ? "plain. Plain" : "plain",
  ).join(" ");
const productLink = {
  url: "https://www.mobelaris.com/en/designer-chair",
  title: "Designer chair",
  relevance: 1,
};
const fixture: DeterministicFixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [
    { url: productLink.url, status: 200, hierarchy: "product", hierarchy_rank: 4 },
  ],
};
const draft = {
  title: "Designer chair guide".padEnd(55, "x"),
  slug: "designer-chair-guide",
  meta_description: "Designer chair guidance".padEnd(150, "x"),
  og_title: "Designer chair",
  og_description: "Designer chair guidance",
  images: [
    {
      alt: "Designer chair",
      filename: "designer-chair.jpg",
      placement: { marker: "designer-chair" },
    },
  ],
  faqs: [1, 2, 3].map((number) => ({ question: `Question ${number}`, answer: words(40) })),
  markdown: [
    "# Designer chair guide",
    "<!-- MOBELARIS_IMAGE:designer-chair -->",
    `Designer chair ${words(38)}`,
    "## Key Takeaways",
    "- Fit matters",
    "- Comfort matters",
    "- Materials matter",
    "## How a designer chair fits your room",
    `Modern seating works with a [designer chair](${productLink.url}) when scale and use are clear.`,
    "> Measure your room first.",
    "## Conclusion",
    "Choose a designer chair that fits the room, use and comfort needs.",
  ].join("\n\n"),
  claims: [
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};
const blocker: ReviewFinding = {
  stable_key: "coherence-blocker",
  category: "inconsistency",
  rule_reference: "coherence.inconsistency",
  severity: "blocker",
  location: { field: "body_markdown" },
  issue: "The conclusion conflicts.",
  suggested_fix: "Align the conclusion.",
};

/**
 * The same product link as it is actually persisted by live Step 1.2 discovery:
 * verification, ranking and provenance metadata all populated. Mock discovery
 * omits every optional field, which is why an export that only ever saw mock
 * links can still be broken for real runs.
 */
const liveProductLink = {
  ...productLink,
  status: 200 as const,
  hierarchy: "product" as const,
  hierarchy_rank: 4,
  verified_at: "2026-08-23T10:00:00.000Z",
  verification_method: "head" as const,
  source: "sitemap" as const,
  keyword_overlap: 0.6,
  topical_score: 0.7,
  hierarchy_score: 0.8,
  gsc_score: 0,
  sitemap_url: "https://www.mobelaris.com/sitemap.xml",
  sitemap_last_modified: "2026-08-20T00:00:00.000Z",
  retrieved_at: "2026-08-23T10:00:00.000Z",
};

async function setup(link: Record<string, unknown> = productLink, seedDraft: typeof draft = draft) {
  const repository = new InMemoryMilestoneRepository();
  const run = await ingestHandoff(handoff, `m4-${Math.random()}`, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([link as typeof productLink]),
    // Seeding through the draft provider keeps the Step 1.4 frozen manifest and
    // the persisted artefact consistent with each other.
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
    idempotency_key: "test-disposition-milestone-four.test-0",
    dispositions: findings.map((finding, index) => ({
      finding_id: finding.id,
      // Step 1.10 now fails broad Markdown authority closed; keep this fixture's
      // intentionally broad readability review out of the accepted set.
      decision:
        index === 0 ||
        ((finding.location.field === "body_markdown" || finding.location.field === "markdown") &&
          !finding.location.section &&
          !finding.location.line_start)
          ? ("rejected" as const)
          : ("accepted" as const),
    })),
  });
  return { repository, run };
}

/**
 * A deterministic blocker that no correction route can resolve: a meta
 * description below the deterministic shortening band, which the allowlisted
 * planner refuses and which never reaches the model. It drives a run to the
 * two-cycle cap the way a genuinely unrepairable article does, rather than
 * relying on an introduced blocker that the candidate preflight now reverts
 * before it can persist.
 */
function makeUnrepairable(draft: { meta_description: string }) {
  draft.meta_description = "A".repeat(120);
}

describe("milestone four", () => {
  it("requires markdown locator XOR and exact structured-field coherence locators", () => {
    const base = {
      operation_id: "coherence-op",
      run_id: "run",
      parent_document_version_id: "parent",
      document_version_id: "current",
      revision_reason: "operator_findings" as const,
      coherence_cycle: 0,
      handoff,
      parent_document: draft,
      current_document: draft,
      revision_audits: [],
      deterministic_result_hash: "a".repeat(64),
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.final_coherence" as const, template_version: "1.0.0" },
      model: "coherence-v1",
      temperature: 0,
    };
    const coherenceBlocker = {
      stable_key: "coherence-blocker",
      category: "inconsistency" as const,
      rule_reference: "coherence.inconsistency" as const,
      severity: "blocker" as const,
      issue: "The conclusion conflicts.",
      suggested_fix: "Align the conclusion.",
    };
    const finding = {
      ...coherenceBlocker,
      location: { field: "body_markdown", line_start: 1, section: "Conclusion" },
    };
    expect(() =>
      assertCoherenceBlockerEligibility(base, {
        findings: [finding],
        usage: { input_units: 0, output_units: 0, cost_micros: 0 },
      }),
    ).toThrow("exactly one precise locator");
    expect(() =>
      assertCoherenceBlockerEligibility(base, {
        findings: [{ ...coherenceBlocker, location: { field: "title", line_start: 1 } }],
        usage: { input_units: 0, output_units: 0, cost_micros: 0 },
      }),
    ).toThrow("exact field locator");
  });

  it("allows an exact changed field under the canonical on_page root", () => {
    const request = {
      operation_id: "coherence-on-page",
      run_id: "run",
      parent_document_version_id: "parent",
      document_version_id: "current",
      revision_reason: "operator_findings" as const,
      coherence_cycle: 0,
      handoff,
      parent_document: draft,
      current_document: draft,
      revision_audits: [
        {
          finding_id: "faq-finding",
          status: "applied" as const,
          reason: "Applied.",
          location: { field: "on_page.faqs.0.answer" },
          hunks: [],
          changed: true,
          before_hash: "a".repeat(64),
          after_hash: "b".repeat(64),
        },
      ],
      deterministic_result_hash: "c".repeat(64),
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.final_coherence" as const, template_version: "2.3.0" },
      model: "coherence-v1",
      temperature: 0,
    };
    expect(() =>
      assertCoherenceBlockerEligibility(request, {
        findings: [
          {
            stable_key: "faq-coherence",
            category: "broken_messaging",
            rule_reference: "coherence.broken_messaging",
            severity: "warning",
            location: { field: "on_page.faqs.0.answer" },
            issue: "The revised answer is unclear.",
            suggested_fix: "Clarify the revised answer.",
          },
        ],
        usage: { input_units: 0, output_units: 0, cost_micros: 0 },
      }),
    ).not.toThrow();
  });

  it.each(["warning", "info"] as const)(
    "rejects a %s finding in neighbour-only pre-existing text",
    (severity) => {
      const request = {
        operation_id: "coherence-neighbour-op",
        run_id: "run",
        parent_document_version_id: "parent",
        document_version_id: "current",
        revision_reason: "operator_findings" as const,
        coherence_cycle: 0,
        handoff,
        parent_document: draft,
        current_document: draft,
        revision_audits: [
          {
            finding_id: "revision-1",
            status: "applied" as const,
            reason: "Changed one paragraph.",
            location: { field: "body_markdown", line_start: 5 },
            hunks: [
              {
                source_start: 5,
                source_end: 5,
                proposed_start: 5,
                proposed_end: 5,
                before_hash: "a".repeat(64),
                after_hash: "b".repeat(64),
              },
            ],
            changed: true,
            before_hash: "a".repeat(64),
            after_hash: "b".repeat(64),
          },
        ],
        deterministic_result_hash: "c".repeat(64),
        reference_snapshots: [],
        prompt: { template_id: "mobelaris.final_coherence" as const, template_version: "2.0.0" },
        model: "coherence-v1",
        temperature: 0,
      };
      expect(() =>
        assertCoherenceBlockerEligibility(request, {
          findings: [
            {
              stable_key: `neighbour-${severity}`,
              category: "grammar",
              rule_reference: "coherence.grammar",
              severity,
              location: { field: "body_markdown", line_start: 4, line_end: 4 },
              issue: "Pre-existing neighbour text issue.",
              suggested_fix: "Do not attribute this to the revision.",
            },
          ],
          usage: { input_units: 0, output_units: 0, cost_micros: 0 },
        }),
      ).toThrow("does not intersect an exact persisted changed hunk");
    },
  );

  it("guards the new draft-owned on-page fields during revision", () => {
    const handoffContext = {
      operation_id: "op",
      run_id: "r",
      document_version_id: "v1",
      revision: 1,
      handoff,
      current_document: draft,
      accepted_findings: [],
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.revision_pass" as const, template_version: "1.0.0" },
      model: "revision-v1",
      temperature: 0,
    };
    expect(() => assertSafeRevision(handoffContext, draft)).not.toThrow();
    expect(() =>
      assertSafeRevision(handoffContext, {
        ...draft,
        og_title: "Another OG title entirely",
      }),
    ).toThrow("Revision altered og_title without an accepted finding");
    expect(() => assertSafeRevision(handoffContext, { ...draft, faqs: [] })).toThrow(
      "Revision altered faqs without an accepted finding",
    );
    const accepted: RevisionFinding = {
      stable_key: "accepted-og",
      category: "deterministic",
      rule_reference: "mock.rule",
      severity: "warning",
      location: { field: "og_title" },
      issue: "OG title must change.",
      suggested_fix: "Rewrite the OG title.",
      id: "finding-1",
      disposition: "accepted",
      origin_document_version_id: "v1",
    };
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [accepted] },
        { ...draft, og_title: "Another OG title entirely" },
      ),
    ).not.toThrow();
  });
  it("authorises the mirroring OG field when the meta counterpart finding is accepted", () => {
    const handoffContext = {
      operation_id: "op",
      run_id: "r",
      document_version_id: "v1",
      revision: 1,
      handoff,
      current_document: draft,
      accepted_findings: [],
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.revision_pass" as const, template_version: "1.0.0" },
      model: "revision-v1",
      temperature: 0,
    };
    // The exact deadlock shape from the live run: a meta_description finding
    // (the only kind 1.4 can emit) authorises the mirrored og_description fix.
    const metaFinding: RevisionFinding = {
      stable_key: "meta-desc-length",
      category: "on_page_metadata",
      rule_reference: "on_page.meta_description.length",
      severity: "blocker",
      location: { field: "on_page.meta_description" },
      issue: "meta description is 35 characters; required range is 150–155.",
      suggested_fix: "Rewrite the meta description to the required range.",
      id: "finding-meta",
      disposition: "accepted",
      origin_document_version_id: "v1",
    };
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [metaFinding] },
        {
          ...draft,
          meta_description: "A rewritten, in-range meta description for the blog post.",
          // Narrow mirroring requires the source pair to have been mirrored already.
          og_description: draft.og_description,
        },
      ),
    ).not.toThrow();
    // The mirror authority does NOT leak: og_title stays guarded without a title finding.
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [metaFinding] },
        { ...draft, og_title: "Unrelated OG title change" },
      ),
    ).toThrow("Revision altered og_title without an accepted finding");
  });
  it("accepts checker on_page.* finding locations for guarded draft fields", () => {
    const handoffContext = {
      operation_id: "op",
      run_id: "r",
      document_version_id: "v1",
      revision: 1,
      handoff,
      current_document: draft,
      accepted_findings: [],
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.revision_pass" as const, template_version: "1.0.0" },
      model: "revision-v1",
      temperature: 0,
    };
    // Real checker-produced shapes: on_page-prefixed paths including array indices.
    const onPageFinding = (field: string): RevisionFinding => ({
      stable_key: `finding-${field}`,
      category: "on_page_metadata",
      rule_reference: "on_page.populated",
      severity: "warning",
      location: { field },
      issue: "Field needs revision.",
      suggested_fix: "Revise the field.",
      id: `id-${field}`,
      disposition: "accepted",
      origin_document_version_id: "v1",
    });
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page.og_title")] },
        { ...draft, og_title: "Another OG title entirely" },
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page.og_description")] },
        { ...draft, og_description: "Another OG description entirely" },
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page.faqs.2.question")] },
        {
          ...draft,
          faqs: draft.faqs.map((faq, index) =>
            index === 2 ? { ...faq, question: "Revised question three?" } : faq,
          ),
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page.images.0.alt")] },
        {
          ...draft,
          images: draft.images.map((image, index) =>
            index === 0 ? { ...image, alt: "Revised alt text" } : image,
          ),
        },
      ),
    ).not.toThrow();
    // Fail-safe: guarded-prefix locations that are not guarded fields (and not
    // meta counterparts mirroring into OG) authorise nothing.
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page.slug")] },
        { ...draft, og_title: "Another OG title entirely" },
      ),
    ).toThrow("Revision altered og_title without an accepted finding");
    expect(() =>
      assertSafeRevision(
        { ...handoffContext, accepted_findings: [onPageFinding("on_page")] },
        { ...draft, faqs: [] },
      ),
    ).toThrow("Revision altered faqs without an accepted finding");
  });
  it("logs ordered revision and coherence provider lifecycles once without secrets", async () => {
    const { repository, run } = await setup();
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const lifecycle = lines
      .filter((line) => line.startsWith("{"))
      .map(
        (line) => JSON.parse(line) as { event: string; context?: string; operation_id?: string },
      );
    const expected = [
      "provider.reserved",
      "provider.dispatch_started",
      "provider.returned",
      "provider.response_validated",
      "provider.checkpointed",
      "provider.persistence_completed",
    ];
    const revisions = lifecycle.filter((entry) => entry.context === "revision");
    const revisionIds = [...new Set(revisions.map((entry) => entry.operation_id))];
    expect(revisionIds.length).toBeGreaterThan(0);
    for (const operationId of revisionIds) {
      const events = revisions
        .filter((entry) => entry.operation_id === operationId)
        .map((entry) => entry.event);
      expect(events).toEqual(expected);
      for (const event of expected) expect(events.filter((item) => item === event)).toHaveLength(1);
    }
    const coherence = lifecycle.filter((entry) => entry.context === "coherence");
    expect(coherence.filter((entry) => entry.event === "provider.response_validated")).toHaveLength(
      1,
    );
    expect(coherence.filter((entry) => entry.event === "provider.checkpointed")).toHaveLength(1);
    expect(
      coherence.findIndex((entry) => entry.event === "provider.response_validated"),
    ).toBeLessThan(coherence.findIndex((entry) => entry.event === "provider.checkpointed"));
    expect(lines.join("\n")).not.toContain("It measures 80 cm");
    expect(lines.join("\n")).not.toContain("unconfirmed");
    write.mockRestore();
  });

  it("passes only accepted findings, creates immutable lineage, reruns checks and exports idempotently", async () => {
    const { repository, run } = await setup();
    const revisions = new MockRevisionProvider("revision-v1");
    const coherence = new MockCoherenceProvider("coherence-v1");
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      revisions,
      coherence,
      repository,
    );
    await orchestrator.run(run.run_id);
    const current = (await repository.getDraft(run.run_id))!;
    expect(current.version.revision).toBe(2);
    expect(current.version.parent_id).toBe(repository.documentVersions[0]!.id);
    expect(current.artifact.parent_id).toBe(
      repository.artifacts.find((item) => item.kind === "draft")!.id,
    );
    expect(
      revisions.calls[0]!.accepted_findings.every((finding) => finding.disposition === "accepted"),
    ).toBe(true);
    expect(
      revisions.calls[0]!.accepted_findings.some(
        (finding) =>
          repository.dispositions.find((d) => d.finding_id === finding.id)?.decision === "rejected",
      ),
    ).toBe(false);
    // A clean rerun may legitimately emit zero findings; its durable step
    // output, rather than a forced informational finding, proves it ran.
    expect(
      await repository.hasStepOutput(run.run_id, current.version.id, "automated_checks_rerun"),
    ).toBe(true);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "succeeded",
      block_reason: "unknown",
    });
    expect(repository.exports).toHaveLength(1);
    expect((await repository.getUsageTotals(run.run_id)).cost_micros).toBeGreaterThan(0);
  });

  it("fences identical Step 1.11 replay while preserving active observational idempotency", async () => {
    const { repository, run } = await setup();
    const originalSaveRerun = repository.saveRerun.bind(repository);
    let persistedInput: Parameters<typeof repository.saveRerun>[0] | undefined;
    repository.saveRerun = async (input) => {
      persistedInput = structuredClone(input);
      return originalSaveRerun(input);
    };
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const stale = persistedInput!;
    await expect(originalSaveRerun(stale)).rejects.toThrow("Stale fencing token");

    const replay = await repository.claimStep(
      run.run_id,
      "automated_checks_rerun",
      "active-replay",
      true,
    );
    await expect(
      originalSaveRerun({ ...stale, execution_id: replay.execution_id, token: replay.token }),
    ).resolves.toBe("continue");
    expect(repository.deterministicReruns.size).toBe(1);
  });

  it("clears a stale Step 1.11 block reason and advances after a clean rerun", async () => {
    const { repository, run } = await setup();
    const originalSaveRerun = repository.saveRerun.bind(repository);
    repository.saveRerun = async (input) => {
      // Reproduce a stale persisted reason at the exact transition under test,
      // after claiming Step 1.11 has already performed its normal reset.
      (repository as any).runs.get(run.run_id).blockReason = "deterministic_blockers";
      return originalSaveRerun(input);
    };
    const failures = {
      async hit(boundary: string) {
        if (boundary === "after_rerun_persist") throw new Error("stop after Step 1.11");
      },
    };
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
      failures,
    );

    await expect(orchestrator.run(run.run_id)).rejects.toThrow("stop after Step 1.11");

    const detail = await repository.getRunDetail(run.run_id);
    expect(detail).toMatchObject({
      status: "running",
      current_step: "final_coherence_export",
      block_reason: "unknown",
      block_counts: { deterministic_blockers: 0, coherence_blockers: 0 },
    });
    expect(detail.steps.find((step) => step.step === "automated_checks_rerun")?.status).toBe(
      "succeeded",
    );
  });

  it("exports a run whose links carry live Step 1.2 verification and provenance metadata", async () => {
    // Regression: the export render input is strict at {url,title,relevance}, so
    // passing persisted live links straight through failed 1.12 at export_render
    // with an unrecognized_keys error — after every model step had already run.
    const { repository, run } = await setup(liveProductLink);
    const persisted = (await repository.getLinks(run.run_id))!;
    expect(Object.keys(persisted[0]!).length).toBeGreaterThan(3);

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    expect(await repository.getRunDetail(run.run_id)).toMatchObject({ status: "succeeded" });
    expect(repository.exports).toHaveLength(1);
  });

  it("records a post-batch structural export failure as google_structure, not google_api", async () => {
    // Google accepted the batch and only the read-back verification failed, so
    // Step 1.12 must not classify it as an API/connection problem.
    const { repository, run } = await setup();
    const failingExport = {
      export: async () => {
        throw new Error("Google Docs export structure mismatch.");
      },
    };
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      failingExport as never,
    )
      .run(run.run_id)
      .catch(() => undefined);

    const detail = await repository.getRunDetail(run.run_id);
    const failed = detail.steps.find((step) => step.step === "final_coherence_export");
    expect(failed?.error).toContain("category=google_structure");
    expect(failed?.error).not.toContain("category=google_api");
    expect(repository.exports).toHaveLength(0);
  });

  it("preserves a typed Google Docs idempotency conflict instead of flattening it to export", async () => {
    const { repository, run } = await setup();
    const conflict = Object.assign(new Error("Export idempotency conflict"), {
      reason: "reserved_document_not_exact_prefix",
    });
    const failingExport = {
      export: async () => {
        throw conflict;
      },
    };
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      failingExport as never,
    )
      .run(run.run_id)
      .catch(() => undefined);

    const detail = await repository.getRunDetail(run.run_id);
    const failed = detail.steps.find((step) => step.step === "final_coherence_export");
    expect(failed?.error).toContain("category=idempotency_conflict");
    expect(failed?.error).toContain("reason=reserved_document_not_exact_prefix");
    expect(failed?.error).not.toContain("category=export");
    expect(failed?.error).not.toContain("category=google_api");
    expect(repository.exports).toHaveLength(0);
  });

  it("repairs a safe Step 1.11 title-length blocker with code only, then exports", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.title = `${current.draft.title} unnecessary trailing words`;
    const revisions = new MockRevisionProvider("revision-v1");
    const frozenSet = structuredClone(repository.findingReviewSets);
    const frozenDispositions = structuredClone(repository.dispositions);

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      revisions,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const detail = await repository.getRunDetail(run.run_id);
    expect(detail).toMatchObject({
      status: "succeeded",
      deterministic_repair_cycles: 1,
      block_counts: { deterministic_blockers: 0 },
    });
    expect(revisions.calls).toHaveLength(1);
    expect(repository.revisionRequests.map((item) => item.revision_source)).toEqual([
      "operator_findings",
      "deterministic_repair",
    ]);
    expect(repository.exports).toHaveLength(1);
    expect(repository.findingReviewSets).toEqual(frozenSet);
    expect(repository.dispositions).toEqual(frozenDispositions);
  });

  it("repairs the exact persisted near-range meta-description blocker without a second model call", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.meta_description = "A".repeat(148);
    const calls: RevisionFinding[][] = [];
    const scoped = {
      provider: "scoped-local",
      model: "revision-v1",
      async revise(request: Parameters<MockRevisionProvider["revise"]>[0]) {
        calls.push(structuredClone(request.accepted_findings));
        const isRepair = request.revision_source === "deterministic_repair";
        return {
          document: {
            ...request.current_document,
            ...(isRepair
              ? { meta_description: request.current_document.meta_description.slice(0, 155) }
              : {}),
          },
          finding_results: request.accepted_findings.map((finding) => ({
            finding_id: finding.id,
            status: "applied" as const,
            reason: "Applied only at the supplied location.",
          })),
          usage: { input_units: 1, output_units: 1, cost_micros: 1 },
        };
      },
    };
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      scoped,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    expect(calls).toHaveLength(1);
    expect(repository.revisionRequests.at(-1)?.accepted_findings).toHaveLength(1);
    expect(repository.revisionRequests.at(-1)?.accepted_findings[0]).toMatchObject({
      rule_reference: "on_page.meta_description.length",
      severity: "blocker",
      disposition: "accepted",
    });
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
    expect(repository.exports).toHaveLength(1);
  });

  it("hard-blocks unresolved step 1.11 blockers after two repair cycles while ignoring the current fixture", async () => {
    const { repository, run } = await setup();
    const coherence = new MockCoherenceProvider("coherence-v1");
    const currentFixtureMustBeIgnored = { ...fixture, link_verification: [] };
    makeUnrepairable((await repository.getDraft(run.run_id))!.draft);
    await new MilestoneFourOrchestrator(
      repository,
      currentFixtureMustBeIgnored,
      new MockRevisionProvider("revision-v1"),
      coherence,
      repository,
    ).run(run.run_id);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "blocked",
      current_step: "automated_checks_rerun",
      deterministic_repair_cycles: 2,
      blocked_for_operator: true,
      block_reason: "deterministic_blockers",
      block_counts: { deterministic_blockers: 1, coherence_blockers: 0 },
      deterministic_blocker_details: [
        {
          rule_reference: "on_page.meta_description.length",
          issue: expect.any(String),
          location: expect.objectContaining({ field: "on_page.meta_description" }),
          suggested_fix: expect.any(String),
        },
      ],
    });
    // The reason is authoritative state, while evidence counts are calculated independently.
    repository.deterministicReruns.clear();
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      block_reason: "deterministic_blockers",
      block_counts: { deterministic_blockers: 0, coherence_blockers: 0 },
    });
    expect(coherence.calls).toHaveLength(0);
    expect(repository.exports).toHaveLength(0);
  });

  it("rejects a blocker that does not overlap an actually changed revision location", async () => {
    const { repository, run } = await setup();
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1", [[blocker]]),
      repository,
    );
    await expect(orchestrator.run(run.run_id)).rejects.toThrow(
      "Coherence finding requires exactly one precise locator",
    );
    expect((await repository.getRunDetail(run.run_id)).coherence_return_cycles).toBe(0);
    expect(repository.exports).toHaveLength(0);
  });

  it("persists and maps claim guard rejection safely, while retaining the guard defence", async () => {
    const { repository, run } = await setup();
    const unsafe = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      claims: [
        ...request.current_document.claims,
        { text: "Costs £500", type: "price", status: "unverified" },
      ],
    }));
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      unsafe,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    );
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const app = createApp({
      testOnlySynchronousPipeline: true,
      serveClient: false,
      milestoneFour: { repository, orchestrator },
    });

    const response = await request(app)
      .post(`/api/runs/${run.run_id}/milestone-four/resume`)
      .set("Idempotency-Key", "milestone-four-command-key");

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: "UNPROCESSABLE_ENTITY",
        message: "Revision introduced, removed or altered an unsupported factual claim",
      },
    });
    const detail = await repository.getRunDetail(run.run_id);
    expect(detail.status).toBe("retryable_failed");
    expect(detail.steps.find((step) => step.step === "revision_pass")?.error).toBe(
      "Revision introduced, removed or altered an unsupported factual claim",
    );
    expect(warning).toHaveBeenCalledWith("revision.guard_rejected", {
      reason: "claims_changed",
      run_id: run.run_id,
      document_version_id: expect.any(String),
      code: "REVISION_GUARD_REJECTED",
      retryable: true,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("Costs £500");
    await expect(
      (new MockCoherenceProvider("coherence-v1") as any).review({ prose: "rewritten copy" }),
    ).rejects.toThrow();
  });

  it("matches PostgreSQL lock parity by requiring two failures in one safe category", async () => {
    const { repository, run } = await setup();
    const identity = {
      provider: "test-provider",
      model: "test-model",
      prompt_version: "2.0.0",
      planning_version: "1.0.0",
    };
    repository.revisionFailures.push(
      {
        run_id: run.run_id,
        execution_id: "mixed-1",
        operation_id: "mixed-op-1",
        identity,
        category: "malformed_response",
      },
      {
        run_id: run.run_id,
        execution_id: "mixed-2",
        operation_id: "mixed-op-2",
        identity,
        category: "timeout",
      },
    );
    await expect(repository.getRevisionFailureLock(run.run_id, identity)).resolves.toBeNull();
    repository.revisionFailures.push({
      run_id: run.run_id,
      execution_id: "mixed-3",
      operation_id: "mixed-op-3",
      identity,
      category: "timeout",
    });
    await expect(repository.getRevisionFailureLock(run.run_id, identity)).resolves.toEqual({
      category: "timeout",
      failures: 2,
    });
  });

  it.each(["deterministic", "unsafe"] as const)(
    "does not consult provider lockout or call the model for %s-only revisions",
    async (route) => {
      const { repository, run } = await setup();
      const current = (await repository.getDraft(run.run_id))!;
      const reviewSet = repository.findingReviewSets.find((set) => set.run_id === run.run_id)!;
      const selected = repository.findings.find(
        (finding) => finding.id === reviewSet.finding_ids[0],
      )!;
      for (const disposition of repository.dispositions) disposition.decision = "rejected";
      repository.dispositions.find((item) => item.finding_id === selected.id)!.decision =
        "accepted";
      selected.category = "deterministic";
      selected.severity = "warning";
      if (route === "deterministic") {
        current.draft.markdown += "\n\nOur favorite finish suits this chair.";
        selected.rule_reference = "style.british_english_provisional";
        selected.location = {
          field: "body_markdown",
          line_start: current.draft.markdown.split("\n").length,
        };
      } else {
        selected.rule_reference = "unsafe.server_owned";
        selected.location = { field: "claims" };
      }
      const lockLookup = vi.spyOn(repository, "getRevisionFailureLock");
      const revisions = new MockRevisionProvider("revision-v1");

      await new MilestoneFourOrchestrator(
        repository,
        fixture,
        revisions,
        new MockCoherenceProvider("coherence-v1"),
        repository,
      ).run(run.run_id);

      expect(lockLookup).not.toHaveBeenCalled();
      expect(revisions.calls).toHaveLength(0);
    },
  );

  it("retains deterministic edits when every subjective result is safely unable and still runs Step 1.11", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.markdown += "\n\nOur favorite finish suits this designer chair.";
    const reviewSet = repository.findingReviewSets.find((set) => set.run_id === run.run_id)!;
    const selected = reviewSet.finding_ids
      .slice(0, 2)
      .map((id) => repository.findings.find((finding) => finding.id === id)!);
    for (const disposition of repository.dispositions) disposition.decision = "rejected";
    for (const finding of selected)
      repository.dispositions.find((item) => item.finding_id === finding.id)!.decision = "accepted";
    selected[0]!.category = "deterministic";
    selected[0]!.rule_reference = "style.british_english_provisional";
    selected[0]!.location = {
      field: "body_markdown",
      line_start: current.draft.markdown.split("\n").length,
    };
    selected[1]!.category = "style";
    selected[1]!.rule_reference = "style.clarity";
    selected[1]!.location = { field: "title" };
    let calls = 0;
    const safelyUnable = {
      provider: "http-200-fallback",
      model: "compact-v2",
      async revise(request: Parameters<MockRevisionProvider["revise"]>[0]) {
        calls += 1;
        expect(request.accepted_findings.map((finding) => finding.id)).toEqual([selected[1]!.id]);
        return {
          document: request.current_document,
          finding_results: request.accepted_findings.map((finding) => ({
            finding_id: finding.id,
            status: "unable" as const,
            reason: "The model response could not be used safely.",
          })),
          usage: { input_units: 12, output_units: 4, cost_micros: 1 },
        };
      },
    };
    const coherence = new MockCoherenceProvider("coherence-v1");
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      safelyUnable,
      coherence,
      repository,
    ).run(run.run_id);

    const revised = (await repository.getDraft(run.run_id))!;
    expect(revised.draft.markdown).toContain("Our favourite finish");
    expect(revised.version.revision).toBe(2);
    expect(calls).toBe(1);
    expect(repository.revisionFailures).toHaveLength(0);
    expect(
      await repository.hasStepOutput(run.run_id, revised.version.id, "automated_checks_rerun"),
    ).toBe(true);
    expect(coherence.calls).toHaveLength(1);
    const responseArtifact = repository.artifacts.find(
      (artifact) => artifact.kind === "revision_response" && artifact.run_id === run.run_id,
    )!;
    const persisted = JSON.parse(responseArtifact.body_text);
    expect(persisted.finding_results.map((result: { status: string }) => result.status)).toEqual([
      "applied",
      "unable",
    ]);
    expect(responseArtifact.body_text).not.toContain("unsafe upstream");

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      safelyUnable,
      coherence,
      repository,
    ).run(run.run_id);
    expect(calls).toBe(1);
    expect(repository.documentVersions).toHaveLength(2);
  });

  it("starts a new immutable revision after a provider/model switch and resumes its checkpoint idempotently", async () => {
    const { repository, run } = await setup();
    const hfCalls: RevisionFinding[][] = [];
    const huggingFace = {
      provider: "huggingface",
      model: "hf-revision-v1",
      async revise(request: Parameters<MockRevisionProvider["revise"]>[0]) {
        hfCalls.push(structuredClone(request.accepted_findings));
        throw new RevisionProviderError(
          "REVISION_PROVIDER_CONFIGURATION",
          "Revision provider configuration is invalid",
          "configuration",
        );
      },
    };

    await expect(
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        huggingFace,
        new MockCoherenceProvider("coherence-v1"),
        repository,
      ).run(run.run_id),
    ).rejects.toThrow("configuration is invalid");

    const failedOperationId = repository.revisionFailures[0]!.operation_id;
    const delegate = new MockRevisionProvider("openrouter-revision-v2");
    const openRouter = {
      provider: "openrouter",
      model: "openrouter-revision-v2",
      revise: delegate.revise.bind(delegate),
    };
    let crashOnce = true;
    await expect(
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        openRouter,
        new MockCoherenceProvider("coherence-v1"),
        repository,
        {
          hit(boundary) {
            if (crashOnce && boundary === "after_revision_provider") {
              crashOnce = false;
              throw new Error("checkpoint recovery probe");
            }
          },
        },
      ).run(run.run_id),
    ).rejects.toThrow("checkpoint recovery probe");

    expect(delegate.calls).toHaveLength(1);
    expect(delegate.calls[0]!.operation_id).not.toBe(failedOperationId);
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      openRouter,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      openRouter,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    expect(hfCalls).toHaveLength(1);
    expect(delegate.calls).toHaveLength(1);
    expect(repository.revisionFailures).toHaveLength(1);
    expect(repository.revisionFailures[0]!.operation_id).toBe(failedOperationId);
    expect(repository.revisionRequests).toHaveLength(1);
    expect(repository.documentVersions).toHaveLength(2);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
  });

  it("releases a revision model mismatch and safely retries the same operation", async () => {
    const { repository, run } = await setup();
    let providerCalls = 0;
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
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        mismatch,
        new MockCoherenceProvider("coherence-v1"),
        repository,
      ).run(run.run_id),
    ).rejects.toThrow("does not match");
    expect(fetcher).not.toHaveBeenCalled();

    const operationId = repository.revisionFailures[0]!.operation_id;
    expect((repository as any).outputKeys.get(`revision-state:${operationId}:status`)).toBe(
      "started",
    );
    expect((repository as any).outputKeys.get(`revision-state:${operationId}:release-reason`)).toBe(
      "configuration_before_dispatch",
    );
    expect((await repository.getRunDetail(run.run_id)).paid_operation_ambiguities).toEqual([]);

    const retry = new MockRevisionProvider("revision-v1");
    const countedRetry = {
      provider: mismatch.provider,
      model: mismatch.model,
      async revise(request: RevisionRequest) {
        providerCalls += 1;
        return retry.revise(request);
      },
    };
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      countedRetry,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    expect(providerCalls).toBe(1);
    expect(retry.calls).toHaveLength(1);
  });

  it("keeps a timed-out dispatched request reserved and gives safe resume guidance", async () => {
    const { repository, run } = await setup();
    let calls = 0;
    const timeoutAfterDispatch = {
      provider: "test-provider",
      model: "test-model",
      async revise() {
        calls += 1;
        throw new RevisionProviderError(
          "REVISION_PROVIDER_TIMEOUT",
          "Revision provider request timed out",
          "timeout",
        );
      },
    };
    const make = () =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        timeoutAfterDispatch,
        new MockCoherenceProvider("coherence-v1"),
        repository,
      );

    await expect(make().run(run.run_id)).rejects.toThrow("timed out");
    await expect(make().run(run.run_id)).rejects.toThrow(
      "outcome is ambiguous; no duplicate call was made",
    );
    expect(calls).toBe(1);
  });

  it("fails closed across the exact provider-return/checkpoint crash gap", async () => {
    const { repository, run } = await setup();
    const provider = new MockRevisionProvider("revision-v1");
    let crash = true;
    const make = (failures?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5]) =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        provider,
        new MockCoherenceProvider("coherence-v1"),
        repository,
        failures,
      );

    await expect(
      make({
        hit(boundary) {
          if (crash && boundary === "after_revision_provider_return") {
            crash = false;
            throw new Error("crash after provider return before checkpoint");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after provider return before checkpoint");
    expect(provider.calls).toHaveLength(1);

    await expect(make().run(run.run_id)).rejects.toThrow("outcome is ambiguous");
    expect(provider.calls).toHaveLength(1);
    const detail = await repository.getRunDetail(run.run_id);
    expect(detail.status).toBe("retryable_failed");
    expect(detail.paid_operation_ambiguities).toEqual([
      expect.objectContaining({
        kind: "revision",
        owner: expect.stringMatching(/^step_execution:/),
      }),
    ]);
  });

  it("recovers only a block backed by the current persisted rerun and its blocker", async () => {
    const { repository, run } = await setup();
    makeUnrepairable((await repository.getDraft(run.run_id))!.draft);
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    const state = (repository as any).runs.get(run.run_id);
    expect(state.status).toBe("blocked");
    // Representative legacy state: budget was not incremented even though Step 1.11 and
    // its exact blocker were persisted for the latest immutable document.
    state.deterministicRepairCycles = 0;
    const revisions = new MockRevisionProvider("revision-v1");
    const app = createApp({
      testOnlySynchronousPipeline: true,
      serveClient: false,
      milestoneFour: {
        repository,
        orchestrator: new MilestoneFourOrchestrator(
          repository,
          fixture,
          revisions,
          new MockCoherenceProvider("coherence-v1"),
          repository,
        ),
      },
    });

    expect((await repository.getRunDetail(run.run_id)).can_recover_deterministic_block).toBe(true);
    expect(
      (
        await request(app)
          .post(`/api/runs/${run.run_id}/milestone-four/resume`)
          .set("Idempotency-Key", "milestone-four-command-key")
      ).status,
    ).toBe(200);
    expect(repository.documentVersions.length).toBeGreaterThan(1);
    expect(repository.findingReviewSets).toHaveLength(1);

    state.status = "blocked";
    state.blockReason = "deterministic_blockers";
    state.deterministicRepairCycles = 0;
    repository.deterministicReruns.clear();
    await expect(repository.recoverDeterministicBlock(run.run_id)).resolves.toBe(false);
    await expect(
      repository.getRevisionFindings(run.run_id, state.draft.version.id),
    ).rejects.toThrow("evidence is missing");
  });

  it("refuses a capped blocker when the canonical correction plan is unable", async () => {
    const { repository, run } = await setup();
    makeUnrepairable((await repository.getDraft(run.run_id))!.draft);
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    const state = (repository as any).runs.get(run.run_id);
    expect(state.deterministicRepairCycles).toBe(2);
    expect((await repository.getRunDetail(run.run_id)).exceptional_correction.available).toBe(
      false,
    );
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: `exceptional:${run.run_id}:unable`,
        explicit_confirmation: true,
      }),
    ).rejects.toThrow("Exceptional correction is not available for this exact document.");
    expect(repository.exceptionalCorrectionAuthorisations).toHaveLength(0);
  });

  it("does not retry an exception labelled malformed after dispatch", async () => {
    const { repository, run } = await setup();
    let calls = 0;
    const failing = {
      provider: "test-provider",
      model: "test-model",
      async revise() {
        calls += 1;
        throw new RevisionProviderError(
          "REVISION_PROVIDER_UNPARSEABLE",
          "Revision provider returned unparseable output",
          "malformed_response",
        );
      },
    };
    const make = () =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        failing,
        new MockCoherenceProvider("coherence-v1"),
        repository,
      );
    await expect(make().run(run.run_id)).rejects.toThrow(/unparseable/);
    await expect(make().run(run.run_id)).rejects.toThrow(/outcome is ambiguous/);
    expect(calls).toBe(1);
    expect(repository.revisionFailures.map((row) => row.category)).toEqual(["malformed_response"]);
  });

  it("returns the durable export failure when retry enqueue fails, while preserving invalid-retry 409s", async () => {
    const { repository, run } = await setup();
    const failingExport = {
      export: async () => {
        throw new Error("Google Docs export structure mismatch.");
      },
    };
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      failingExport as never,
    );
    await orchestrator.run(run.run_id).catch(() => undefined);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("retryable_failed");

    const persisted = await repository.getRunDetail(run.run_id);
    const exportFailure = {
      ...persisted,
      export: { status: "failed" as const, external_url: null },
    };
    const detailSpy = vi.spyOn(repository, "getRunDetail").mockResolvedValue(exportFailure);
    const enqueueRun = vi.fn(async () => {
      throw new Error("queue unavailable after durable export failure");
    });
    const app = createApp({
      serveClient: false,
      milestoneFour: { repository, orchestrator },
      queue: { enqueueRun } as never,
    });
    const durable = await request(app)
      .post(`/api/runs/${run.run_id}/export/retry`)
      .set("Idempotency-Key", "milestone-four-command-key");
    expect(durable.status).toBe(409);
    expect(durable.body).toMatchObject({
      error: { code: "CONFLICT", message: "The export is not available for retry." },
    });
    expect(enqueueRun).not.toHaveBeenCalled();

    for (const rejected of [
      { ...exportFailure, export: { status: "not_started" as const, external_url: null } },
      {
        ...exportFailure,
        steps: exportFailure.steps.map((step) =>
          step.step === "final_coherence_export"
            ? { ...step, error: "Coherence provider request failed at network level" }
            : step,
        ),
      },
      { ...exportFailure, current_step: "revision_pass" as const },
    ]) {
      detailSpy.mockResolvedValue(rejected);
      const invalid = await request(app)
        .post(`/api/runs/${run.run_id}/export/retry`)
        .set("Idempotency-Key", "milestone-four-command-key");
      expect(invalid.status).toBe(409);
      expect(invalid.body.error.code).toBe("CONFLICT");
    }
    expect(enqueueRun).not.toHaveBeenCalled();

    detailSpy
      .mockResolvedValueOnce(exportFailure)
      .mockResolvedValueOnce(exportFailure)
      .mockResolvedValue({
        ...exportFailure,
        export: { status: "not_started", external_url: null },
      });
    const nonExportFallback = await request(app)
      .post(`/api/runs/${run.run_id}/export/retry`)
      .set("Idempotency-Key", "milestone-four-command-key");
    expect(nonExportFallback.status).toBe(409);
  });

  it("serves typed detail and cost APIs", async () => {
    const { repository, run } = await setup();
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    );
    const app = createApp({
      testOnlySynchronousPipeline: true,
      serveClient: false,
      milestoneFour: { repository, orchestrator },
    });
    expect(
      (
        await request(app)
          .post(`/api/runs/${run.run_id}/milestone-four/resume`)
          .set("Idempotency-Key", "milestone-four-command-key")
      ).status,
    ).toBe(200);
    expect((await request(app).get(`/api/runs/${run.run_id}`)).body.steps).toEqual(
      expect.any(Array),
    );
    expect((await request(app).get(`/api/runs/${run.run_id}/costs`)).body).toMatchObject({
      cost_micros: expect.any(Number),
    });
    expect((await request(app).get("/api/runs/missing")).status).toBe(404);
  });
});

/** Deliberately high Flesch-Kincaid prose, so the frozen readability rule blocks. */
const COMPLEX_PROSE =
  "Consequently the extraordinarily sophisticated manufacturing methodology demonstrates considerable environmental responsibility whenever comparatively substantial quantities of internationally certified hardwood materials are systematically incorporated throughout the entire production infrastructure.";
const STILL_COMPLEX_PROSE =
  "Additionally the remarkably complicated manufacturing methodology demonstrates extraordinary environmental accountability whenever proportionally significant quantities of internationally accredited hardwood materials are meticulously integrated throughout the complete production infrastructure.";

/** Every persisted revision audit row, across all document versions of a run. */
function allAudits(repository: InMemoryMilestoneRepository) {
  const keys = (repository as unknown as { outputKeys: Map<string, string> }).outputKeys;
  return [...keys.entries()]
    .filter(([key]) => key.startsWith("revision-audits:"))
    .flatMap(([, value]) => JSON.parse(value) as Array<Record<string, unknown>>);
}

describe("step 1.10 candidate preflight", () => {
  it("binds, applies and proves a locationless keyword.primary.h2 blocker, then exports", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    // Remove the primary keyword from every H2 so the checker emits the real
    // locationless `keyword.primary.h2` blocker.
    current.draft.markdown = current.draft.markdown.replace(
      "## How a designer chair fits your room",
      "## Choosing between seating options",
    );
    const revisions = new MockRevisionProvider("revision-v1");

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      revisions,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "succeeded",
      block_counts: { deterministic_blockers: 0 },
    });
    expect(repository.exports).toHaveLength(1);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toContain(
      "## Choosing between seating options: designer chair",
    );
  });

  it("reverts a readability edit that stays above Grade 8 and records it truthfully as unable", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.markdown = current.draft.markdown.replace(
      "> Measure your room first.",
      `${COMPLEX_PROSE}\n\n> Measure your room first.`,
    );
    // The provider edits the bound paragraph but leaves the grade above 8.
    const ineffective = new MockRevisionProvider("revision-v1", (input) => ({
      ...input.current_document,
      markdown: input.current_document.markdown.replace(COMPLEX_PROSE, STILL_COMPLEX_PROSE),
    }));

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      ineffective,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const detail = await repository.getRunDetail(run.run_id);
    expect(detail).toMatchObject({
      status: "blocked",
      current_step: "automated_checks_rerun",
      deterministic_repair_cycles: 2,
      block_reason: "deterministic_blockers",
    });
    const finalDraft = (await repository.getDraft(run.run_id))!.draft;
    // The ineffective edit must not have persisted.
    expect(finalDraft.markdown).not.toContain(STILL_COMPLEX_PROSE);
    expect(finalDraft.markdown).toContain(COMPLEX_PROSE);
    expect(repository.exports).toHaveLength(0);
    const reverted = allAudits(repository).filter(
      (audit) =>
        typeof audit.reason === "string" && /did not resolve its deterministic/.test(audit.reason),
    );
    expect(reverted.length).toBeGreaterThan(0);
    for (const audit of reverted) expect(audit).toMatchObject({ status: "unable", changed: false });
  });

  it("keeps a successful sibling correction while an ineffective one is reverted", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.markdown = current.draft.markdown
      .replace("## How a designer chair fits your room", "## Choosing between seating options")
      .replace("> Measure your room first.", `${COMPLEX_PROSE}\n\n> Measure your room first.`);
    const ineffective = new MockRevisionProvider("revision-v1", (input) => ({
      ...input.current_document,
      markdown: input.current_document.markdown.replace(COMPLEX_PROSE, STILL_COMPLEX_PROSE),
    }));

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      ineffective,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const finalDraft = (await repository.getDraft(run.run_id))!.draft;
    // The deterministic H2 correction survives even though readability failed.
    expect(finalDraft.markdown).toContain("## Choosing between seating options: designer chair");
    expect(finalDraft.markdown).not.toContain(STILL_COMPLEX_PROSE);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({ status: "blocked" });
  });

  it("reverts only the edit responsible for an introduced blocker", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.markdown = current.draft.markdown.replace(
      "## How a designer chair fits your room",
      "## Choosing between seating options",
    );
    const before = current.draft.markdown;
    // Destroys the verified internal link, which introduces a new blocker.
    const linkRemoving = new MockRevisionProvider("revision-v1", (input) => ({
      ...input.current_document,
      markdown: input.current_document.markdown.replace(
        `[designer chair](${productLink.url})`,
        "designer chair",
      ),
    }));

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      linkRemoving,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    const finalDraft = (await repository.getDraft(run.run_id))!.draft;
    // The link survives because the responsible edit was reverted...
    expect(finalDraft.markdown).toContain(`[designer chair](${productLink.url})`);
    // ...while the independent deterministic H2 correction still landed.
    expect(finalDraft.markdown).toContain("## Choosing between seating options: designer chair");
    expect(before).not.toContain("seating options: designer chair");
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "succeeded",
      block_counts: { deterministic_blockers: 0 },
    });
  });

  it("does not record a misleading applied audit when every edit is reverted", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    const versionId = current.version.id;
    current.draft.markdown = current.draft.markdown.replace(
      "> Measure your room first.",
      `${COMPLEX_PROSE}\n\n> Measure your room first.`,
    );
    const ineffective = new MockRevisionProvider("revision-v1", (input) => ({
      ...input.current_document,
      markdown: input.current_document.markdown.replace(COMPLEX_PROSE, STILL_COMPLEX_PROSE),
    }));

    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      ineffective,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);

    for (const audit of allAudits(repository))
      // Every audit must agree with the bytes that actually persisted.
      expect(audit.changed).toBe(audit.status === "applied");
  });

  it("replays the preflight from a checkpointed response without a second provider request", async () => {
    const { repository, run } = await setup();
    const current = (await repository.getDraft(run.run_id))!;
    current.draft.markdown = current.draft.markdown.replace(
      "## How a designer chair fits your room",
      "## Choosing between seating options",
    );
    const provider = new MockRevisionProvider("revision-v1");
    const make = (failures?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5]) =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        provider,
        new MockCoherenceProvider("coherence-v1"),
        repository,
        failures,
      );

    let crash = true;
    await expect(
      make({
        hit(boundary) {
          if (crash && boundary === "after_revision_persist") {
            crash = false;
            throw new Error("crash after the preflight persisted");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the preflight persisted");
    const calls = provider.calls.length;

    await make().run(run.run_id);
    // The resumed run replays the checkpoint deterministically.
    expect(provider.calls).toHaveLength(calls);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toContain(
      "## Choosing between seating options: designer chair",
    );
  });
});

/**
 * `structure.faq_answer_length` is a per-FAQ blocker, so two short answers give
 * two baseline blocker occurrences of ONE rule at two independent structured
 * leaves.
 *
 * Every Step 1.9 disposition is rejected so the operator round is a no-op and
 * the first `deterministic_repair` request carries BOTH blockers together —
 * the shape that previously made the preflight skip proof altogether and leave
 * an ineffective edit credited as `applied`.
 */
const SHORT_ANSWER_A = "Far too short an answer.";
const SHORT_ANSWER_B = "Also much too short here.";
const twoShortFaqs = {
  ...draft,
  faqs: [
    { question: "Question 1", answer: SHORT_ANSWER_A },
    { question: "Question 2", answer: SHORT_ANSWER_B },
    { question: "Question 3", answer: words(40) },
  ],
};

function withFaqAnswers(document: typeof draft, answers: Record<number, string>): typeof draft {
  return {
    ...document,
    faqs: document.faqs.map((faq, index) =>
      answers[index] === undefined ? faq : { ...faq, answer: answers[index]! },
    ),
  };
}

describe("preflight proof when several blockers share one rule", () => {
  const runShared = async (transform: (document: typeof draft) => typeof draft) => {
    const { repository, run } = await setup(productLink, twoShortFaqs);
    for (const disposition of repository.dispositions) disposition.decision = "rejected";
    const provider = new MockRevisionProvider("revision-v1", (input) =>
      transform(input.current_document as typeof draft),
    );
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      provider,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    const requests = repository.revisionRequests.filter(
      (item) => item.revision_source === "deterministic_repair",
    );
    return {
      repository,
      final: (await repository.getDraft(run.run_id))!.draft,
      detail: await repository.getRunDetail(run.run_id),
      sharedRuleRequest: requests[0],
    };
  };

  /** Guards the premise: the first repair request really does carry both. */
  const expectTwoSameRuleFindings = (request: RevisionRequest | undefined) => {
    expect(request?.accepted_findings.map((finding) => finding.rule_reference)).toEqual([
      "structure.faq_answer_length",
      "structure.faq_answer_length",
    ]);
  };

  it("credits the provable edit and reverts its ineffective same-rule sibling", async () => {
    const { final, detail, repository, sharedRuleRequest } = await runShared((document) =>
      withFaqAnswers(document, { 0: words(50), 1: "Still far too short indeed." }),
    );
    expectTwoSameRuleFindings(sharedRuleRequest);
    // FAQ 1 was genuinely fixed and survives.
    expect(final.faqs[0]!.answer.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    // FAQ 2's edit changed bytes but resolved nothing, so it never persisted.
    expect(final.faqs[1]!.answer).toBe(SHORT_ANSWER_B);
    expect(detail).toMatchObject({ status: "blocked", block_reason: "deterministic_blockers" });
    const audits = allAudits(repository);
    expect(
      audits.filter(
        (audit) =>
          typeof audit.reason === "string" &&
          /did not resolve its deterministic/.test(audit.reason),
      ).length,
    ).toBeGreaterThan(0);
    // The provable sibling keeps a truthful applied audit in the same pass.
    expect(audits.some((audit) => audit.status === "applied")).toBe(true);
  });

  it("credits both edits when both same-rule blockers are fixed", async () => {
    const { final, detail, sharedRuleRequest } = await runShared((document) =>
      withFaqAnswers(document, { 0: words(50), 1: words(52) }),
    );
    expectTwoSameRuleFindings(sharedRuleRequest);
    expect(final.faqs[0]!.answer.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    expect(final.faqs[1]!.answer.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    expect(detail).toMatchObject({
      status: "succeeded",
      block_counts: { deterministic_blockers: 0 },
    });
  });

  it("reverts both edits when neither same-rule blocker is fixed", async () => {
    const { final, detail, repository, sharedRuleRequest } = await runShared((document) =>
      withFaqAnswers(document, {
        0: "Different but still short.",
        1: "Also different, still short.",
      }),
    );
    expectTwoSameRuleFindings(sharedRuleRequest);
    expect(final.faqs[0]!.answer).toBe(SHORT_ANSWER_A);
    expect(final.faqs[1]!.answer).toBe(SHORT_ANSWER_B);
    expect(detail).toMatchObject({ status: "blocked" });
    for (const audit of allAudits(repository))
      expect(audit.changed).toBe(audit.status === "applied");
  });
});

describe("revision operation identity", () => {
  const identity = {
    runId: "run-1",
    documentVersionId: "version-1",
    source: "deterministic_repair" as const,
    findingIds: ["finding-a", "finding-b"],
    provider: "mock-local",
    model: "revision-v1",
  };

  it("is stable for unchanged inputs so a replay resumes the same operation", () => {
    expect(revisionOperationId(identity)).toBe(revisionOperationId({ ...identity }));
  });

  it("binds the binding identity, so a binding change starts a new operation", () => {
    const base = (...extra: string[]) =>
      stableId(
        "revision-operation",
        identity.runId,
        identity.documentVersionId,
        identity.source,
        ...identity.findingIds,
        identity.provider,
        identity.model,
        REVISION_PROMPT_VERSION,
        REVISION_PLANNING_VERSION,
        ...extra,
      );
    // The real identity must include REVISION_BINDING_VERSION: a binding change
    // moves which exact location each accepted finding authorises, so it cannot
    // reuse a checkpoint captured under the previous binding.
    expect(revisionOperationId(identity)).toBe(
      base(REVISION_BINDING_VERSION, READABILITY_SELECTOR_VERSION, ""),
    );
    expect(revisionOperationId(identity)).not.toBe(base());
    expect(revisionOperationId(identity)).not.toBe(
      base(`${REVISION_BINDING_VERSION}-next`, READABILITY_SELECTOR_VERSION, ""),
    );
    // A different selected readability target set must fork a new operation, so
    // an unchanged ineffective selection can never silently pay twice.
    expect(revisionOperationId({ ...identity, readabilityTargets: "f1:3-3" })).not.toBe(
      revisionOperationId({ ...identity, readabilityTargets: "f1:5-5" }),
    );
    expect(revisionOperationId({ ...identity, readabilityTargets: "f1:3-3" })).toBe(
      revisionOperationId({ ...identity, readabilityTargets: "f1:3-3" }),
    );
  });

  it("keeps a zero-finding no-op configuration-independent", () => {
    const noop = { ...identity, findingIds: [] };
    expect(revisionOperationId(noop)).toBe(
      stableId("revision-operation", noop.runId, noop.documentVersionId, noop.source),
    );
    // A no-op has no provider operation, so provider/model/version churn must
    // not fork its identity.
    expect(revisionOperationId(noop)).toBe(
      revisionOperationId({ ...noop, provider: "other", model: "other-model" }),
    );
  });
});

/**
 * Multi-block readability correction.
 *
 * `style.readability_grade_8` is a whole-document rule, so one paragraph cannot
 * move Grade 19.9 to Grade 8. One accepted readability finding therefore
 * authorises several exact, non-contiguous prose blocks.
 */
const HARD_BLOCKS = [
  "Consequently the extraordinarily sophisticated manufacturing methodology demonstrates considerable environmental responsibility whenever comparatively substantial quantities of internationally certified hardwood materials are systematically incorporated throughout the entire production infrastructure.",
  "Furthermore the interdisciplinary collaboration between contemporary furniture designers and experienced upholstery specialists consistently generates remarkably distinctive configurations which accommodate increasingly unpredictable residential requirements without compromising fundamental ergonomic considerations.",
  "Additionally the comprehensive evaluation of proportional relationships throughout an interior necessitates considerable deliberation regarding circulation, illumination and the psychological implications of substantial upholstered furnishings within comparatively confined domestic environments.",
];
const SIMPLE_BLOCKS = [
  "A chair should fit your room. Pick a size that leaves space to walk. Test the seat height first.",
  "Good makers use solid wood. They also use strong glue and screws. Ask how the frame is joined.",
  "Think about light and flow. Keep paths clear. A big chair can crowd a small room, so measure it.",
];

const hardDraft = {
  ...draft,
  markdown: [
    "# Designer chair guide",
    "<!-- MOBELARIS_IMAGE:designer-chair -->",
    `Designer chair ${words(38)}`,
    "## Key Takeaways",
    "- Fit matters",
    "- Comfort matters",
    "- Materials matter",
    "## How a designer chair fits your room",
    `Modern seating works with a [designer chair](${productLink.url}) when scale and use are clear.`,
    ...HARD_BLOCKS,
    "> Measure your room first.",
    "## Conclusion",
    "Choose a designer chair that fits the room, use and comfort needs.",
  ].join("\n\n"),
};

/** Replaces each authorised hard block with simple prose. */
const simplifier = (replace: (index: number) => string) =>
  new MockRevisionProvider("revision-v1", (input) => ({
    ...input.current_document,
    markdown: HARD_BLOCKS.reduce(
      (markdown, block, index) => markdown.replace(block, replace(index)),
      input.current_document.markdown,
    ),
  }));

async function runReadability(provider: MockRevisionProvider) {
  // Keep the default Step 1.9 dispositions. Blanket-rejecting every finding
  // would turn each rejected location into a binding exclusion covering the
  // body prose, which is correct behaviour but not a realistic operator round.
  const { repository, run } = await setup(productLink, hardDraft);
  await new MilestoneFourOrchestrator(
    repository,
    fixture,
    provider,
    new MockCoherenceProvider("coherence-v1"),
    repository,
  ).run(run.run_id);
  return {
    repository,
    run,
    final: (await repository.getDraft(run.run_id))!.draft,
    detail: await repository.getRunDetail(run.run_id),
  };
}

describe("bounded multi-block readability correction", () => {
  it("authorises several exact blocks and issues only application-owned block IDs", async () => {
    const provider = simplifier((index) => SIMPLE_BLOCKS[index]!);
    const { repository } = await runReadability(provider);
    const readabilityRequest = provider.calls.find((call) =>
      call.accepted_findings.some((finding) => finding.id.includes("::rb")),
    );
    expect(readabilityRequest).toBeDefined();
    const ids = readabilityRequest!.accepted_findings.map((finding) => finding.id);
    // Application-issued, ordered, one per authorised block.
    expect(ids).toEqual(ids.map((_, index) => `${ids[0]!.split("::")[0]}::rb${index + 1}`));
    expect(ids.length).toBeGreaterThan(1);
    // Every issued block is an exact, non-contiguous source range.
    const ranges = readabilityRequest!.accepted_findings.map((finding) => [
      finding.location.line_start,
      finding.location.line_end,
    ]);
    for (const [start, end] of ranges) {
      expect(start).toBeDefined();
      expect(end).toBe(start);
    }
    expect(new Set(ranges.map((range) => range[0])).size).toBe(ranges.length);
    expect(repository.revisionRequests.length).toBeGreaterThan(0);
  });

  it("applies several non-contiguous replacements and reaches Grade 8, then exports", async () => {
    const { final, detail, repository } = await runReadability(
      simplifier((index) => SIMPLE_BLOCKS[index]!),
    );
    for (const [index, block] of HARD_BLOCKS.entries()) {
      expect(final.markdown).not.toContain(block);
      expect(final.markdown).toContain(SIMPLE_BLOCKS[index]!);
    }
    // Structure around the edits is untouched.
    expect(final.markdown).toContain(`[designer chair](${productLink.url})`);
    expect(final.markdown).toContain("<!-- MOBELARIS_IMAGE:designer-chair -->");
    expect(final.markdown).toContain("## Conclusion");
    expect(final.markdown).toContain(`Designer chair ${words(38)}`);
    expect(detail).toMatchObject({
      status: "succeeded",
      block_counts: { deterministic_blockers: 0 },
    });
    expect(repository.exports).toHaveLength(1);
  });

  it("reverts every readability-owned block when the candidate stays above Grade 8", async () => {
    // Simplifying only one of three blocks cannot move the document mean.
    const { final, detail, repository } = await runReadability(
      simplifier((index) => (index === 0 ? SIMPLE_BLOCKS[0]! : HARD_BLOCKS[index]!)),
    );
    for (const block of HARD_BLOCKS) expect(final.markdown).toContain(block);
    expect(final.markdown).not.toContain(SIMPLE_BLOCKS[0]!);
    expect(detail).toMatchObject({ status: "blocked", block_reason: "deterministic_blockers" });
    expect(repository.exports).toHaveLength(0);
    const reverted = allAudits(repository).filter(
      (audit) =>
        typeof audit.reason === "string" && /did not resolve its deterministic/.test(audit.reason),
    );
    expect(reverted.length).toBeGreaterThan(0);
    for (const audit of reverted) expect(audit).toMatchObject({ status: "unable", changed: false });
  });

  it("keeps one truthful audit carrying every applied readability hunk", async () => {
    const { repository } = await runReadability(simplifier((index) => SIMPLE_BLOCKS[index]!));
    const readability = allAudits(repository).find(
      (audit) => Array.isArray(audit.hunks) && (audit.hunks as unknown[]).length > 1,
    );
    expect(readability).toBeDefined();
    expect(readability).toMatchObject({ status: "applied", changed: true });
    // One audit, several exact hunks — never one broad span.
    expect((readability!.hunks as Array<Record<string, number>>).length).toBe(HARD_BLOCKS.length);
    for (const hunk of readability!.hunks as Array<Record<string, number>>)
      expect(hunk.source_end).toBe(hunk.source_start);
  });

  it("replays a checkpointed readability response without a second provider request", async () => {
    const { repository, run } = await setup(productLink, hardDraft);
    const provider = simplifier((index) => SIMPLE_BLOCKS[index]!);
    const make = (failures?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5]) =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        provider,
        new MockCoherenceProvider("coherence-v1"),
        repository,
        failures,
      );
    const readabilityCalls = () =>
      provider.calls.filter((call) =>
        call.accepted_findings.some((finding) => finding.id.includes("::rb")),
      );
    let crash = true;
    await expect(
      make({
        hit(boundary) {
          // Crash only once the readability response itself is checkpointed,
          // not on the earlier operator revision.
          if (crash && boundary === "after_revision_provider" && readabilityCalls().length > 0) {
            crash = false;
            throw new Error("crash after the readability response was checkpointed");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the readability response was checkpointed");
    expect(readabilityCalls()).toHaveLength(1);

    await make().run(run.run_id);
    // The resumed run replays the checkpoint rather than paying again.
    expect(readabilityCalls()).toHaveLength(1);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toContain(SIMPLE_BLOCKS[0]!);
  });

  it("keeps ineffective readability spend bounded by the unchanged repair budget", async () => {
    // Each Step 1.11 rerun mints fresh finding rows and each revision mints a
    // new document version, so a later cycle is a genuinely new operation
    // rather than a replay. The two-cycle budget — not the operation identity —
    // is what bounds repeated ineffective selection, so assert that bound
    // exactly rather than claiming a cross-cycle deduplication that does not
    // exist.
    const provider = simplifier((index) => (index === 0 ? SIMPLE_BLOCKS[0]! : HARD_BLOCKS[index]!));
    const { detail } = await runReadability(provider);
    expect(detail).toMatchObject({ status: "blocked", deterministic_repair_cycles: 2 });
    const readabilityCalls = provider.calls.filter((call) =>
      call.accepted_findings.some((finding) => finding.id.includes("::rb")),
    );
    expect(readabilityCalls.length).toBeGreaterThan(0);
    expect(readabilityCalls.length).toBeLessThanOrEqual(2);
    // Every attempt selected the same exact blocks, so none of them widened
    // authority in search of a result.
    const targetSets = new Set(
      readabilityCalls.map((call) =>
        call.accepted_findings
          .map((finding) => `${finding.location.line_start}-${finding.location.line_end}`)
          .join(","),
      ),
    );
    expect(targetSets.size).toBe(1);
  });
});

describe("exceptional authorisation replay is observation-only", () => {
  it("leaves a blocked child completely untouched on same-key replay", async () => {
    // Reach the cap with a readability blocker that stays unresolved, so the
    // exceptional correction produces a direct child that remains blocked.
    const { repository, run } = await setup(productLink, hardDraft);
    const stubborn = simplifier((index) => (index === 0 ? SIMPLE_BLOCKS[0]! : HARD_BLOCKS[index]!));
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      stubborn,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    const blocked = await repository.getRunDetail(run.run_id);
    expect(blocked).toMatchObject({ status: "blocked", deterministic_repair_cycles: 2 });

    const key = `exceptional:${run.run_id}:replay`;
    const first = await repository.authoriseExceptionalCorrection({
      run_id: run.run_id,
      idempotency_key: key,
      explicit_confirmation: true,
    });
    expect(first).toBe("authorised");
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      stubborn,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    )
      .run(run.run_id)
      .catch(() => undefined);

    const before = {
      detail: await repository.getRunDetail(run.run_id),
      documents: repository.documentVersions.length,
      operations: repository.revisionRequests.length,
      calls: stubborn.calls.length,
      version: (await repository.getDraft(run.run_id))!.version.id,
      authorisations: repository.exceptionalCorrectionAuthorisations.length,
    };
    expect(before.detail.status).toBe("blocked");

    // Replay the same key: observational only.
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).resolves.toBe("replay");

    const after = {
      detail: await repository.getRunDetail(run.run_id),
      documents: repository.documentVersions.length,
      operations: repository.revisionRequests.length,
      calls: stubborn.calls.length,
      version: (await repository.getDraft(run.run_id))!.version.id,
      authorisations: repository.exceptionalCorrectionAuthorisations.length,
    };
    expect(after.detail.status).toBe(before.detail.status);
    expect(after.detail.current_step).toBe(before.detail.current_step);
    expect(after.detail.block_reason).toBe(before.detail.block_reason);
    expect(after.detail.deterministic_repair_cycles).toBe(
      before.detail.deterministic_repair_cycles,
    );
    expect(after.documents).toBe(before.documents);
    expect(after.operations).toBe(before.operations);
    expect(after.calls).toBe(before.calls);
    expect(after.version).toBe(before.version);
    expect(after.authorisations).toBe(before.authorisations);
    // No second exceptional action is offered.
    expect(after.detail.exceptional_correction.available).toBe(false);
  });
});

describe("coherence pre-dispatch ambiguity protection", () => {
  const runToCoherence = async (
    failures?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5],
    coherence = new MockCoherenceProvider("coherence-v1"),
  ) => {
    const { repository, run } = await setup();
    const make = (hooks?: ConstructorParameters<typeof MilestoneFourOrchestrator>[5]) =>
      new MilestoneFourOrchestrator(
        repository,
        fixture,
        new MockRevisionProvider("revision-v1"),
        coherence,
        repository,
        hooks,
      );
    return { repository, run, coherence, make, failures };
  };

  it("enforces the coherence checkpoint state machine and replay semantics", async () => {
    const { repository, run } = await runToCoherence();
    const current = (await repository.getDraft(run.run_id))!;
    const lease = await repository.claimStep(
      run.run_id,
      "final_coherence_export",
      "transition-test",
    );
    const requestFor = (operation_id: string) =>
      CoherenceRequestSchema.parse({
        operation_id,
        run_id: run.run_id,
        parent_document_version_id: current.version.id,
        document_version_id: current.version.id,
        revision_reason: "coherence_repair",
        coherence_cycle: 0,
        handoff,
        parent_document: current.draft,
        current_document: current.draft,
        revision_audits: [],
        deterministic_result_hash: "0".repeat(64),
        reference_snapshots: [],
        prompt: { template_id: "mobelaris.final_coherence", template_version: "test" },
        model: "test-model",
        temperature: 0,
      });
    const response = {
      findings: [],
      usage: { input_units: 0, output_units: 0, cost_micros: 0 },
    };
    const input = {
      ...lease,
      run_id: run.run_id,
      operation_id: "coherence-transition-test",
      document_version_id: current.version.id,
      request: requestFor("coherence-transition-test"),
    };

    await expect(repository.beginCoherenceOperation(input)).resolves.toBeNull();
    const staleInput = { ...input, token: "stale-coherence-token" };
    await expect(repository.markCoherenceProviderInFlight(staleInput)).rejects.toThrow(
      "Stale fencing token",
    );
    await expect(repository.checkpointCoherenceResponse({ ...input, response })).rejects.toThrow(
      "requires an in-flight",
    );
    await expect(repository.beginCoherenceOperation(input)).resolves.toBeNull();

    await repository.markCoherenceProviderInFlight(input);
    await expect(
      repository.checkpointCoherenceResponse({ ...staleInput, response }),
    ).rejects.toThrow("Stale fencing token");
    await expect(
      repository.checkpointCoherenceResponse({ ...input, response }),
    ).resolves.toBeUndefined();
    await expect(
      repository.checkpointCoherenceResponse({ ...input, response }),
    ).resolves.toBeUndefined();
    await expect(
      repository.checkpointCoherenceResponse({
        ...input,
        response: { ...response, usage: { ...response.usage, output_units: 1 } },
      }),
    ).rejects.toThrow("Immutable coherence checkpoint conflict");
    await expect(repository.beginCoherenceOperation(input)).resolves.toEqual(response);
    await expect(repository.markCoherenceProviderInFlight(input)).rejects.toThrow(
      "cannot start a provider call",
    );
    await expect(
      repository.releaseCoherenceProviderFailure({
        ...input,
        reason: "configuration_before_dispatch",
      }),
    ).rejects.toThrow("cannot be released");

    const releasedInput = {
      ...input,
      operation_id: "coherence-transition-release-test",
      request: requestFor("coherence-transition-release-test"),
    };
    await expect(repository.beginCoherenceOperation(releasedInput)).resolves.toBeNull();
    await repository.markCoherenceProviderInFlight(releasedInput);
    await repository.releaseCoherenceProviderFailure({
      ...releasedInput,
      reason: "configuration_before_dispatch",
    });
    await expect(repository.beginCoherenceOperation(releasedInput)).resolves.toBeNull();
    await expect(
      repository.checkpointCoherenceResponse({ ...releasedInput, response }),
    ).rejects.toThrow("requires an in-flight");
  });

  it("fails closed after a loss between the durable reservation and the response", async () => {
    const { repository, run, coherence, make } = await runToCoherence();
    let crash = true;
    await expect(
      make({
        hit(boundary) {
          if (crash && boundary === "after_coherence_reservation") {
            crash = false;
            throw new Error("crash after the coherence reservation committed");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence reservation committed");
    expect(coherence.calls).toHaveLength(0);

    // The reservation is durable, so a resume must not gamble on a second call.
    await expect(make().run(run.run_id)).rejects.toThrow(/ambiguous/i);
    expect(coherence.calls).toHaveLength(0);
    expect(repository.exports).toHaveLength(0);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("retryable_failed");
  });

  it("makes exactly one provider call when the return is lost before checkpointing", async () => {
    const { repository, run, coherence, make } = await runToCoherence();
    let crash = true;
    await expect(
      make({
        hit(boundary) {
          if (crash && boundary === "after_coherence_provider_return") {
            crash = false;
            throw new Error("crash after the coherence provider returned");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence provider returned");
    expect(coherence.calls).toHaveLength(1);

    await expect(make().run(run.run_id)).rejects.toThrow(/ambiguous/i);
    // Exactly one paid call, never two.
    expect(coherence.calls).toHaveLength(1);
    expect(repository.exports).toHaveLength(0);
  });

  it("replays a checkpointed coherence response with zero additional calls", async () => {
    const { repository, run, coherence, make } = await runToCoherence();
    let crash = true;
    await expect(
      make({
        hit(boundary) {
          if (crash && boundary === "after_coherence_provider") {
            crash = false;
            throw new Error("crash after the coherence response was checkpointed");
          }
        },
      }).run(run.run_id),
    ).rejects.toThrow("crash after the coherence response was checkpointed");
    expect(coherence.calls).toHaveLength(1);
    const usageBeforeReplay = repository.providerUsage.filter(
      (usage) => usage.operation === "final_coherence_export",
    );
    // Usage is persisted with the recovered coherence outcome, not before it.
    expect(usageBeforeReplay).toHaveLength(0);

    await make().run(run.run_id);
    expect(coherence.calls).toHaveLength(1);
    const persistedUsage = repository.providerUsage.filter(
      (usage) => usage.operation === "final_coherence_export",
    );
    expect(persistedUsage).toHaveLength(1);
    expect(persistedUsage[0]).toMatchObject({
      input_units: 80,
      output_units: 20,
      cost_micros: 100,
    });
    await make().run(run.run_id);
    expect(
      repository.providerUsage.filter((usage) => usage.operation === "final_coherence_export"),
    ).toEqual(persistedUsage);
    expect(repository.exports).toHaveLength(1);
  });

  it("still exports normally when nothing is lost", async () => {
    const { repository, run, coherence, make } = await runToCoherence();
    await make().run(run.run_id);
    expect(coherence.calls).toHaveLength(1);
    expect(repository.exports).toHaveLength(1);
    expect((await repository.getRunDetail(run.run_id)).status).toBe("succeeded");
  });
});

describe("exceptional authorisation idempotency contract", () => {
  /** Drives a run to the two-cycle cap so an authorisation is eligible. */
  const blockedRun = async () => {
    const { repository, run } = await setup(productLink, hardDraft);
    const provider = simplifier((index) => (index === 0 ? SIMPLE_BLOCKS[0]! : HARD_BLOCKS[index]!));
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      provider,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    expect(await repository.getRunDetail(run.run_id)).toMatchObject({
      status: "blocked",
      deterministic_repair_cycles: 2,
    });
    return { repository, run, provider };
  };

  const snapshot = async (
    repository: InMemoryMilestoneRepository,
    runId: string,
    provider: MockRevisionProvider,
  ) => {
    const detail = await repository.getRunDetail(runId);
    return {
      status: detail.status,
      current_step: detail.current_step,
      block_reason: detail.block_reason,
      cycles: detail.deterministic_repair_cycles,
      coherence_cycles: detail.coherence_return_cycles,
      documents: repository.documentVersions.length,
      version: (await repository.getDraft(runId))!.version.id,
      operations: repository.revisionRequests.length,
      calls: provider.calls.length,
      authorisations: repository.exceptionalCorrectionAuthorisations.length,
    };
  };

  it("authorises the first key on an eligible run", async () => {
    const { repository, run } = await blockedRun();
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: "key-a",
        explicit_confirmation: true,
      }),
    ).resolves.toBe("authorised");
  });

  it("replays the same key on the same run without mutating anything", async () => {
    const { repository, run, provider } = await blockedRun();
    await repository.authoriseExceptionalCorrection({
      run_id: run.run_id,
      idempotency_key: "key-a",
      explicit_confirmation: true,
    });
    const before = await snapshot(repository, run.run_id, provider);
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: "key-a",
        explicit_confirmation: true,
      }),
    ).resolves.toBe("replay");
    expect(await snapshot(repository, run.run_id, provider)).toEqual(before);
  });

  it("conflicts on a different key for an already-authorised run, without mutating", async () => {
    const { repository, run, provider } = await blockedRun();
    await repository.authoriseExceptionalCorrection({
      run_id: run.run_id,
      idempotency_key: "key-a",
      explicit_confirmation: true,
    });
    const before = await snapshot(repository, run.run_id, provider);
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: "key-b",
        explicit_confirmation: true,
      }),
    ).rejects.toThrow(/already has an exceptional authorisation/i);
    expect(await snapshot(repository, run.run_id, provider)).toEqual(before);
  });

  it("conflicts when the same key is owned by another run, without mutating", async () => {
    const first = await blockedRun();
    const second = await blockedRun();
    await first.repository.authoriseExceptionalCorrection({
      run_id: first.run.run_id,
      idempotency_key: "shared-key",
      explicit_confirmation: true,
    });
    // Same repository instance, so the key is owned by the first run.
    const before = await snapshot(first.repository, first.run.run_id, first.provider);
    await expect(
      first.repository.authoriseExceptionalCorrection({
        run_id: second.run.run_id,
        idempotency_key: "shared-key",
        explicit_confirmation: true,
      }),
    ).rejects.toThrow(/Authorisation key conflict/i);
    expect(await snapshot(first.repository, first.run.run_id, first.provider)).toEqual(before);
  });
});

describe("readability authority equals its frozen block set", () => {
  /** A sibling finding that owns the hardest paragraph outright. */
  const siblingOn = (line: number): ReviewFinding & { id: string } =>
    ({
      id: `sibling-${line}`,
      stable_key: `sibling-${line}`,
      category: "style",
      rule_reference: "style.banned_phrase_provisional",
      severity: "warning",
      location: { field: "body_markdown", line_start: line, line_end: line },
      issue: "Sibling owns this paragraph.",
      suggested_fix: "Revise it.",
    }) as ReviewFinding & { id: string };

  const readability = {
    id: "readability",
    stable_key: "readability",
    category: "deterministic" as const,
    rule_reference: "style.readability_grade_8",
    severity: "blocker" as const,
    location: { field: "body_markdown" },
    issue: "Grade is too high.",
    suggested_fix: "Simplify.",
    disposition: "accepted" as const,
    origin_document_version_id: "v1",
  };

  const bindWith = (siblingLines: number[]) =>
    bindRevisionFindingsWithAuthority({
      document: hardDraft,
      primaryKeyword: handoff.primary_keyword,
      findings: [
        readability,
        ...siblingLines.map((line) => ({
          ...siblingOn(line),
          disposition: "accepted" as const,
          origin_document_version_id: "v1",
        })),
      ] as never,
    });

  it("moves the primary target to the next eligible paragraph when a sibling owns the hardest", () => {
    const all = bindWith([]);
    const blocks = all.readability_blocks.readability!;
    expect(blocks.length).toBeGreaterThan(1);
    const firstLine = blocks[0]!.line_start;

    const reserved = bindWith([firstLine]);
    const reservedBlocks = reserved.readability_blocks.readability!;
    // The sibling's paragraph is gone from the frozen set...
    expect(reservedBlocks.map((block) => block.line_start)).not.toContain(firstLine);
    // ...and the primary location is the first block of that exact final set.
    const primary = reserved.findings.find((finding) => finding.id === "readability")!;
    expect(primary.location.line_start).toBe(reservedBlocks[0]!.line_start);
    expect(reservedBlocks.map((block) => block.line_start)).toContain(primary.location.line_start);
  });

  it("leaves readability unbound and unable when siblings own every eligible paragraph", () => {
    const all = bindWith([]);
    const everyLine = all.readability_blocks.readability!.map((block) => block.line_start);
    const reserved = bindWith(everyLine);
    expect(reserved.readability_blocks.readability).toBeUndefined();
    const primary = reserved.findings.find((finding) => finding.id === "readability")!;
    expect(primary.location.line_start).toBeUndefined();
    // With no exact authority the planner cannot route it to the provider.
    const base = {
      operation_id: "op",
      run_id: "run",
      document_version_id: "v1",
      revision: 1,
      handoff,
      current_document: hardDraft,
      accepted_findings: reserved.findings,
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.revision_pass" as const, template_version: "2.0.0" },
      model: "model",
      temperature: 0,
    };
    const planned = planRevisionRequest(base as never);
    expect(planned.find((item) => item.finding.id === "readability")?.route).toBe("unable");
  });

  it("produces the same complete selection for the exceptional route", () => {
    const normal = bindWith([]).readability_blocks.readability!;
    const bindings = bindExceptionalBlockers(hardDraft, handoff.primary_keyword, [
      {
        id: "readability",
        rule_reference: "style.readability_grade_8",
        location: readability.location,
      },
    ]);
    expect(bindings).not.toBeNull();
    expect(bindings![0]!.readability_blocks).toEqual(
      normal.map((block) => ({ line_start: block.line_start, line_end: block.line_end })),
    );
    expect(bindings![0]!.location.line_start).toBe(normal[0]!.line_start);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import type { DeterministicFixture, ReviewFinding } from "../src/shared/milestone-three.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { MilestoneFourOrchestrator } from "../src/server/milestone-four-orchestrator.js";
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
} from "../src/shared/milestone-four.js";
import type { RevisionFinding } from "../src/shared/milestone-four.js";
import request from "supertest";
import { logger } from "../src/server/logger.js";
import { RevisionProviderError } from "../src/server/providers/chat-completion-revision-provider.js";

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

async function setup(link: Record<string, unknown> = productLink) {
  const repository = new InMemoryMilestoneRepository();
  const run = await ingestHandoff(handoff, `m4-${Math.random()}`, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([link as typeof productLink]),
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

  it("hard-blocks step 1.11 introduced blockers after two repair cycles while ignoring the current fixture", async () => {
    const { repository, run } = await setup();
    const coherence = new MockCoherenceProvider("coherence-v1");
    const currentFixtureMustBeIgnored = { ...fixture, link_verification: [] };
    const linkRemovingRevision = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(
        `[designer chair](${productLink.url})`,
        "designer chair",
      ),
    }));
    await new MilestoneFourOrchestrator(
      repository,
      currentFixtureMustBeIgnored,
      linkRemovingRevision,
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
          rule_reference: "links.verified_internal_presence",
          issue: expect.any(String),
          location: expect.objectContaining({ field: "body_markdown" }),
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
    const app = createApp({ serveClient: false, milestoneFour: { repository, orchestrator } });

    const response = await request(app).post(`/api/runs/${run.run_id}/milestone-four/resume`);

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
    expect((await repository.getRunDetail(run.run_id)).status).toBe("retryable_failed");
  });

  it("recovers only a block backed by the current persisted rerun and its blocker", async () => {
    const { repository, run } = await setup();
    const linkRemovingRevision = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(
        `[designer chair](${productLink.url})`,
        "designer chair",
      ),
    }));
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      linkRemovingRevision,
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
    expect((await request(app).post(`/api/runs/${run.run_id}/milestone-four/resume`)).status).toBe(
      200,
    );
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

  it("authorises the capped exact block once and replays without a second authorisation", async () => {
    const { repository, run } = await setup();
    const linkRemovingRevision = new MockRevisionProvider("revision-v1", (request) => ({
      ...request.current_document,
      markdown: request.current_document.markdown.replace(
        `[designer chair](${productLink.url})`,
        "designer chair",
      ),
    }));
    await new MilestoneFourOrchestrator(
      repository,
      fixture,
      linkRemovingRevision,
      new MockCoherenceProvider("coherence-v1"),
      repository,
    ).run(run.run_id);
    const state = (repository as any).runs.get(run.run_id);
    expect(state.deterministicRepairCycles).toBe(2);
    const blockedMarkdown = state.draft.draft.markdown;
    const key = `exceptional:${run.run_id}:current`;
    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: key,
        explicit_confirmation: true,
      }),
    ).resolves.toBe("authorised");
    expect(repository.exceptionalCorrectionAuthorisations).toHaveLength(1);
    expect((await repository.getRevisionFindings(run.run_id, state.draft.version.id)).source).toBe(
      "operator_authorised_repair",
    );

    // Simulate a disconnected first request after the authorisation commit: an HTTP replay must
    // resume the non-terminal durable run, while operation checkpoints prevent duplicate calls.
    const recovery = new MockRevisionProvider("revision-v1");
    const app = createApp({
      serveClient: false,
      milestoneFour: {
        repository,
        orchestrator: new MilestoneFourOrchestrator(
          repository,
          fixture,
          recovery,
          new MockCoherenceProvider("coherence-v1"),
          repository,
        ),
      },
    });
    const replay = await request(app)
      .post(`/api/runs/${run.run_id}/exceptional-correction/authorise`)
      .send({ idempotency_key: key, explicit_confirmation: true });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("blocked");
    expect(recovery.calls).toHaveLength(0);
    expect((await repository.getDraft(run.run_id))!.draft.markdown).toBe(blockedMarkdown);
    expect(repository.exports).toHaveLength(0);
    expect(repository.exceptionalCorrectionAuthorisations).toHaveLength(1);

    await expect(
      repository.authoriseExceptionalCorrection({
        run_id: run.run_id,
        idempotency_key: `${key}:other`,
        explicit_confirmation: true,
      }),
    ).rejects.toThrow("not available");
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

  it("serves typed detail and cost APIs", async () => {
    const { repository, run } = await setup();
    const orchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      new MockRevisionProvider("revision-v1"),
      new MockCoherenceProvider("coherence-v1"),
      repository,
    );
    const app = createApp({ serveClient: false, milestoneFour: { repository, orchestrator } });
    expect((await request(app).post(`/api/runs/${run.run_id}/milestone-four/resume`)).status).toBe(
      200,
    );
    expect((await request(app).get(`/api/runs/${run.run_id}`)).body.steps).toEqual(
      expect.any(Array),
    );
    expect((await request(app).get(`/api/runs/${run.run_id}/costs`)).body).toMatchObject({
      cost_micros: expect.any(Number),
    });
    expect((await request(app).get("/api/runs/missing")).status).toBe(404);
  });
});

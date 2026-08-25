import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import {
  ReviewResponseSchema,
  mapDeterministicInput,
  type DeterministicFixture,
  type ReviewFinding,
} from "../src/shared/milestone-three.js";
import { enforceFactReview, inventoryFacts } from "../src/shared/fact-inventory.js";
import {
  MilestoneThreeOrchestrator,
  type MilestoneThreeFailureBoundary,
} from "../src/server/milestone-three-orchestrator.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import { NoNetworkFactVerifier } from "../src/server/providers/fact-verifier.js";
import { ConflictError } from "../src/shared/errors.js";

const handoff = {
  plane_ticket: "MOB-M3",
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
const draft = {
  title: "Designer chair guide",
  slug: "designer-chair-guide",
  meta_description: "A concise guide.",
  og_title: "Designer chair",
  og_description: "A concise guide.",
  images: [],
  faqs: [],
  markdown:
    "# Designer chair\n\nA short answer with a [chair collection](https://www.mobelaris.com/chairs).\n\n## Conclusion\n\nChoose carefully.",
  claims: [
    {
      text: "Designed by Example Studio",
      type: "provenance" as const,
      provenance: "Unconfirmed",
      status: "unverified" as const,
    },
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};
const modelFinding: ReviewFinding = {
  stable_key: "review-note",
  category: "style",
  rule_reference: "mock.style",
  severity: "warning",
  location: { field: "body_markdown" },
  issue: "A local structured review note.",
  suggested_fix: "Review this passage.",
};

async function setup(key = "m3") {
  const repository = new InMemoryMilestoneRepository();
  const run = await ingestHandoff(handoff, key, repository);
  await new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([
      { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
    ]),
    new MockDraftProvider("draft-v1", draft),
  ).run(run.run_id);
  return { repository, run };
}

class OnceFailure {
  private fired = false;
  constructor(private readonly target: MilestoneThreeFailureBoundary) {}
  hit(boundary: MilestoneThreeFailureBoundary) {
    if (!this.fired && boundary === this.target) {
      this.fired = true;
      throw new Error(`injected:${boundary}`);
    }
  }
}

describe("milestone three", () => {
  it("maps the draft's own on-page fields, never fixture fields, into deterministic input", () => {
    const run = { run_id: "r", document_version_id: "v" };
    const input = mapDeterministicInput({
      ...run,
      handoff,
      draft,
      persisted_links: fixture.link_verification.map((verification) => ({
        url: verification.url,
        title: "Chairs",
        relevance: 1,
      })),
      fixture,
    });
    expect(input.on_page.og_title).toBe(draft.og_title);
    expect(input.on_page.og_description).toBe(draft.og_description);
    expect(input.on_page.images).toEqual(draft.images);
    expect(input.on_page.faqs).toEqual(draft.faqs);
    expect(input.on_page.meta_title).toBe(draft.title);
    expect(input.on_page.slug).toBe(draft.slug);
  });
  it("allows an honest empty shortlist without a stale static verification mapping", () => {
    const input = mapDeterministicInput({
      run_id: "r-empty",
      document_version_id: "v-empty",
      handoff,
      draft,
      persisted_links: [],
      fixture: { internal_origins: fixture.internal_origins, link_verification: [] },
    });
    expect(input.verified_internal_links).toEqual([]);
  });

  it("rejects a static verification mapping that was not persisted by Step 1.2", () => {
    expect(() =>
      mapDeterministicInput({
        run_id: "r-stale",
        document_version_id: "v-stale",
        handoff,
        draft,
        persisted_links: [],
        fixture,
      }),
    ).toThrow("Fixture maps an unpersisted link");
  });

  it("audits exact model controls and canonical reference parity for every review", async () => {
    const { repository, run } = await setup();
    const provider = new MockReviewProvider("review-v1");
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(provider.calls.map((call) => [call.step, call.temperature, call.prompt])).toEqual([
      [
        "review_writing_style",
        0,
        { template_id: "mobelaris.review_writing_style", template_version: "2.0.0" },
      ],
      [
        "review_information_gain",
        0,
        { template_id: "mobelaris.review_information_gain", template_version: "2.0.0" },
      ],
      [
        "review_fact_checking",
        0,
        { template_id: "mobelaris.review_fact_checking", template_version: "2.0.0" },
      ],
      [
        "review_link_conversion",
        0,
        { template_id: "mobelaris.review_link_conversion", template_version: "2.0.0" },
      ],
    ]);
    expect(
      provider.calls.find((call) => call.step === "review_information_gain")!.reference_snapshots,
    ).toEqual([]);
    for (const snapshot of provider.calls.flatMap((call) => call.reference_snapshots)) {
      expect(snapshot.content).toBeTruthy();
      expect(snapshot.immutable_pointer).toMatch(/^memory:\/\/reference\//);
      expect(snapshot.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    const requestArtifacts = repository.artifacts.filter((item) => item.kind === "review_request");
    expect(requestArtifacts.map((item) => item.step_execution_id)).toEqual(
      repository.providerUsage
        .filter((item) => item.operation.startsWith("review_"))
        .map((item) => item.step_execution_id),
    );
  });

  it("inventories common attribution phrasing", () => {
    const variants = inventoryFacts({
      ...draft,
      markdown: [
        "Charles Eames designed this chair for compact interiors.",
        "It was designed in 1956 by Example Studio.",
        "The designer is Eileen Gray.",
      ].join("\n\n"),
    });
    const attributions = variants.filter(
      (item) => item.classification === "attribution_provenance",
    );
    expect(attributions.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        "Charles Eames designed this chair for compact interiors.",
        "It was designed in 1956 by Example Studio.",
        "The designer is Eileen Gray.",
      ]),
    );
    expect(attributions.every((item) => item.claim_type === "provenance")).toBe(true);
    expect(
      inventoryFacts({
        ...draft,
        markdown: "We created a calm interior. The team designed this layout.",
        claims: [],
      }).filter((item) => item.classification === "attribution_provenance"),
    ).toHaveLength(0);
  });

  it("inventories every claim type and preserves repeated prose locations", () => {
    const allTypes = inventoryFacts({
      ...draft,
      markdown: "The table is 180 cm long.\n\nThe table is 180 cm long.",
      claims: [
        { text: "180 cm", type: "dimension", status: "unverified", product_identifier: "p-1" },
        { text: "Solid oak", type: "material", status: "unverified", product_identifier: "p-1" },
        { text: "£900", type: "price", status: "unverified", product_identifier: "p-1" },
        {
          text: "Delivery takes 2 weeks",
          type: "delivery",
          status: "unverified",
          product_identifier: "p-1",
        },
        { text: "Sales rose 20%", type: "statistic", status: "unverified" },
        {
          text: "Designed by Example Studio",
          type: "provenance",
          status: "unverified",
          product_identifier: "p-1",
        },
        { text: "Founded in London", type: "general", status: "unverified" },
      ],
    });
    expect(
      new Set(
        allTypes.filter((item) => item.location.field === "claims").map((item) => item.claim_type),
      ),
    ).toEqual(
      new Set(["dimension", "material", "price", "delivery", "statistic", "provenance", "general"]),
    );
    expect(
      allTypes
        .filter((item) => item.text === "The table is 180 cm long.")
        .map((item) => item.location.line_start),
    ).toEqual([1, 3]);
  });

  it("rejects omitted fact inventory and safely normalises attribution classification", () => {
    const factualDraft = {
      ...draft,
      markdown: `${draft.markdown}\n\nDesigned by Example Studio, the chair is 80 cm high.`,
    };
    const inventory = inventoryFacts(factualDraft);
    expect(inventory.map((item) => item.classification)).toEqual(
      expect.arrayContaining(["factual_figure", "attribution_provenance"]),
    );
    const base = {
      request_id: "request-1",
      findings: [],
      sources: inventory.map((item) => ({
        stable_key: `source-${item.stable_key}`,
        uri: `mock://fact/${item.stable_key}`,
        title: "Mock evidence",
        source_type: "unresolved" as const,
        retrieved_at: "2025-01-01T00:00:00.000Z",
        snapshot: { unresolved: true },
        evidence: "No production evidence; unresolved.",
      })),
      claims: inventory.map((item) => ({
        stable_key: `claim-${item.stable_key}`,
        inventory_key: item.stable_key,
        claim_text: "provider changed text",
        type: "general" as const,
        status: "verified" as const,
        location: { field: "title" as const },
        hard_flag: false,
        source_key: `source-${item.stable_key}`,
      })),
      usage: { input_units: 1, output_units: 1, cost_micros: 0 },
    };
    const normalised = enforceFactReview(ReviewResponseSchema.parse(base), inventory);
    const attribution = normalised.claims.find((claim) =>
      inventory.find(
        (item) =>
          item.stable_key === claim.inventory_key &&
          item.classification === "attribution_provenance",
      ),
    )!;
    expect(attribution).toMatchObject({
      type: "provenance",
      hard_flag: true,
      status: "verified",
    });
    expect(() =>
      enforceFactReview(
        ReviewResponseSchema.parse({ ...base, claims: base.claims.slice(1) }),
        inventory,
      ),
    ).toThrow("omitted inventory items");
  });
  it("merges deterministic and model Step 1.8 findings in the fenced review output", async () => {
    const { repository, run } = await setup();
    const provider = new MockReviewProvider("review-v1", {
      review_link_conversion: [
        {
          ...modelFinding,
          stable_key: "link-model-anchor",
          category: "link_conversion",
          rule_reference: "link.anchor_quality",
        },
      ],
    });
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      provider,
      undefined,
      new NoNetworkFactVerifier(),
      {
        verify: async () => ({ outcome: "confirmed_non_200", method: "head", status: 404 }),
      },
    ).run(run.run_id);
    const linkFindings = repository.findings.filter(
      (finding) => finding.step === "review_link_conversion",
    );
    expect(linkFindings.map((finding) => finding.rule_reference)).toEqual(
      expect.arrayContaining(["link.target_status", "link.anchor_quality"]),
    );
    const output = repository.artifacts.find(
      (item) =>
        item.kind === "review_request" &&
        repository.findings.some(
          (finding) =>
            finding.step_execution_id === item.step_execution_id &&
            finding.step === "review_link_conversion",
        ),
    );
    expect(output).toBeDefined();
  });

  it("freezes the Step 1.5 advisory-unavailable warning into Step 1.9 for disposition", async () => {
    const { repository, run } = await setup("m3-style-fallback");
    const base = new MockReviewProvider("review-v1");
    const provider = {
      provider: base.provider,
      model: base.model,
      review: async (request: Parameters<typeof base.review>[0]) => {
        const response = await base.review(request);
        return request.step === "review_writing_style"
          ? {
              ...response,
              findings: [
                {
                  stable_key: "style-advisory-unavailable",
                  category: "style_advisory_unavailable",
                  rule_reference: "style.advisory_unavailable",
                  severity: "warning" as const,
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
    const warning = repository.findings.find(
      (finding) => finding.rule_reference === "style.advisory_unavailable",
    )!;
    expect(warning).toMatchObject({
      step: "review_writing_style",
      severity: "warning",
      disposition: null,
      location: { field: "body_markdown", line_start: 1 },
    });
    expect(repository.findingReviewSets[0]?.finding_ids).toContain(warning.id);
    expect(repository.runState(run.run_id)).toEqual({
      status: "waiting",
      current_step: "findings_review",
    });
  });

  it("freezes the Step 1.6 advisory-unavailable warning into Step 1.9 for disposition", async () => {
    const { repository, run } = await setup("m3-information-gain-fallback");
    const base = new MockReviewProvider("review-v1");
    const provider = {
      provider: base.provider,
      model: base.model,
      review: async (request: Parameters<typeof base.review>[0]) => {
        const response = await base.review(request);
        return request.step === "review_information_gain"
          ? {
              ...response,
              findings: [
                {
                  stable_key: "value-advisory-unavailable",
                  category: "information_gain_advisory_unavailable",
                  rule_reference: "value.advisory_unavailable",
                  severity: "warning" as const,
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
    const warning = repository.findings.find(
      (finding) => finding.rule_reference === "value.advisory_unavailable",
    )!;
    expect(warning).toMatchObject({
      step: "review_information_gain",
      severity: "warning",
      disposition: null,
      location: { field: "body_markdown", line_start: 1 },
    });
    expect(repository.findingReviewSets[0]?.finding_ids).toContain(warning.id);
    expect(repository.runState(run.run_id)).toEqual({
      status: "waiting",
      current_step: "findings_review",
    });
  });

  it("persists 1.4–1.8 outputs without changing the immutable draft and waits at 1.9", async () => {
    const { repository, run } = await setup();
    const before = structuredClone((await repository.getDraft(run.run_id))!.draft);
    const provider = new MockReviewProvider("review-v1", { review_writing_style: [modelFinding] });
    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
    expect(repository.runState(run.run_id)).toEqual({
      status: "waiting",
      current_step: "findings_review",
    });
    expect((await repository.getDraft(run.run_id))!.draft).toEqual(before);
    expect(provider.calls).toHaveLength(4);
    expect(
      repository.providerUsage.filter((item) => item.operation.startsWith("review_")),
    ).toHaveLength(4);
    expect(repository.artifacts.filter((item) => item.kind === "review_request")).toHaveLength(4);
    // Includes the four Step 1.3 mapped snapshots plus five snapshots across Steps 1.4–1.8.
    expect(repository.referenceSnapshots).toHaveLength(9);
    expect(repository.claims).toHaveLength(2);
    expect(repository.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provenance",
          status: "unverified",
          hard_flag: true,
          evidence: expect.any(String),
        }),
      ]),
    );
  });

  it("retries after_review_provider without duplicate durable records or draft mutation", async () => {
    const { repository, run } = await setup();
    const draftBefore = structuredClone(await repository.getDraft(run.run_id));
    const documentVersionsBefore = structuredClone(repository.documentVersions);
    const provider = new MockReviewProvider("review-v1", {
      review_writing_style: [modelFinding],
    });

    await expect(
      new MilestoneThreeOrchestrator(
        repository,
        fixture,
        provider,
        new OnceFailure("after_review_provider"),
      ).run(run.run_id),
    ).rejects.toThrow("injected:after_review_provider");
    expect(repository.artifacts.filter((item) => item.kind === "review_request")).toHaveLength(0);
    expect(
      repository.providerUsage.filter((item) => item.operation.startsWith("review_")),
    ).toHaveLength(0);

    await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);

    // The first external response was not durably saved, so the retry necessarily
    // calls the provider again with the same deterministic request identity.
    expect(provider.calls).toHaveLength(5);
    expect(provider.calls[0]).toEqual(provider.calls[1]);
    expect(repository.artifacts.filter((item) => item.kind === "review_request")).toHaveLength(4);
    expect(
      repository.providerUsage.filter((item) => item.operation.startsWith("review_")),
    ).toHaveLength(4);
    expect(repository.claims).toHaveLength(2);
    for (const records of [repository.findings, repository.artifacts, repository.providerUsage]) {
      const ids = records.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const stableKeys = repository.findings.map((item) => item.stable_key);
    expect(new Set(stableKeys).size).toBe(stableKeys.length);
    expect(await repository.getDraft(run.run_id)).toEqual(draftBefore);
    expect(repository.documentVersions).toEqual(documentVersionsBefore);
  });

  for (const boundary of ["after_deterministic_persist", "after_review_persist"] as const) {
    it(`resumes after ${boundary} without duplicate durable records`, async () => {
      const { repository, run } = await setup();
      const provider = new MockReviewProvider("review-v1", {
        review_writing_style: [modelFinding],
      });
      await expect(
        new MilestoneThreeOrchestrator(
          repository,
          fixture,
          provider,
          new OnceFailure(boundary),
        ).run(run.run_id),
      ).rejects.toThrow("injected");
      await new MilestoneThreeOrchestrator(repository, fixture, provider).run(run.run_id);
      const keys = repository.findings.map((item) => item.stable_key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(
        repository.providerUsage.filter((item) => item.operation.startsWith("review_")),
      ).toHaveLength(4);
      expect(repository.claims).toHaveLength(2);
    });
  }

  it("rejects immutable source conflicts in the in-memory repository", async () => {
    const { repository, run } = await setup("m3-immutable-source-conflict");
    const draftRecord = (await repository.getDraft(run.run_id))!;
    const lease = await repository.claimStep(run.run_id, "review_fact_checking", "test");
    const reviewRequest = {
      run_id: run.run_id,
      step: "review_fact_checking" as const,
      document_version_id: draftRecord.version.id,
      handoff,
      draft: draftRecord.draft,
      internal_links: [],
      reference_snapshots: [],
      fact_inventory: [],
      prompt: { template_id: "test", template_version: "1" },
      temperature: 0,
      model: "test",
    };
    const source = {
      stable_key: "source-one",
      uri: "mock://immutable/source",
      title: "Original title",
      source_type: "unresolved" as const,
      retrieved_at: "2025-01-01T00:00:00.000Z",
      snapshot: { reason: "same snapshot" },
      evidence: "Original evidence",
    };
    repository.sources.push({
      ...source,
      title: "Conflicting title",
      run_id: run.run_id,
      content_hash: createHash("sha256").update(JSON.stringify(source.snapshot)).digest("hex"),
    });
    await expect(
      repository.saveReview(
        run.run_id,
        draftRecord.version.id,
        lease.execution_id,
        lease.token,
        "review_fact_checking",
        reviewRequest,
        {
          ...ReviewResponseSchema.parse({
            request_id: "immutable-source",
            findings: [],
            sources: [source],
            claims: [],
            usage: { input_units: 0, output_units: 0, cost_micros: 0 },
          }),
          findings: [],
        },
        "test",
        "test",
      ),
    ).rejects.toThrow("Immutable source conflict");
  });

  it("completes an empty review set atomically with an auditable output", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "m3-empty-review", repository);
    const passingDraft = {
      ...draft,
      markdown:
        "# Designer chair guide\n\nA practical answer with enough context and a [chair collection](https://www.mobelaris.com/chairs).\n\n## Key Takeaways\n\n- Compare scale.\n- Check materials.\n- Plan delivery.\n\n## Conclusion\n\nChoose carefully.",
      claims: [],
    };
    await new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
      ]),
      new MockDraftProvider("draft-v1", passingDraft),
    ).run(run.run_id);
    // Force deterministic checks to be represented by an immutable empty output
    // while all model reviews also return no findings.
    const originalSave = repository.saveFindings.bind(repository);
    repository.saveFindings = (runId, documentId, executionId, token) =>
      originalSave(runId, documentId, executionId, token, []);
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    expect(repository.runState(run.run_id)).toEqual({
      status: "running",
      current_step: "revision_pass",
    });
    expect(repository.findingReviewSets).toEqual([
      expect.objectContaining({ run_id: run.run_id, finding_ids: [] }),
    ]);
    expect(repository.findingReviewSubmissions).toEqual([
      expect.objectContaining({ run_id: run.run_id, finding_count: 0 }),
    ]);
  });

  it("rejects cancelled, stale-document and cross-run disposition replays", async () => {
    const complete = async (
      repository: InMemoryMilestoneRepository,
      runId: string,
      key: string,
    ) => {
      await new MilestoneThreeOrchestrator(
        repository,
        fixture,
        new MockReviewProvider("review-v1"),
      ).run(runId);
      const findings = await repository.listFindings(runId, {});
      const version = (await repository.getDraft(runId))!.version;
      const input = {
        document_version_id: version.id,
        idempotency_key: key,
        dispositions: findings.map((finding) => ({
          finding_id: finding.id,
          decision: "accepted" as const,
        })),
      };
      await repository.submitDispositions(runId, input);
      return input;
    };

    const cancelled = await setup("m3-cancelled-replay");
    const cancelledInput = await complete(
      cancelled.repository,
      cancelled.run.run_id,
      "cancelled-replay-key",
    );
    await cancelled.repository.cancelRun(cancelled.run.run_id);
    await expect(
      cancelled.repository.submitDispositions(cancelled.run.run_id, cancelledInput),
    ).rejects.toBeInstanceOf(ConflictError);

    const stale = await setup("m3-stale-replay");
    const staleInput = await complete(stale.repository, stale.run.run_id, "stale-replay-key");
    const state = (stale.repository as any).runs.get(stale.run.run_id);
    state.draft.version = { ...state.draft.version, id: "advanced-document", revision: 2 };
    await expect(
      stale.repository.submitDispositions(stale.run.run_id, staleInput),
    ).rejects.toBeInstanceOf(ConflictError);

    const first = await setup("m3-cross-run-a");
    const firstInput = await complete(first.repository, first.run.run_id, "cross-run-replay-key");
    const secondRun = await ingestHandoff(handoff, "m3-cross-run-b", first.repository);
    await new MilestoneTwoOrchestrator(
      first.repository,
      new MockLinkDiscoverer([
        { url: "https://www.mobelaris.com/chairs", title: "Chairs", relevance: 1 },
      ]),
      new MockDraftProvider("draft-v1", draft),
    ).run(secondRun.run_id);
    await new MilestoneThreeOrchestrator(
      first.repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(secondRun.run_id);
    const secondFindings = await first.repository.listFindings(secondRun.run_id, {});
    const secondVersion = (await first.repository.getDraft(secondRun.run_id))!.version;
    await expect(
      first.repository.submitDispositions(secondRun.run_id, {
        ...firstInput,
        document_version_id: secondVersion.id,
        dispositions: secondFindings.map((finding) => ({
          finding_id: finding.id,
          decision: "accepted" as const,
        })),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("bulk-disposes findings and completes only when every current-document finding is decided", async () => {
    const { repository, run } = await setup();
    await new MilestoneThreeOrchestrator(
      repository,
      fixture,
      new MockReviewProvider("review-v1"),
    ).run(run.run_id);
    const findings = await repository.listFindings(run.run_id, {});
    const version = (await repository.getDraft(run.run_id))!.version;
    const dispositions = findings.map((finding) => ({
      finding_id: finding.id,
      decision: "accepted" as const,
      rationale: "Bulk accepted",
    }));
    const first = await repository.submitDispositions(run.run_id, {
      document_version_id: version.id,
      idempotency_key: "milestone-three-decision",
      dispositions,
    });
    expect(first).toEqual({
      completed: true,
      submitted: findings.length,
      continuation_required: true,
    });
    expect(
      await repository.submitDispositions(run.run_id, {
        document_version_id: version.id,
        idempotency_key: "milestone-three-decision",
        dispositions: dispositions.map((item) => ({ ...item, rationale: "  Bulk accepted  " })),
      }),
    ).toEqual({ completed: true, submitted: findings.length, continuation_required: false });
    await expect(
      repository.submitDispositions(run.run_id, {
        document_version_id: version.id,
        idempotency_key: "milestone-three-decision",
        dispositions: dispositions.map((item, index) =>
          index === 0 ? { ...item, decision: "rejected" as const } : item,
        ),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await repository.listFindings(run.run_id, {}))[0]?.rationale).toBe("Bulk accepted");
    expect(repository.runState(run.run_id)).toEqual({
      status: "running",
      current_step: "revision_pass",
    });
    // The run is resting, waiting for an explicit resume trigger into
    // milestone four — the operator must see a way to continue, not a dead end.
    expect((await repository.getRunDetail(run.run_id)).can_retry).toBe(true);
    expect((await repository.getDraft(run.run_id))!.draft).toEqual(draft);
  });
});

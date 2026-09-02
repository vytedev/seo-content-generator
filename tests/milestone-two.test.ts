import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  renderExport,
} from "../src/shared/export.js";
import {
  IdempotencyConflictError,
  StructuredDraftSchema,
  ingestHandoff,
} from "../src/shared/milestone-two.js";
import {
  MilestoneTwoOrchestrator,
  MockLinkDiscoverer,
  type FailureBoundary,
} from "../src/server/orchestrator.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockGoogleDocsAdapter } from "../src/server/providers/google-docs.js";
import { readStoredStructuredDraft } from "../src/shared/contracts/content.js";

const handoff = {
  plane_ticket: "MOB-123",
  primary_keyword: "designer dining chairs",
  related_keywords: ["modern dining chair"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};

async function setup() {
  const repository = new InMemoryMilestoneRepository();
  const result = await ingestHandoff(handoff, "MOB-123", repository);
  const provider = new MockDraftProvider("mock-draft-2025-01");
  return { repository, result, provider };
}

class OnceFailure {
  private fired = false;
  constructor(private readonly boundary: FailureBoundary) {}
  hit(boundary: FailureBoundary) {
    if (!this.fired && boundary === this.boundary) {
      this.fired = true;
      throw new Error(`injected:${boundary}`);
    }
  }
}

describe("milestone two", () => {
  it("strictly validates ingest and treats SERP composition mismatch as warning only", async () => {
    const repository = new InMemoryMilestoneRepository();
    await expect(ingestHandoff({ ...handoff, extra: true }, "bad", repository)).rejects.toThrow();
    const result = await ingestHandoff(handoff, "key", repository, {
      inspect: async () => ({ informational: 2, commercial: 8 }),
    });
    expect(result.warnings).toEqual([
      { code: "serp_composition_mismatch", message: expect.any(String) },
    ]);
    expect(await repository.stepSucceeded(result.run_id, "ingest_handoff")).toBe(true);
  });

  it("replays identical ingest and conflicts deterministically", async () => {
    const repository = new InMemoryMilestoneRepository();
    const first = await ingestHandoff(handoff, "same", repository);
    expect(await ingestHandoff({ ...handoff }, "same", repository)).toEqual(first);
    await expect(
      ingestHandoff({ ...handoff, word_count_target: 901 }, "same", repository),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects malformed structured provider output", () => {
    expect(
      StructuredDraftSchema.safeParse({
        title: "X",
        slug: "Bad Slug",
        meta_description: "x",
        markdown: "x",
        claims: [],
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("requires the new draft-owned on-page fields and rejects unknown keys", () => {
    const base = {
      title: "X",
      slug: "x",
      meta_description: "x",
      og_title: "X",
      og_description: "x",
      images: [],
      faqs: [],
      markdown: "x",
      claims: [],
    };
    expect(StructuredDraftSchema.safeParse(base).success).toBe(true);
    for (const field of ["og_title", "og_description", "images", "faqs"])
      expect(StructuredDraftSchema.safeParse({ ...base, [field]: undefined }).success).toBe(false);
    expect(StructuredDraftSchema.safeParse({ ...base, og_title: "" }).success).toBe(false);
    expect(StructuredDraftSchema.safeParse({ ...base, og_description: "" }).success).toBe(false);
    expect(
      StructuredDraftSchema.safeParse({
        ...base,
        images: [{ alt: "x", filename: "x", placement: { marker: "x" }, bad: 1 }],
      }).success,
    ).toBe(false);
    expect(StructuredDraftSchema.safeParse({ ...base, faqs: [{ question: "q" }] }).success).toBe(
      false,
    );
    expect(StructuredDraftSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("forces one fresh Step 1.2 attempt after success without rerunning paid draft", async () => {
    const { repository, result, provider } = await setup();
    const discover = vi
      .fn()
      .mockResolvedValueOnce([
        {
          url: "https://www.example.com/products/original",
          title: "Original",
          primary_topic: "chair",
          relevance: 1,
          status: 200,
          hierarchy: "product",
          source: "sitemap",
          verified_at: new Date().toISOString(),
        },
      ])
      .mockResolvedValueOnce({
        availability: "available",
        eligibility: "eligible",
        reason: "verified_commercial_candidates",
        links: [
          {
            url: "https://www.example.com/products/refreshed",
            title: "Refreshed",
            primary_topic: "chair",
            relevance: 1,
            status: 200,
            hierarchy: "product",
            source: "sitemap",
            verified_at: new Date().toISOString(),
          },
        ],
        providerStatus: { sitemap: "available", gsc: "not_configured" },
        counts: {
          ghost_collected: 0,
          sitemap_collected: 1,
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
        cache: { state: "refreshed", retrieved_at: null, expires_at: null },
        identity: {
          query_hash: "a".repeat(64),
          config_hash: "b".repeat(64),
          origin_policy_hash: "c".repeat(64),
          request_hash: "d".repeat(64),
        },
      });
    const orchestrator = new MilestoneTwoOrchestrator(repository, { discover }, provider);
    await orchestrator.run(result.run_id);
    expect(provider.calls).toHaveLength(1);
    await orchestrator.run(result.run_id, "refresh-worker", { refreshLinkDiscovery: true });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1]?.[1]).toEqual({ refresh: true });
    expect(provider.calls).toHaveLength(1);
    expect(repository.attempts(result.run_id, "internal_link_discovery")).toHaveLength(2);
    expect((await repository.getLinks(result.run_id))?.[0]?.url).toContain("original");
    expect(
      (await repository.getRunDetail(result.run_id)).link_discovery.metadata?.cache.state,
    ).toBe("refreshed");
  });

  it("blocks drafting before model spend when discovery has no verified commercial link", async () => {
    const { repository, result, provider } = await setup();
    await expect(
      new MilestoneTwoOrchestrator(
        repository,
        {
          discover: async () => ({
            availability: "available" as const,
            eligibility: "blocked" as const,
            reason: "editorial_only" as const,
            links: [],
            providerStatus: { ghost: "available" as const, gsc: "not_configured" as const },
            counts: {
              ghost_collected: 3,
              gsc_collected: 0,
              deduplicated: 3,
              commercial: 0,
              editorial: 3,
              verification_attempted: 0,
              direct_200: 0,
              rejected_non_200: 0,
              unresolved: 0,
              shortlisted: 0,
            },
            cache: { state: "miss" as const, retrieved_at: null, expires_at: null },
            identity: {
              query_hash: "a".repeat(64),
              config_hash: "b".repeat(64),
              origin_policy_hash: "c".repeat(64),
              request_hash: "d".repeat(64),
            },
          }),
        },
        provider,
      ).run(result.run_id),
    ).rejects.toThrow("editorial pages only");
    expect(provider.calls).toHaveLength(0);
    expect(await repository.getLinks(result.run_id)).toBeNull();
    expect((await repository.getRunDetail(result.run_id)).link_discovery.metadata).toMatchObject({
      eligibility: "blocked",
      reason: "editorial_only",
      counts: { editorial: 3, shortlisted: 0 },
    });
  });

  it("persists immutable evidence when the local bypass is enabled and used", async () => {
    const { repository, result, provider } = await setup();
    await new MilestoneTwoOrchestrator(
      repository,
      {
        discover: async () => ({
          availability: "unavailable" as const,
          eligibility: "blocked" as const,
          reason: "source_unavailable" as const,
          links: [],
          providerStatus: { sitemap: "not_configured" as const, gsc: "not_configured" as const },
          counts: {
            ghost_collected: 0,
            sitemap_collected: 0,
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
          cache: { state: "miss" as const, retrieved_at: null, expires_at: null },
          identity: {
            query_hash: "a".repeat(64),
            config_hash: "b".repeat(64),
            origin_policy_hash: "c".repeat(64),
            request_hash: "d".repeat(64),
          },
        }),
      },
      provider,
      undefined,
      true,
    ).run(result.run_id);
    expect((await repository.getRunDetail(result.run_id)).link_discovery.metadata).toMatchObject({
      eligibility: "blocked",
      bypass: {
        enabled: true,
        used: true,
        reason: "local_unverified_link_testing",
      },
    });
    expect(await repository.getLinks(result.run_id)).toEqual([]);
    expect(provider.calls[0]?.internal_links).toEqual([]);
  });

  it("passes the exact persisted Step 1.2 shortlist to Step 1.3", async () => {
    const { repository, result, provider } = await setup();
    const shortlist = [
      {
        url: "https://mobelaris.com/collections/chairs",
        title: "Designer chairs",
        relevance: 0.9,
        status: 200,
        hierarchy: "collection" as const,
        hierarchy_rank: 1,
      },
    ];
    await new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(shortlist), provider).run(
      result.run_id,
    );
    expect(provider.calls[0]?.internal_links).toEqual(shortlist);
    expect(await repository.getLinks(result.run_id)).toEqual(shortlist);
  });

  it("produces new on-page fields from the default mock provider output", async () => {
    const provider = new MockDraftProvider("mock-v1");
    const response = await provider.generate({
      handoff,
      internal_links: [],
      model: provider.model,
    });
    expect(response.draft.og_title).toContain(handoff.primary_keyword);
    expect(response.draft.og_description.length).toBeGreaterThan(0);
    expect(response.draft.images).toHaveLength(1);
    expect(response.draft.faqs).toHaveLength(3);
  });

  it("upgrades legacy stored drafts only through the read adapter and reports derived fields", () => {
    const legacy = {
      title: "X",
      slug: "x",
      meta_description: "x",
      markdown: "x",
      claims: [],
    };
    const upgraded = readStoredStructuredDraft(legacy);
    // meta_title is now a distinct stored field, so a wholly legacy draft
    // derives it alongside the other absent on-page fields.
    expect(upgraded.legacy_derived_fields).toEqual([
      "meta_title",
      "og_title",
      "og_description",
      "images",
      "faqs",
    ]);
    expect(upgraded.draft.images).toEqual([]);
    expect(upgraded.draft.faqs).toEqual([]);
    expect(StructuredDraftSchema.parse(upgraded.draft)).toEqual(upgraded.draft);

    const intermediate = {
      ...legacy,
      og_title: "Existing OG title",
      og_description: "Existing OG description",
      faqs: [{ question: "Existing question?", answer: "Existing answer." }],
      images: [{ alt: "Existing image alt", filename: "existing-image.jpg" }],
    };
    const upgradedIntermediate = readStoredStructuredDraft(intermediate);
    expect(upgradedIntermediate).toEqual({
      draft: { ...intermediate, images: [] },
      legacy_derived_fields: ["meta_title", "images"],
    });
    expect(StructuredDraftSchema.parse(upgradedIntermediate.draft)).toEqual(
      upgradedIntermediate.draft,
    );

    const current = {
      ...intermediate,
      // A fully current draft stores meta_title explicitly, so nothing is derived.
      meta_title: "Existing meta title",
      markdown: "Copy\n\n<!-- MOBELARIS_IMAGE:existing-image -->",
      images: [
        {
          alt: "Existing image alt",
          filename: "existing-image.jpg",
          placement: { marker: "existing-image" },
        },
      ],
    };
    expect(readStoredStructuredDraft(current)).toEqual({
      draft: current,
      legacy_derived_fields: [],
    });

    // Historical shapes are never accepted as new provider output.
    expect(StructuredDraftSchema.safeParse(legacy).success).toBe(false);
    expect(StructuredDraftSchema.safeParse(intermediate).success).toBe(false);
    // Unknown shapes still fail the adapter rather than silently defaulting.
    expect(() => readStoredStructuredDraft({ title: "X" })).toThrow();
  });

  it("validates draft responses before fences or side effects", async () => {
    const { repository, result } = await setup();
    const lease = await repository.claimStep(result.run_id, "internal_link_discovery", "worker");
    const before = {
      artifacts: repository.artifacts.length,
      versions: repository.documentVersions.length,
      usage: repository.providerUsage.length,
    };
    await expect(
      repository.saveDraft(
        result.run_id,
        lease.execution_id,
        "wrong-token",
        { request_id: "bad" } as never,
        {} as never,
      ),
    ).rejects.toThrow();
    expect({
      artifacts: repository.artifacts.length,
      versions: repository.documentVersions.length,
      usage: repository.providerUsage.length,
    }).toEqual(before);
  });

  it("recovers expired attempts and binds persistence fences to the supplied run", async () => {
    let now = 1_000;
    const repository = new InMemoryMilestoneRepository(100, () => now);
    const firstRun = await ingestHandoff(handoff, "first-run", repository);
    const otherRun = await ingestHandoff(
      { ...handoff, plane_ticket: "MOB-OTHER" },
      "other-run",
      repository,
    );
    const expired = await repository.claimStep(
      firstRun.run_id,
      "internal_link_discovery",
      "worker",
    );
    await expect(
      repository.saveLinks(otherRun.run_id, expired.execution_id, expired.token, []),
    ).rejects.toThrow("Stale fencing token");
    now += 101;
    const retry = await repository.claimStep(
      firstRun.run_id,
      "internal_link_discovery",
      "worker-2",
    );
    expect(repository.attempts(firstRun.run_id, "internal_link_discovery")[0]).toMatchObject({
      status: "retryable_failed",
      error: "lease expired",
    });
    await repository.completeStep(retry.execution_id, retry.token);
    const draftLease = await repository.claimStep(firstRun.run_id, "draft", "worker");
    const provider = new MockDraftProvider("mock-v1");
    const response = await provider.generate({
      handoff,
      internal_links: [],
      model: provider.model,
    });
    await expect(
      repository.saveDraft(
        otherRun.run_id,
        draftLease.execution_id,
        draftLease.token,
        response,
        {} as never,
      ),
    ).rejects.toThrow("Stale fencing token");
  });

  for (const boundary of ["after_link_persist", "after_provider", "after_draft_persist"] as const) {
    it(`resumes after ${boundary} without duplicate durable draft records`, async () => {
      const { repository, result, provider } = await setup();
      const first = new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer([
          { url: "https://mobelaris.com/blog/example", title: "Example", relevance: 0.8 },
        ]),
        provider,
        new OnceFailure(boundary),
      );
      await expect(first.run(result.run_id)).rejects.toThrow(`injected:${boundary}`);
      await new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(), provider).run(
        result.run_id,
      );
      expect(await repository.stepSucceeded(result.run_id, "draft")).toBe(true);
      expect(repository.artifacts.filter((artifact) => artifact.kind === "draft")).toHaveLength(1);
      expect(
        repository.artifacts.filter((artifact) => artifact.kind === "internal_links"),
      ).toHaveLength(1);
      expect(repository.documentVersions).toHaveLength(1);
      expect(repository.providerUsage).toHaveLength(1);
      const draftArtifact = repository.artifacts.find((artifact) => artifact.kind === "draft");
      expect(repository.documentVersions[0]).toMatchObject({
        parent_id: null,
        revision: 1,
        artifact_id: draftArtifact?.id,
      });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]).toMatchObject({
        prompt: provider.prompt,
        reference_snapshots: expect.arrayContaining([
          expect.objectContaining({ kind: "blog_writing_guide", content: expect.any(String) }),
          expect.objectContaining({ kind: "writer_submission_sample" }),
          expect.objectContaining({ kind: "keyword_placement_guidelines" }),
          expect.objectContaining({ kind: "internal_linking_guidelines" }),
        ]),
      });
      expect(
        provider.calls[0]?.reference_snapshots?.map((snapshot) => snapshot.kind),
      ).not.toContain("fact_checking_rules");
      expect(repository.artifacts.some((artifact) => artifact.kind === "draft_request")).toBe(true);
      await new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(), provider).run(
        result.run_id,
      );
      expect(repository.artifacts.filter((artifact) => artifact.kind === "draft")).toHaveLength(1);
      expect(repository.providerUsage).toHaveLength(1);
    });
  }

  it("logs checkpoint replay without dispatching the provider again", async () => {
    const { repository, result, provider } = await setup();
    const first = new MilestoneTwoOrchestrator(
      repository,
      new MockLinkDiscoverer([
        { url: "https://mobelaris.com/blog/example", title: "Example", relevance: 0.8 },
      ]),
      provider,
      new OnceFailure("after_provider"),
    );
    await expect(first.run(result.run_id)).rejects.toThrow("injected:after_provider");
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(), provider).run(
      result.run_id,
      "replay-worker",
    );
    expect(provider.calls).toHaveLength(1);
    expect(output.filter((line) => line.includes('"event":"provider.replayed"'))).toHaveLength(1);
    expect(output.some((line) => line.includes('"event":"provider.dispatch_started"'))).toBe(false);
    write.mockRestore();
  });

  for (const boundary of ["after_draft_reservation", "after_provider_return"] as const) {
    it(`fails closed after ${boundary} without a duplicate provider call`, async () => {
      const { repository, result, provider } = await setup();
      const first = new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer([
          { url: "https://mobelaris.com/blog/example", title: "Example", relevance: 0.8 },
        ]),
        provider,
        new OnceFailure(boundary),
      );
      await expect(first.run(result.run_id)).rejects.toThrow(`injected:${boundary}`);
      await expect(
        new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(), provider).run(
          result.run_id,
          "resume-worker",
        ),
      ).rejects.toThrow("Draft provider outcome is ambiguous");
      expect(provider.calls).toHaveLength(boundary === "after_provider_return" ? 1 : 0);
      const ambiguity = (await repository.getRunDetail(result.run_id)).paid_operation_ambiguities;
      expect(ambiguity).toHaveLength(1);
      expect(ambiguity[0]).toMatchObject({
        kind: "draft",
        owner: expect.stringMatching(/^step_execution:/),
      });
      expect(ambiguity[0]!.owner).not.toContain("technical-owner");
      expect(await repository.getDraft(result.run_id)).toBeNull();
      expect(repository.providerUsage).toHaveLength(0);
    });
  }

  it("renders canonical export deterministically and mock export replays", async () => {
    const { repository, result, provider } = await setup();
    await new MilestoneTwoOrchestrator(repository, new MockLinkDiscoverer(), provider).run(
      result.run_id,
    );
    const draft = (await repository.getDraft(result.run_id))!.draft;
    const templates = {
      writer_template: DEFAULT_WRITER_TEMPLATE,
      schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
    };
    const first = renderExport({ plane_ticket: handoff.plane_ticket, draft, ...templates });
    expect(renderExport({ plane_ticket: handoff.plane_ticket, draft, ...templates })).toEqual(
      first,
    );
    expect(first.markdown).toContain("Plane ticket: MOB-123");
    const adapter = new MockGoogleDocsAdapter();
    const exported = await adapter.export("export-1", first);
    expect(exported.replayed).toBe(false);
    expect(await adapter.export("export-1", first)).toEqual({ ...exported, replayed: true });
    await expect(
      adapter.export("export-1", { ...first, content_hash: "a".repeat(64) }),
    ).rejects.toThrow("conflict");
  });
});

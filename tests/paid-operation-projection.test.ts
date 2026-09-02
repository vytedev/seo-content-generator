import { describe, expect, it } from "vitest";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

describe("memory paid-operation ambiguity projection", () => {
  it("projects the real draft operation and producing execution owner", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "projection-draft", repository);
    const provider = new MockDraftProvider("draft-v1");
    await expect(
      new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer([]),
        provider,
        {
          hit(boundary) {
            if (boundary === "after_draft_reservation") throw new Error("reserved");
          },
        },
        true,
      ).run(run.run_id, "projection-worker"),
    ).rejects.toThrow("reserved");

    expect(provider.calls).toHaveLength(0);
    const ambiguities = (await repository.getRunDetail(run.run_id)).paid_operation_ambiguities;
    expect(ambiguities).toHaveLength(1);
    expect(ambiguities[0]).toMatchObject({
      kind: "draft",
      stage: "provider_in_flight",
      exposure: "possible_provider_spend",
      owner: expect.stringMatching(/^step_execution:/),
      ambiguity_reason: "provider_in_flight_without_checkpoint",
    });
    expect(ambiguities[0]!.owner).not.toContain("technical-owner");
  });
});

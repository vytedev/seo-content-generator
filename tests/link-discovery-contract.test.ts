import { describe, expect, it } from "vitest";
import {
  InternalLinkSchema as BrowserSafeInternalLinkSchema,
  LinkDiscoveryMetadataSchema as BrowserSafeLinkDiscoveryMetadataSchema,
} from "../src/shared/contracts/link-discovery.js";
import { RunDetailSchema } from "../src/shared/contracts/run-detail.js";
import {
  InternalLinkSchema as CompatibilityInternalLinkSchema,
  LinkDiscoveryMetadataSchema as CompatibilityLinkDiscoveryMetadataSchema,
} from "../src/shared/milestone-two.js";

describe("browser-safe link discovery contracts", () => {
  it("keeps milestone-two compatibility exports bound to the canonical schemas", () => {
    expect(CompatibilityInternalLinkSchema).toBe(BrowserSafeInternalLinkSchema);
    expect(CompatibilityLinkDiscoveryMetadataSchema).toBe(BrowserSafeLinkDiscoveryMetadataSchema);
  });

  it("parses historical Ghost artefacts with compatibility defaults", () => {
    const parsed = BrowserSafeLinkDiscoveryMetadataSchema.parse({
      availability: "available",
      providerStatus: { ghost: "available", gsc: "not_configured" },
      counts: {
        ghost_collected: 2,
        gsc_collected: 0,
        deduplicated: 2,
        commercial: 1,
        editorial: 1,
        verification_attempted: 1,
        direct_200: 1,
        rejected_non_200: 0,
        unresolved: 0,
        shortlisted: 1,
      },
    });
    expect(parsed.providerStatus.ghost).toBe("available");
    expect(parsed.bypass).toEqual({ enabled: false, used: false, reason: null });
    expect(
      BrowserSafeInternalLinkSchema.parse({
        url: "https://www.mobelaris.com/products/chair",
        title: "Chair",
        relevance: 0.8,
        source: "ghost_content",
        ghost_id: "ghost-1",
        ghost_content_type: "page",
      }),
    ).toMatchObject({ ghost_id: "ghost-1" });
  });

  it("rejects inconsistent bypass evidence", () => {
    expect(
      BrowserSafeLinkDiscoveryMetadataSchema.safeParse({
        availability: "unavailable",
        providerStatus: { sitemap: "unavailable", gsc: "not_configured" },
        bypass: { enabled: false, used: true, reason: "local_unverified_link_testing" },
      }).success,
    ).toBe(false);
  });

  it("validates run-detail link discovery without server contracts", () => {
    const parsed = RunDetailSchema.shape.link_discovery.parse({
      shortlist: [
        {
          url: "https://www.mobelaris.com/collections/chairs",
          title: "Designer chairs",
          relevance: 0.9,
        },
      ],
      metadata: {
        availability: "available",
        providerStatus: { sitemap: "available", gsc: "not_connected" },
      },
    });

    expect(parsed.shortlist).toHaveLength(1);
    expect(parsed.metadata?.eligibility).toBe("eligible");
    expect(parsed.metadata?.counts.shortlisted).toBe(0);
  });
});

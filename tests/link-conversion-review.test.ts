import { describe, expect, it, vi } from "vitest";
import {
  LinkVerificationOutcomeSchema,
  NoNetworkDraftLinkVerifier,
  auditDraftLinks,
  classifyInternalLinkHierarchy,
  type DraftLinkVerifier,
} from "../src/shared/link-conversion-review.js";
import type { InternalLink, StructuredDraft } from "../src/shared/milestone-two.js";

const draft = (markdown: string): StructuredDraft => ({
  title: "Chair guide",
  slug: "chair-guide",
  meta_description: "A chair guide.",
  og_title: "Chair guide",
  og_description: "A chair guide.",
  images: [],
  faqs: [],
  claims: [],
  markdown,
});
const shortlist: InternalLink[] = [
  {
    title: "Dining chairs",
    url: "https://www.mobelaris.com/collections/dining-chairs",
    relevance: 0.9,
    hierarchy: "collection",
    hierarchy_rank: 1,
    status: 200,
  },
  {
    title: "Lounge chair",
    url: "https://www.mobelaris.com/products/lounge-chair",
    relevance: 1,
    hierarchy: "product",
    hierarchy_rank: 4,
    status: 200,
  },
];
const input = (markdown: string) => ({
  draft: draft(markdown),
  shortlist,
  internal_origins: ["https://www.mobelaris.com"],
});

describe("deterministic Step 1.8 link audit", () => {
  it("classifies Mobelaris locale-prefixed flat product routes consistently", () => {
    expect(
      classifyInternalLinkHierarchy(
        "https://www.mobelaris.com/en/style-charles-eames-dining-chair",
      ),
    ).toBe("product");
    expect(classifyInternalLinkHierarchy("https://www.mobelaris.com/en")).toBe("broad_category");
  });

  it("verifies every unique canonical shortlist target once and supplies model-safe context", async () => {
    const verify = vi.fn(async (url: string) => ({
      outcome: "direct_200" as const,
      method: "head" as const,
      verified_at: "2026-01-01T00:00:00.000Z",
      hierarchy: url.includes("products") ? ("product" as const) : ("collection" as const),
    }));
    const result = await auditDraftLinks(
      input(
        "# Guide\n\nSee [this chair](https://www.mobelaris.com/products/lounge-chair/?utm_source=x) beside a table.\n\nAgain, [compare the lounge chair](https://www.mobelaris.com/products/lounge-chair).",
      ),
      { verify },
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("https://www.mobelaris.com/products/lounge-chair");
    expect(result.findings).toEqual([]);
    expect(result.review_context.occurrences).toHaveLength(2);
    expect(result.review_context.occurrences[0]).toMatchObject({
      anchor: "this chair",
      location: { field: "body_markdown", line_start: 3 },
      context: expect.stringContaining("beside a table"),
    });
    expect(result.review_context.shortlist[0]).not.toHaveProperty("status");
  });

  it("canonicalises relative and tracked shortlist occurrences", async () => {
    const verify = vi.fn(async () => ({
      outcome: "direct_200" as const,
      method: "head" as const,
      verified_at: "2026-01-01T00:00:00.000Z",
      hierarchy: "collection" as const,
    }));
    const result = await auditDraftLinks(
      input("See [dining chairs](/collections/dining-chairs/?utm_source=email#sizes)."),
      { verify },
    );
    expect(result.findings).toEqual([]);
    expect(verify).toHaveBeenCalledWith("https://www.mobelaris.com/collections/dining-chairs");
  });

  it("makes confirmed non-200 and redirect outcomes mutually exclusive", () => {
    expect(() =>
      LinkVerificationOutcomeSchema.parse({
        outcome: "confirmed_non_200",
        method: "head",
        status: 200,
      }),
    ).toThrow();
    expect(() =>
      LinkVerificationOutcomeSchema.parse({
        outcome: "confirmed_non_200",
        method: "head",
        status: 301,
      }),
    ).toThrow();
    expect(
      LinkVerificationOutcomeSchema.parse({
        outcome: "confirmed_non_200",
        method: "head",
        status: 404,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      LinkVerificationOutcomeSchema.parse({ outcome: "redirect", method: "head", status: 301 }),
    ).toMatchObject({ outcome: "redirect" });
  });

  it("never requests external or off-shortlist targets and reports membership first", async () => {
    const verify = vi.fn();
    const result = await auditDraftLinks(
      input(
        "[External](https://example.com/a) and [unapproved](https://www.mobelaris.com/products/nope).",
      ),
      { verify } as DraftLinkVerifier,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(result.findings.map((item) => item.rule_reference)).toEqual([
      "link.shortlist_membership",
    ]);
  });

  it.each([
    [{ outcome: "confirmed_non_200", method: "head", status: 404 } as const, "link.target_status"],
    [
      { outcome: "redirect", method: "head", status: 301, location: "/new" } as const,
      "link.target_redirect",
    ],
    [{ outcome: "unresolved_transport", reason: "timeout" } as const, "link.target_unresolved"],
  ])("maps typed verification outcome %# to %s", async (outcome, rule) => {
    const result = await auditDraftLinks(
      input("See [the lounge chair](https://www.mobelaris.com/products/lounge-chair)."),
      { verify: async () => outcome },
    );
    expect(result.findings).toContainEqual(expect.objectContaining({ rule_reference: rule }));
  });

  it("defaults honestly to unresolved without network and checks hierarchy metadata", async () => {
    const unresolved = await auditDraftLinks(
      input("See [the lounge chair](https://www.mobelaris.com/products/lounge-chair)."),
      new NoNetworkDraftLinkVerifier(),
    );
    expect(unresolved.findings[0]).toMatchObject({
      rule_reference: "link.target_unresolved",
      severity: "warning",
    });

    const mismatched = await auditDraftLinks(
      {
        ...input("See [the lounge chair](https://www.mobelaris.com/products/lounge-chair)."),
        shortlist: [{ ...shortlist[1]!, hierarchy: "collection", hierarchy_rank: 1 }],
      },
      {
        verify: async () => ({
          outcome: "direct_200",
          method: "head",
          verified_at: "2026-01-01T00:00:00.000Z",
          hierarchy: "product",
        }),
      },
    );
    expect(mismatched.findings[0]?.rule_reference).toBe("link.hierarchy_classification");
  });

  it("does not reject a contextually suitable lower-priority target solely by rank", async () => {
    const result = await auditDraftLinks(
      input(
        "For dimensions, see [the lounge chair](https://www.mobelaris.com/products/lounge-chair).",
      ),
      {
        verify: async () => ({
          outcome: "direct_200",
          method: "head",
          verified_at: "2026-01-01T00:00:00.000Z",
          hierarchy: "product",
        }),
      },
    );
    expect(result.findings.map((item) => item.rule_reference)).not.toContain(
      "link.hierarchy_priority",
    );
  });
});

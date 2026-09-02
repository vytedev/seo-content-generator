import { describe, expect, it } from "vitest";
import { applyRevisionEnvelope } from "../src/shared/revision-application.js";
import type { RevisionFinding } from "../src/shared/milestone-four.js";

const current = {
  title: "Walnut table guide",
  slug: "walnut-table-guide",
  meta_description: "Guide to walnut tables.",
  og_title: "Walnut tables",
  og_description: "Guide to walnut tables.",
  images: [{ alt: "Walnut table", filename: "walnut.jpg", placement: { marker: "walnut-table" } }],
  faqs: [{ question: "Why walnut?", answer: "It has a warm appearance." }],
  markdown:
    "# Walnut table guide\n\nIntro unchanged.\n\n## Care\n\nOld care copy.\n\n## End\n\nEnd unchanged.",
  claims: [
    { text: "Walnut is hardwood", type: "material" as const, status: "unverified" as const },
  ],
};
const finding = (id: string, field: string, section?: string): RevisionFinding => ({
  id,
  stable_key: id,
  category: "style",
  rule_reference: "style.test",
  severity: "warning",
  location: { field, ...(section ? { section } : {}) },
  issue: "Revise.",
  suggested_fix: "Revise safely.",
  disposition: "accepted",
  origin_document_version_id: "version-1",
});

describe("controlled revision application", () => {
  it("applies exact nested and uniquely headed Markdown locations while preserving claims and unrelated bytes", () => {
    const proposed = {
      ...structuredClone(current),
      images: [{ ...current.images[0]!, alt: "Round walnut table" }],
      markdown: current.markdown.replace("Old care copy.", "New care copy."),
    };
    const findings = [
      finding("image", "on_page.images.0.alt"),
      {
        ...finding("care", "body_markdown"),
        location: { field: "body_markdown", line_start: 7, line_end: 7, section: "Care" },
      },
    ];
    const result = applyRevisionEnvelope({
      current,
      proposed,
      findings,
      results: findings.map((f) => ({
        finding_id: f.id,
        status: "applied" as const,
        reason: "Applied.",
      })),
    });
    expect(result.document.images[0]?.alt).toBe("Round walnut table");
    expect(result.document.markdown).toContain("New care copy.");
    expect(result.document.markdown).toContain("Intro unchanged.");
    expect(result.document.claims).toEqual(current.claims);
    expect(result.audits.every((audit) => audit.changed)).toBe(true);
  });

  it("authorises only exact paragraph blocks and cannot rewrite a sibling or whole section", () => {
    const source = { ...current, markdown: "# Guide\n\n## Care\n\nFirst tip.\n\nSecond tip." };
    const proposed = {
      ...source,
      markdown: "# Guide\n\n## Care\n\nBetter first tip.\n\nRewritten sibling tip.",
    };
    const firstOnly = {
      ...finding("first", "body_markdown"),
      location: { field: "body_markdown", line_start: 5, line_end: 5, section: "Care" },
    };
    const result = applyRevisionEnvelope({
      current: source,
      proposed,
      findings: [firstOnly],
      results: [{ finding_id: firstOnly.id, status: "applied", reason: "Applied." }],
    });
    expect(result.document.markdown).toContain("Better first tip.");
    expect(result.document.markdown).toContain("Second tip.");
    expect(result.document.markdown).not.toContain("Rewritten sibling tip.");
    expect(result.audits[0]?.hunks).toHaveLength(1);
  });

  it("fails closed when line 5 is moved after line 7 and never audits an incomplete move as applied", () => {
    const source = {
      ...current,
      markdown: "# Guide\n\n## Care\n\nMove this line.\n\nKeep this line.",
    };
    const proposed = {
      ...source,
      markdown: "# Guide\n\n## Care\n\nKeep this line.\n\nMove this line.",
    };
    const deletionOnly = {
      ...finding("move-source", "body_markdown"),
      location: { field: "body_markdown", line_start: 5 },
    };
    const incomplete = applyRevisionEnvelope({
      current: source,
      proposed,
      findings: [deletionOnly],
      results: [{ finding_id: deletionOnly.id, status: "applied", reason: "Applied." }],
    });
    expect(incomplete.document.markdown).toBe(source.markdown);
    expect(incomplete.audits[0]).toMatchObject({ status: "unable", changed: false, hunks: [] });

    const insertion = {
      ...finding("move-destination", "body_markdown"),
      location: { field: "body_markdown", line_start: 7 },
    };
    const bothEndpoints = applyRevisionEnvelope({
      current: source,
      proposed,
      findings: [deletionOnly, insertion],
      results: [deletionOnly, insertion].map((item) => ({
        finding_id: item.id,
        status: "applied" as const,
        reason: "Applied.",
      })),
    });
    expect(bothEndpoints.document.markdown).toBe(source.markdown);
    expect(bothEndpoints.audits).toEqual([
      expect.objectContaining({ status: "unable", changed: false, hunks: [] }),
      expect.objectContaining({ status: "unable", changed: false, hunks: [] }),
    ]);
  });

  it("rejects a hunk overlapping a frozen rejected location", () => {
    const accepted = {
      ...finding("accepted", "body_markdown"),
      location: { field: "body_markdown", line_start: 7 },
    };
    const result = applyRevisionEnvelope({
      current,
      proposed: {
        ...current,
        markdown: current.markdown.replace("Old care copy.", "New care copy."),
      },
      findings: [accepted],
      results: [{ finding_id: accepted.id, status: "applied", reason: "Applied." }],
      rejected_locations: [{ field: "body_markdown", line_start: 7 }],
    });
    expect(result.document.markdown).toBe(current.markdown);
    expect(result.audits[0]?.status).toBe("unable");
  });

  it("handles inserted link/table/callout blocks with source-coordinate reverse application", () => {
    const source = { ...current, markdown: "# Guide\n\n## Details\n\nPlain paragraph.\n\nEnd." };
    const proposed = {
      ...source,
      markdown:
        "# Guide\n\n## Details\n\n[Useful link](https://example.com).\n\n> Callout.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nEnd.",
    };
    const exact = {
      ...finding("blocks", "body_markdown"),
      location: { field: "body_markdown", line_start: 5, line_end: 7 },
    };
    const result = applyRevisionEnvelope({
      current: source,
      proposed,
      findings: [exact],
      results: [{ finding_id: exact.id, status: "applied", reason: "Applied." }],
    });
    expect(result.document.markdown).toContain("[Useful link]");
    expect(result.document.markdown).toContain("> Callout.");
    expect(result.document.markdown).toContain("| A | B |");
    expect(result.audits[0]?.hunks[0]).toMatchObject({
      source_start: expect.any(Number),
      before_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("fails closed when multiple accepted findings claim the same structured field", () => {
    const first = finding("title-one", "on_page.meta_title");
    const second = finding("title-two", "meta_title");
    const result = applyRevisionEnvelope({
      current,
      proposed: { ...current, meta_title: "Improved walnut table guide" },
      findings: [first, second],
      results: [first, second].map((item) => ({
        finding_id: item.id,
        status: "applied" as const,
        reason: "Applied.",
      })),
    });
    expect(result.document.title).toBe(current.title);
    expect(result.audits).toEqual([
      expect.objectContaining({ status: "unable", changed: false }),
      expect.objectContaining({ status: "unable", changed: false }),
    ]);
  });

  it("fails closed for a broad Markdown location and rejects result order drift", () => {
    const broad = finding("broad", "body_markdown");
    const result = applyRevisionEnvelope({
      current,
      proposed: { ...current, markdown: "# Rewritten" },
      findings: [broad],
      results: [{ finding_id: "broad", status: "applied", reason: "Applied." }],
    });
    expect(result.document.markdown).toBe(current.markdown);
    expect(result.audits[0]).toMatchObject({ status: "unable", changed: false });
    expect(() =>
      applyRevisionEnvelope({
        current,
        proposed: current,
        findings: [broad],
        results: [{ finding_id: "other", status: "unable", reason: "No." }],
      }),
    ).toThrow(/exactly match/);
  });
});

describe("locationless findings bound to exact authority", () => {
  /**
   * Regression for the silent revert: the checker emits `keyword.primary.h2`
   * with a field and no line range, the planner produced a correct H2 edit,
   * and the envelope then discarded it because no accepted location could own
   * the resulting hunk. The shared binding supplies that exact authority, so
   * the edit must now survive.
   */
  it("keeps a bound keyword.primary.h2 edit instead of silently discarding it", () => {
    const bound: RevisionFinding = {
      ...finding("h2", "body_markdown"),
      rule_reference: "keyword.primary.h2",
      severity: "blocker",
      location: { field: "body_markdown", line_start: 5, line_end: 5 },
    };
    const proposed = {
      ...structuredClone(current),
      markdown: current.markdown.replace("## Care", "## Care: walnut table guide"),
    };
    const result = applyRevisionEnvelope({
      current,
      proposed,
      findings: [bound],
      results: [{ finding_id: "h2", status: "applied", reason: "Applied frozen policy." }],
    });
    expect(result.audits[0]).toMatchObject({ status: "applied", changed: true });
    expect(result.audits[0]!.hunks).toHaveLength(1);
    expect(result.document.markdown).toContain("## Care: walnut table guide");
  });

  it("still refuses the same edit while the finding carries no exact authority", () => {
    const unbound: RevisionFinding = {
      ...finding("h2", "body_markdown"),
      rule_reference: "keyword.primary.h2",
      severity: "blocker",
    };
    const proposed = {
      ...structuredClone(current),
      markdown: current.markdown.replace("## Care", "## Care: walnut table guide"),
    };
    const result = applyRevisionEnvelope({
      current,
      proposed,
      findings: [unbound],
      results: [{ finding_id: "h2", status: "applied", reason: "Applied frozen policy." }],
    });
    expect(result.audits[0]).toMatchObject({ status: "unable", changed: false });
    expect(result.document.markdown).toBe(current.markdown);
  });
});

describe("bounded multi-block authority", () => {
  const multi = {
    ...current,
    markdown: [
      "# Walnut table guide", // 1
      "", // 2
      "Direct answer prose.", // 3
      "", // 4
      "## Care", // 5
      "", // 6
      "First hard paragraph.", // 7
      "", // 8
      "Untouched middle paragraph.", // 9
      "", // 10
      "Second hard paragraph.", // 11
    ].join("\n"),
  };
  const readability: RevisionFinding = {
    ...finding("readability", "body_markdown"),
    rule_reference: "style.readability_grade_8",
    severity: "blocker",
    location: { field: "body_markdown", line_start: 7, line_end: 7 },
  };
  const authority = {
    readability: [
      [7, 7],
      [11, 11],
    ] as ReadonlyArray<readonly [number, number]>,
  };

  it("owns several non-contiguous hunks under one audit", () => {
    const result = applyRevisionEnvelope({
      current: multi,
      proposed: {
        ...multi,
        markdown: multi.markdown
          .replace("First hard paragraph.", "Short one.")
          .replace("Second hard paragraph.", "Short two."),
      },
      findings: [readability],
      results: [{ finding_id: "readability", status: "applied", reason: "Simplified." }],
      additional_authority: authority,
    });
    expect(result.audits[0]).toMatchObject({ status: "applied", changed: true });
    expect(result.audits[0]!.hunks).toHaveLength(2);
    expect(result.document.markdown).toContain("Short one.");
    expect(result.document.markdown).toContain("Short two.");
    expect(result.document.markdown).toContain("Untouched middle paragraph.");
  });

  it("discards a change outside every authorised block", () => {
    const result = applyRevisionEnvelope({
      current: multi,
      proposed: {
        ...multi,
        markdown: multi.markdown
          .replace("First hard paragraph.", "Short one.")
          .replace("Untouched middle paragraph.", "Smuggled rewrite."),
      },
      findings: [readability],
      results: [{ finding_id: "readability", status: "applied", reason: "Simplified." }],
      additional_authority: authority,
    });
    // The authorised block lands; the unauthorised one never does.
    expect(result.document.markdown).toContain("Short one.");
    expect(result.document.markdown).toContain("Untouched middle paragraph.");
    expect(result.document.markdown).not.toContain("Smuggled rewrite.");
    expect(result.audits[0]!.hunks).toHaveLength(1);
  });

  it("grants no authority at all without an exact primary location", () => {
    const unbound: RevisionFinding = {
      ...readability,
      location: { field: "body_markdown" },
    };
    const result = applyRevisionEnvelope({
      current: multi,
      proposed: { ...multi, markdown: multi.markdown.replace("First hard paragraph.", "Short.") },
      findings: [unbound],
      results: [{ finding_id: "readability", status: "applied", reason: "Simplified." }],
      additional_authority: authority,
    });
    expect(result.audits[0]).toMatchObject({ status: "unable", changed: false });
    expect(result.document.markdown).toBe(multi.markdown);
  });
});

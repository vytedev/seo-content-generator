import { describe, expect, it } from "vitest";
import { applyRevisionEnvelope } from "../src/shared/revision-application.js";
import type { RevisionRequest } from "../src/shared/milestone-four.js";
import { bindExceptionalBlockers } from "../src/shared/exceptional-recovery.js";
import type {
  AuthorisedReadabilityAuthority as AuthorisedReadabilityAuthorityInput,
  RevisionBindingExclusions,
} from "../src/shared/revision-planning.js";
import type { FindingLocation as FindingLocationInput } from "../src/shared/revision-application.js";
import {
  BINDABLE_LOCATIONLESS_RULES,
  DETERMINISTIC_REVISION_ALLOWLIST,
  REVISION_BINDING_VERSION,
  REVISION_PLANNING_VERSION,
  bindPrimaryKeywordH2,
  bindReadabilityParagraph,
  bindRevisionFindings,
  mergeRevisionPlan,
  planRevisionRequest,
  READABILITY_MAX_BLOCKS,
  READABILITY_SELECTOR_VERSION,
  readabilityTargetSetIdentity,
  revisionBindingExclusions,
  selectReadabilityBlocks,
} from "../src/shared/revision-planning.js";

function request(markdown = "# Chair guide\n\nA Favorite color for the chair."): RevisionRequest {
  return {
    operation_id: "op",
    run_id: "run",
    document_version_id: "doc",
    revision: 1,
    handoff: {
      plane_ticket: "MOB-1",
      primary_keyword: "chair guide",
      related_keywords: [],
      page_type: "blog",
      word_count_target: 1000,
      locales_for_translation: [],
    },
    current_document: {
      title: "Chair guide",
      slug: "chair-guide",
      meta_description: "Chair guide.",
      og_title: "Chair guide",
      og_description: "Chair guide.",
      images: [],
      faqs: [],
      markdown,
      claims: [],
    },
    accepted_findings: [
      {
        id: "british",
        stable_key: "british",
        category: "deterministic",
        rule_reference: "style.british_english_provisional",
        severity: "warning",
        location: { field: "body_markdown", line_start: 3, line_end: 3 },
        issue: "US spelling.",
        suggested_fix: "Use British spelling.",
        disposition: "accepted",
        origin_document_version_id: "doc",
      },
      {
        id: "title",
        stable_key: "title",
        category: "style",
        rule_reference: "style.clarity",
        severity: "warning",
        location: { field: "on_page.meta_title" },
        issue: "Clarify it.",
        suggested_fix: "Use a clearer title.",
        disposition: "accepted",
        origin_document_version_id: "doc",
      },
      {
        id: "unsafe",
        stable_key: "unsafe",
        category: "style",
        rule_reference: "style.subjective",
        severity: "warning",
        location: { field: "claims" },
        issue: "Rewrite claims.",
        suggested_fix: "Rewrite.",
        disposition: "accepted",
        origin_document_version_id: "doc",
      },
    ],
    revision_source: "operator_findings",
    reference_snapshots: [],
    prompt: { template_id: "mobelaris.revision_pass", template_version: "2.0.0" },
    model: "model",
    temperature: 0,
  };
}

describe("revision request reduction", () => {
  it("has an explicit versioned deterministic allowlist", () => {
    expect(REVISION_PLANNING_VERSION).toBe("1.5.0");
    expect(DETERMINISTIC_REVISION_ALLOWLIST).toEqual([
      "style.british_english_provisional",
      "on_page.meta_title.length",
      "on_page.meta_description.length",
      "keyword.primary.h2",
      "keyword.related.meaningful_section",
      "links.verified_internal_presence",
    ]);
  });

  it("routes exact targets and merges them in original order while preserving casing", () => {
    const input = request();
    const plan = planRevisionRequest(input);
    expect(plan.map((row) => row.route)).toEqual(["unable", "model", "unable"]);

    const single = request("# Chair guide\n\nA Favorite finish for the chair.");
    const singlePlan = planRevisionRequest(single);
    expect(singlePlan[0]?.route).toBe("deterministic");
    const proposed = structuredClone(single.current_document);
    proposed.title = "A clearer chair guide";
    const merged = mergeRevisionPlan({
      request: single,
      plan: singlePlan,
      modelDocument: proposed,
      modelResults: [{ finding_id: "title", status: "applied", reason: "Applied." }],
    });
    expect(merged.document.markdown).toContain("Favourite");
    expect(merged.results.map((row) => row.finding_id)).toEqual(["british", "title", "unsafe"]);
    expect(merged.results.map((row) => row.status)).toEqual(["applied", "applied", "unable"]);
  });

  it("never invents keyword prose and sends the bounded correction to the model", () => {
    const input = request("# Chair guide\n\nExisting prose only.");
    input.handoff.related_keywords = ["designer armchair"];
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "keyword",
        rule_reference: "keyword.related.meaningful_section",
        issue: "The related keyword “designer armchair” is missing.",
        location: { field: "body_markdown", line_start: 3, line_end: 3, section: "Chair guide" },
      },
    ];
    expect(planRevisionRequest(input).map((row) => row.route)).toEqual(["model"]);
    expect(input.current_document.markdown).toBe("# Chair guide\n\nExisting prose only.");
  });

  it("deterministically repairs a near-range meta description and one existing H2", () => {
    const input = request("# Chair guide\n\n## Choosing the right shape\n\nExisting prose only.");
    input.current_document.meta_description = "A".repeat(148);
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "description",
        rule_reference: "on_page.meta_description.length",
        location: { field: "on_page.meta_description" },
      },
      {
        ...input.accepted_findings[0]!,
        id: "primary-h2",
        rule_reference: "keyword.primary.h2",
        location: { field: "body_markdown", line_start: 3, line_end: 3 },
      },
    ];
    const plan = planRevisionRequest(input);
    expect(plan.map((row) => row.route)).toEqual(["deterministic", "deterministic"]);
    const merged = mergeRevisionPlan({ request: input, plan });
    expect(merged.document.meta_description.length).toBeGreaterThanOrEqual(150);
    expect(merged.document.meta_description.length).toBeLessThanOrEqual(155);
    expect(merged.document.markdown).toContain("## Choosing the right shape: chair guide");
    expect(merged.results.map((row) => row.status)).toEqual(["applied", "applied"]);
  });

  it("replaces only an existing link URL and preserves its anchor prose", () => {
    const input = request(
      "# Chair guide\n\nRead our [hand-finished seating](https://old.example/chair).",
    );
    input.internal_links = [
      { title: "Different title", url: "https://mobelaris.example/chairs", relevance: 1 },
    ];
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "link",
        rule_reference: "links.verified_internal_presence",
        location: { field: "body_markdown", line_start: 3, line_end: 3 },
      },
    ];
    const plan = planRevisionRequest(input);
    expect(plan[0]?.route).toBe("deterministic");
    const merged = mergeRevisionPlan({ request: input, plan });
    expect(merged.document.markdown).toContain(
      "[hand-finished seating](https://mobelaris.example/chairs)",
    );
    expect(merged.document.markdown).not.toContain("Different title");
  });

  it("uses a scoped model correction for an initial operator link finding with no URL target", () => {
    const input = request("# Chair guide\n\nRead our hand-finished seating.");
    input.internal_links = [
      { title: "hand-finished seating", url: "https://mobelaris.example/chairs", relevance: 1 },
    ];
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "link",
        rule_reference: "links.verified_internal_presence",
        location: { field: "body_markdown", line_start: 3, line_end: 3 },
      },
    ];
    expect(planRevisionRequest(input).map((row) => row.route)).toEqual(["model"]);
  });

  it("marks an exceptional missing-link repair unable without changing prose", () => {
    const input = request("# Chair guide\n\nRead our hand-finished seating.");
    input.revision_source = "operator_authorised_repair";
    input.internal_links = [
      { title: "hand-finished seating", url: "https://mobelaris.example/chairs", relevance: 1 },
    ];
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "link",
        rule_reference: "links.verified_internal_presence",
        location: { field: "body_markdown", line_start: 3, line_end: 3 },
      },
    ];
    const plan = planRevisionRequest(input);
    expect(plan).toMatchObject([
      {
        route: "unable",
        reason: expect.stringContaining("without changing anchor or surrounding prose"),
      },
    ]);
    expect(mergeRevisionPlan({ request: input, plan }).document.markdown).toBe(
      "# Chair guide\n\nRead our hand-finished seating.",
    );
  });
});

describe("legacy meta_title length repair", () => {
  /** A draft predating the distinct meta_title field, with an over-long title. */
  function legacyTitleRequest(): RevisionRequest {
    const base = request();
    const title = "The complete wishbone chair buying guide".padEnd(55, "x") + " and more words";
    return {
      ...base,
      handoff: { ...base.handoff, primary_keyword: "wishbone chair" },
      current_document: { ...base.current_document, title },
      accepted_findings: [
        {
          id: "meta-title-length",
          stable_key: "meta-title-length",
          category: "deterministic",
          rule_reference: "on_page.meta_title.length",
          severity: "blocker",
          location: { field: "on_page.meta_title" },
          issue: "meta title is too long.",
          suggested_fix: "Shorten it.",
          disposition: "accepted",
          origin_document_version_id: "doc",
        },
      ],
    };
  }

  it("applies the authorised shortening when meta_title is absent, resolving it from the title", () => {
    // Regression: the planner authorises the repair using meta_title ?? title,
    // so the application must resolve the source the same way. Comparing the
    // bare absent leaf made every such repair permanently "unable", which
    // deadlocked a run on a blocker it was allowed to fix.
    const value = legacyTitleRequest();
    const plan = planRevisionRequest(value);
    const item = plan.find((entry) => entry.finding.id === "meta-title-length");
    expect(item?.route).toBe("deterministic");

    const { document, results } = mergeRevisionPlan({ request: value, plan });
    const result = results.find((entry) => entry.finding_id === "meta-title-length");
    expect(result?.status).toBe("applied");
    expect(document.meta_title).toBeDefined();
    expect(document.meta_title!.length).toBeLessThanOrEqual(60);
    expect(document.meta_title!.length).toBeGreaterThanOrEqual(55);
    // The distinct title leaf is untouched by a meta_title correction.
    expect(document.title).toBe(value.current_document.title);
  });

  it("still refuses when the authorised source no longer matches", () => {
    const value = legacyTitleRequest();
    const plan = planRevisionRequest(value);
    const drifted = {
      ...value,
      current_document: { ...value.current_document, title: "Something else entirely" },
    };
    const { results } = mergeRevisionPlan({ request: drifted, plan });
    expect(results.find((entry) => entry.finding_id === "meta-title-length")?.status).toBe(
      "unable",
    );
  });
});

/**
 * The checker emits these rules with a field and no line range, so every test
 * below uses that exact shape. Injecting an artificial `line_start` would test
 * a finding production can never produce.
 */
function locationless(rule: string, severity: "blocker" | "warning" = "blocker") {
  return {
    id: rule,
    stable_key: rule,
    category: "deterministic" as const,
    rule_reference: rule,
    severity,
    location: { field: "body_markdown" },
    issue: "Issue.",
    suggested_fix: "Fix it.",
    disposition: "accepted" as const,
    origin_document_version_id: "doc",
  };
}

/** Deliberately high Flesch-Kincaid prose, so the frozen readability rule blocks. */
const HARD_PROSE =
  "Consequently the extraordinarily sophisticated manufacturing methodology demonstrates considerable environmental responsibility whenever comparatively substantial quantities of internationally certified hardwood materials are systematically incorporated throughout the entire production infrastructure.";

const HARD_PROSE_B =
  "Furthermore the interdisciplinary collaboration between contemporary furniture designers and experienced upholstery specialists consistently generates remarkably distinctive configurations which accommodate increasingly unpredictable residential requirements without compromising fundamental ergonomic considerations.";

const BOUND_DOC = [
  "# Chair guide",
  "",
  "The direct answer paragraph that opens the article and explains the topic plainly.",
  "",
  "## Choosing the right shape",
  "",
  HARD_PROSE,
  "",
  "## Key Takeaways",
  "",
  "Takeaway prose.",
  "",
  "## Conclusion",
  "",
  "Closing prose.",
].join("\n");

describe("application-owned binding for locationless rules", () => {
  it("is versioned and deliberately limited to rules with exact edit authority", () => {
    expect(REVISION_BINDING_VERSION).toBe("2.0.0");
    expect(BINDABLE_LOCATIONLESS_RULES).toEqual([
      "keyword.primary.h2",
      "style.readability_grade_8",
    ]);
  });

  it("binds keyword.primary.h2 to an eligible H2 and skips protected headings", () => {
    expect(bindPrimaryKeywordH2({ markdown: BOUND_DOC, primaryKeyword: "chair guide" })).toEqual({
      field: "body_markdown",
      line_start: 5,
      line_end: 5,
    });
  });

  it("returns unable when the only H2s are protected or already carry the keyword", () => {
    const protectedOnly = "# Guide\n\nProse.\n\n## Conclusion\n\nEnd.\n\n## FAQs\n\nMore.";
    expect(bindPrimaryKeywordH2({ markdown: protectedOnly, primaryKeyword: "chair guide" })).toBe(
      null,
    );
    const satisfied = "# Guide\n\nProse.\n\n## A chair guide section\n\nEnd.";
    expect(bindPrimaryKeywordH2({ markdown: satisfied, primaryKeyword: "chair guide" })).toBe(null);
  });

  it("never rewrites an H1 or corrupts heading hierarchy", () => {
    const h1Only = "# Chair guide overview\n\nProse only, no H2 anywhere.";
    expect(bindPrimaryKeywordH2({ markdown: h1Only, primaryKeyword: "chair guide" })).toBe(null);
  });

  it("refuses an H2 whose corrected form would duplicate an existing heading", () => {
    const duplicate = [
      "# Guide",
      "",
      "Prose.",
      "",
      "## Shapes",
      "",
      "More prose.",
      "",
      "## Shapes: chair guide",
      "",
      "Even more prose.",
    ].join("\n");
    expect(bindPrimaryKeywordH2({ markdown: duplicate, primaryKeyword: "chair guide" })).toBe(null);
  });

  it("never binds readability to the direct answer or protected sections", () => {
    const bound = bindReadabilityParagraph({ markdown: BOUND_DOC });
    // Line 7 is the longest eligible body paragraph; line 3 is the direct answer.
    expect(bound).toEqual({
      field: "body_markdown",
      line_start: 7,
      line_end: 7,
      section: "Choosing the right shape",
    });
  });

  it("never binds readability to link-owned, image-marker or excluded prose", () => {
    const linked = [
      "# Guide",
      "",
      "Direct answer.",
      "",
      "## Section",
      "",
      `Prose with a [verified link](https://example.com/a) inside it. ${HARD_PROSE}`,
    ].join("\n");
    expect(bindReadabilityParagraph({ markdown: linked })).toBe(null);
    const marker = "# Guide\n\nDirect answer.\n\n## Section\n\n<!-- MOBELARIS_IMAGE:chair -->";
    expect(bindReadabilityParagraph({ markdown: marker })).toBe(null);
    expect(bindReadabilityParagraph({ markdown: BOUND_DOC, exclusions: { lines: [[7, 7]] } })).toBe(
      null,
    );
  });

  it("binds only supported rules and leaves other locationless rules untouched", () => {
    const document = { ...request().current_document, markdown: BOUND_DOC };
    const findings = [
      locationless("keyword.primary.h2"),
      locationless("style.readability_grade_8"),
      locationless("structure.key_takeaways"),
    ];
    const bound = bindRevisionFindings({
      document,
      primaryKeyword: "chair guide",
      findings,
      rejectedLocations: [],
    });
    expect(bound[0]?.location).toMatchObject({ line_start: 5, line_end: 5 });
    expect(bound[1]?.location).toMatchObject({ line_start: 7, line_end: 7 });
    // Binding arbitrary prose to a structural rule is forbidden, so this one
    // keeps its locationless shape and stays honestly unable.
    expect(bound[2]?.location).toEqual({ field: "body_markdown" });
  });

  it("routes a bound locationless keyword.primary.h2 through the deterministic planner", () => {
    const input = request(BOUND_DOC);
    input.accepted_findings = bindRevisionFindings({
      document: { ...input.current_document, markdown: BOUND_DOC },
      primaryKeyword: "chair guide",
      findings: [locationless("keyword.primary.h2")],
      rejectedLocations: [],
    });
    const plan = planRevisionRequest(input);
    expect(plan[0]?.route).toBe("deterministic");
    const merged = mergeRevisionPlan({ request: input, plan });
    expect(merged.document.markdown).toContain("## Choosing the right shape: chair guide");
  });
});

describe("over-length meta description shortening", () => {
  function metaRequest(description: string): RevisionRequest {
    const input = request();
    input.current_document.meta_description = description;
    input.accepted_findings = [
      {
        ...input.accepted_findings[0]!,
        id: "description",
        rule_reference: "on_page.meta_description.length",
        severity: "blocker",
        location: { field: "on_page.meta_description" },
      },
    ];
    return input;
  }

  it("shortens a 160-character description into range at a word boundary", () => {
    const source = `A chair guide ${"word ".repeat(40)}`.slice(0, 160);
    expect(source.length).toBe(160);
    const input = metaRequest(source);
    expect(planRevisionRequest(input)[0]?.route).toBe("deterministic");
    const merged = mergeRevisionPlan({ request: input, plan: planRevisionRequest(input) });
    const target = merged.document.meta_description;
    // The frozen checker measures UTF-16 code units, so this must too.
    expect(target.length).toBeGreaterThanOrEqual(150);
    expect(target.length).toBeLessThanOrEqual(155);
    expect(target.toLowerCase()).toContain("chair guide");
    expect(target).not.toMatch(/\s$/);
    expect(source.startsWith(target)).toBe(true);
  });

  it("never splits a surrogate pair when shortening", () => {
    // Each emoji is one code point but two UTF-16 code units.
    const source = `A chair guide ${"ab😀".repeat(60)}`;
    expect(source.length).toBeGreaterThan(155);
    const input = metaRequest(source);
    const plan = planRevisionRequest(input);
    if (plan[0]?.route === "deterministic") {
      const target = mergeRevisionPlan({ request: input, plan }).document.meta_description;
      expect(target.length).toBeGreaterThanOrEqual(150);
      expect(target.length).toBeLessThanOrEqual(155);
      // A well-formed emoji legitimately contains a surrogate pair; only a
      // LONE high or low surrogate proves the cut split one.
      expect(target).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    } else {
      expect(plan[0]?.route).toBe("unable");
    }
  });

  it("returns unable when shortening cannot preserve the exact primary keyword", () => {
    const source = `${"z".repeat(200)} chair guide`;
    const input = metaRequest(source);
    expect(planRevisionRequest(input)[0]?.route).toBe("unable");
  });
});

describe("readability binding excludes non-prose blocks", () => {
  /**
   * Regression: the image placement marker is an HTML comment on its own line.
   * Counting it as the first block made the direct-answer paragraph look like
   * ordinary body prose, so readability could select and rewrite the very
   * paragraph `structure.direct_answer` constrains.
   */
  it("never treats an image marker as the first paragraph", () => {
    const markdown = [
      "# Designer chair guide",
      "",
      "<!-- MOBELARIS_IMAGE:designer-chair -->",
      "",
      "The direct answer paragraph, which must never be selected for readability rewriting.",
      "",
      "## How it fits",
      "",
      HARD_PROSE,
    ].join("\n");
    const bound = bindReadabilityParagraph({ markdown });
    expect(bound).toEqual({
      field: "body_markdown",
      line_start: 9,
      line_end: 9,
      section: "How it fits",
    });
  });

  it("returns unable when the only prose is the direct answer", () => {
    const markdown = "# Guide\n\n<!-- MOBELARIS_IMAGE:x -->\n\nOnly the direct answer exists here.";
    expect(bindReadabilityParagraph({ markdown })).toBe(null);
  });
});

/**
 * `keyword.primary.h2` end to end: bind, plan, merge, then apply the envelope.
 *
 * Regression for an unsafe fallback: the planner used to edit the first H2
 * whenever a finding had no `line_start`, which meant a heading the binder had
 * already refused as protected or duplicate-producing was corrected anyway.
 */
function h2EndToEnd(markdown: string, primaryKeyword = "chair guide") {
  const base = request(markdown);
  const document = { ...base.current_document, markdown };
  const findings = bindRevisionFindings({
    document,
    primaryKeyword,
    findings: [locationless("keyword.primary.h2")],
    rejectedLocations: [],
  });
  const input: RevisionRequest = {
    ...base,
    handoff: { ...base.handoff, primary_keyword: primaryKeyword },
    current_document: document,
    accepted_findings: findings,
  };
  const plan = planRevisionRequest(input);
  const merged = mergeRevisionPlan({ request: input, plan });
  const applied = applyRevisionEnvelope({
    current: document,
    proposed: merged.document,
    findings,
    results: merged.results,
  });
  return {
    boundLine: findings[0]!.location.line_start,
    route: plan[0]!.route,
    status: applied.audits[0]!.status,
    markdown: applied.document.markdown,
    unchanged: applied.document.markdown === markdown,
  };
}

describe("keyword.primary.h2 binder → planner → envelope", () => {
  it("corrects a safe eligible H2 and persists the change", () => {
    const result = h2EndToEnd(BOUND_DOC);
    expect(result.boundLine).toBe(5);
    expect(result.route).toBe("deterministic");
    expect(result.status).toBe("applied");
    expect(result.markdown).toContain("## Choosing the right shape: chair guide");
  });

  it("returns unable and changes nothing when every H2 is protected", () => {
    const protectedOnly = [
      "# Chair guide",
      "",
      "Direct answer prose.",
      "",
      "## Key Takeaways",
      "",
      "Takeaway prose.",
      "",
      "## Conclusion",
      "",
      "Closing prose.",
      "",
      "## FAQs",
      "",
      "Question prose.",
    ].join("\n");
    const result = h2EndToEnd(protectedOnly);
    expect(result.boundLine).toBeUndefined();
    expect(result.route).toBe("unable");
    expect(result.status).toBe("unable");
    expect(result.unchanged).toBe(true);
    expect(result.markdown).not.toContain("chair guide\n");
  });

  it("returns unable when the only correction would duplicate an existing heading", () => {
    const duplicate = [
      "# Guide",
      "",
      "Direct answer prose.",
      "",
      "## Shapes",
      "",
      "Body prose.",
      "",
      "## Shapes: chair guide",
      "",
      "More body prose.",
    ].join("\n");
    const result = h2EndToEnd(duplicate);
    expect(result.route).toBe("unable");
    expect(result.status).toBe("unable");
    expect(result.unchanged).toBe(true);
  });

  it("returns unable when the document has no H2 at all", () => {
    const result = h2EndToEnd("# Chair guide overview\n\nProse only, no H2 anywhere.");
    expect(result.boundLine).toBeUndefined();
    expect(result.route).toBe("unable");
    expect(result.status).toBe("unable");
    expect(result.unchanged).toBe(true);
  });

  it("refuses a stale authorised line that now points at a protected heading", () => {
    // An exceptional binding is persisted and replayed later, so the planner
    // must re-check the line rather than trust it.
    const markdown = "# Guide\n\nProse.\n\n## Conclusion\n\nClosing prose.";
    const base = request(markdown);
    const stale = {
      ...locationless("keyword.primary.h2"),
      location: { field: "body_markdown", line_start: 5, line_end: 5 },
    };
    const input: RevisionRequest = {
      ...base,
      current_document: { ...base.current_document, markdown },
      accepted_findings: [stale],
    };
    expect(planRevisionRequest(input)[0]?.route).toBe("unable");
  });
});

describe("keyword.primary.h2 requires binder-supplied authority", () => {
  /**
   * The binder may refuse a finding for a reason the planner cannot see (a
   * rejected location, for instance), leaving it locationless. With the old
   * first-H2 fallback the planner still claimed a `deterministic` route and
   * produced an edit at a line nothing had authorised — which the envelope then
   * discarded, reproducing the original silent-revert defect. Planning must now
   * refuse up front even though a perfectly safe H2 exists.
   */
  it("returns unable for a locationless finding even when a safe H2 exists", () => {
    const base = request(BOUND_DOC);
    const input: RevisionRequest = {
      ...base,
      current_document: { ...base.current_document, markdown: BOUND_DOC },
      accepted_findings: [locationless("keyword.primary.h2")],
    };
    // A safe H2 is available, so only the missing authority can cause this.
    expect(
      bindPrimaryKeywordH2({ markdown: BOUND_DOC, primaryKeyword: "chair guide" }),
    ).not.toBeNull();
    expect(planRevisionRequest(input)[0]?.route).toBe("unable");
  });
});

describe("bounded readability target selection", () => {
  const SELECTOR_DOC = [
    "# Designer chair guide", // 1
    "", // 2
    "<!-- MOBELARIS_IMAGE:chair -->", // 3
    "", // 4
    `Direct answer. ${HARD_PROSE}`, // 5  direct answer — never selectable
    "", // 6
    "## Key Takeaways", // 7
    "", // 8
    `- ${HARD_PROSE}`, // 9  list item
    "", // 10
    "## How it fits", // 11
    "", // 12
    HARD_PROSE, // 13 eligible
    "", // 14
    `Linked prose [chair](https://www.mobelaris.com/en/chair). ${HARD_PROSE}`, // 15 link-owned
    "", // 16
    `> ${HARD_PROSE}`, // 17 blockquote
    "", // 18
    HARD_PROSE_B, // 19 eligible
    "", // 20
    "## Conclusion", // 21
    "", // 22
    HARD_PROSE, // 23 protected section
  ].join("\n");

  it("selects several exact eligible blocks and excludes every protected shape", () => {
    const blocks = selectReadabilityBlocks({ findingId: "f1", markdown: SELECTOR_DOC });
    expect(blocks.map((block) => [block.line_start, block.line_end])).toEqual([
      [13, 13],
      [19, 19],
    ]);
    // Application-issued, ordered ids; never the model's own naming.
    expect(blocks.map((block) => block.id)).toEqual(["f1::rb1", "f1::rb2"]);
    // Each block is an exact single-block range, never one broad span covering
    // the unauthorised prose between them.
    for (const block of blocks) expect(block.line_end).toBe(block.line_start);
    // Direct answer (5), list (9), link-owned (15), blockquote (17),
    // Conclusion (23), headings and the image marker (3) are all absent.
    const selected = blocks.flatMap((block) => [block.line_start, block.line_end]);
    for (const excluded of [1, 3, 5, 7, 9, 11, 15, 17, 21, 23])
      expect(selected).not.toContain(excluded);
  });

  it("excludes factual, rejected and already-owned ranges", () => {
    expect(
      selectReadabilityBlocks({
        findingId: "f1",
        markdown: SELECTOR_DOC,
        exclusions: { lines: [[13, 13]] },
      }).map((block) => block.line_start),
    ).toEqual([19]);
    // Both eligible paragraphs live in "How it fits", so excluding that section
    // must remove both rather than leaving a partially protected selection.
    expect(
      selectReadabilityBlocks({
        findingId: "f1",
        markdown: SELECTOR_DOC,
        exclusions: { sections: new Set(["how it fits"]) },
      }),
    ).toEqual([]);
    // A paragraph another accepted finding already authorises is never offered,
    // because overlapping hunk ownership would fail closed anyway.
    expect(
      selectReadabilityBlocks({
        findingId: "f1",
        markdown: SELECTOR_DOC,
        reservedRanges: [[19, 19]],
      }).map((block) => block.line_start),
    ).toEqual([13]);
  });

  it("returns no target when nothing eligible is above the grade target", () => {
    const easy = [
      "# Guide",
      "",
      "The direct answer is short and plain.",
      "",
      "## Section",
      "",
      "A chair should fit your room. Pick a size that leaves space. Test the seat height.",
    ].join("\n");
    expect(selectReadabilityBlocks({ findingId: "f1", markdown: easy })).toEqual([]);
  });

  it("ranks the hardest prose first and honours the block cap", () => {
    const many = [
      "# Guide",
      "",
      "Direct answer.",
      "",
      "## Section",
      ...Array.from({ length: 10 }, () => ["", HARD_PROSE]).flat(),
    ].join("\n");
    const blocks = selectReadabilityBlocks({ findingId: "f1", markdown: many });
    expect(blocks.length).toBeLessThanOrEqual(READABILITY_MAX_BLOCKS);
    expect(blocks.length).toBeGreaterThan(1);
    // Issued in source order regardless of ranking, so downstream consumers see
    // one stable ordering.
    expect(blocks.map((block) => block.line_start)).toEqual(
      [...blocks.map((block) => block.line_start)].sort((a, b) => a - b),
    );
  });

  it("keeps the target set identity stable and sensitive to a changed selection", () => {
    const blocks = selectReadabilityBlocks({ findingId: "f1", markdown: SELECTOR_DOC });
    expect(readabilityTargetSetIdentity(blocks)).toBe("13-13,19-19");
    expect(
      readabilityTargetSetIdentity(
        selectReadabilityBlocks({
          findingId: "f1",
          markdown: SELECTOR_DOC,
          reservedRanges: [[19, 19]],
        }),
      ),
    ).toBe("13-13");
  });

  it("plans a bounded multi-block model route, or an honest unable", () => {
    const base = request(SELECTOR_DOC);
    const readability = {
      ...locationless("style.readability_grade_8"),
      location: { field: "body_markdown", line_start: 13, line_end: 13 },
    };
    const planned = planRevisionRequest({
      ...base,
      current_document: { ...base.current_document, markdown: SELECTOR_DOC },
      accepted_findings: [readability],
    });
    expect(planned[0]?.route).toBe("model");
    expect(planned[0]?.readability_blocks?.map((block) => block.line_start)).toEqual([13, 19]);

    // Nothing eligible above the target grade → unable, never a widened scope.
    const easy = "# Guide\n\nShort answer.\n\n## Section\n\nA chair fits a room. Keep it simple.";
    const easyPlan = planRevisionRequest({
      ...base,
      current_document: { ...base.current_document, markdown: easy },
      accepted_findings: [readability],
    });
    expect(easyPlan[0]?.route).toBe("unable");
    expect(easyPlan[0]?.readability_blocks).toBeUndefined();
  });
});

describe("rejected prose is frozen out before provider planning", () => {
  const REJECTED_DOC = [
    "# Chair guide", // 1
    "", // 2
    "Direct answer prose.", // 3
    "", // 4
    "## How it fits", // 5
    "", // 6
    HARD_PROSE, // 7  eligible
    "", // 8
    HARD_PROSE_B, // 9  eligible
    "", // 10
    "## Conclusion", // 11
    "", // 12
    "Closing prose.", // 13
  ].join("\n");

  function planWith(rejected: FindingLocationInput[]) {
    const base = request(REJECTED_DOC);
    const document = { ...base.current_document, markdown: REJECTED_DOC };
    const readability = locationless("style.readability_grade_8");
    const exclusions = revisionBindingExclusions({ document, rejectedLocations: rejected });
    const bound = bindRevisionFindings({
      document,
      primaryKeyword: "chair guide",
      findings: [readability],
      exclusions,
    });
    const plan = planRevisionRequest(
      { ...base, current_document: document, accepted_findings: bound },
      { exclusions },
    );
    return {
      blocks: plan[0]?.readability_blocks ?? [],
      route: plan[0]!.route,
      boundLine: bound[0]!.location.line_start,
    };
  }

  it("selects both eligible paragraphs when nothing is rejected", () => {
    const { blocks, route } = planWith([]);
    expect(route).toBe("model");
    expect(blocks.map((block) => block.line_start)).toEqual([7, 9]);
  });

  it("never offers a rejected secondary paragraph to the provider", () => {
    const { blocks, route, boundLine } = planWith([
      { field: "body_markdown", line_start: 9, line_end: 9 },
    ]);
    expect(route).toBe("model");
    // The rejected paragraph is absent from the provider-visible target set and
    // therefore from the target identity and the additional authority derived
    // from it.
    expect(blocks.map((block) => block.line_start)).toEqual([7]);
    expect(readabilityTargetSetIdentity(blocks)).toBe("7-7");
    expect(boundLine).toBe(7);
  });

  it("never offers a rejected primary candidate, keeping its eligible sibling", () => {
    const { blocks, route, boundLine } = planWith([
      { field: "body_markdown", line_start: 7, line_end: 7 },
    ]);
    expect(route).toBe("model");
    expect(blocks.map((block) => block.line_start)).toEqual([9]);
    expect(boundLine).toBe(9);
  });

  it("returns unable when every eligible paragraph is rejected", () => {
    const { blocks, route } = planWith([
      { field: "body_markdown", line_start: 7, line_end: 7 },
      { field: "body_markdown", line_start: 9, line_end: 9 },
    ]);
    expect(route).toBe("unable");
    expect(blocks).toEqual([]);
  });
});

describe("frozen exceptional readability authority", () => {
  const AUTH_DOC = [
    "# Chair guide",
    "",
    "Direct answer prose.",
    "",
    "## How it fits",
    "",
    HARD_PROSE,
    "",
    HARD_PROSE_B,
  ].join("\n");

  const readabilityBlocker = {
    id: "readability",
    rule_reference: "style.readability_grade_8",
    location: { field: "body_markdown" },
  };

  function planExceptional(
    authorised: Record<string, AuthorisedReadabilityAuthorityInput> | undefined,
  ) {
    const base = request(AUTH_DOC);
    const document = { ...base.current_document, markdown: AUTH_DOC };
    const finding = {
      ...locationless("style.readability_grade_8"),
      id: "readability",
      location: { field: "body_markdown", line_start: 7, line_end: 7 },
    };
    return planRevisionRequest(
      {
        ...base,
        current_document: document,
        accepted_findings: [finding],
        revision_source: "operator_authorised_repair",
      },
      authorised ? { authorisedReadability: authorised } : {},
    );
  }

  it("records every selected block in the authorisation, not just the first", () => {
    const draft = { ...request(AUTH_DOC).current_document, markdown: AUTH_DOC };
    const bindings = bindExceptionalBlockers(draft, "chair guide", [readabilityBlocker]);
    expect(bindings).not.toBeNull();
    expect(bindings![0]!.readability_blocks).toEqual([
      { line_start: 7, line_end: 7 },
      { line_start: 9, line_end: 9 },
    ]);
    expect(bindings![0]!.selector_version).toBe(READABILITY_SELECTOR_VERSION);
    expect(bindings![0]!.target_set_identity).toBe("7-7,9-9");
    // Normal and exceptional routes agree for the same document and exclusions.
    expect(
      readabilityTargetSetIdentity(
        selectReadabilityBlocks({ findingId: "readability", markdown: AUTH_DOC }),
      ),
    ).toBe(bindings![0]!.target_set_identity);
  });

  it("uses exactly the persisted blocks and no others", () => {
    const plan = planExceptional({
      readability: {
        blocks: [
          { line_start: 7, line_end: 7 },
          { line_start: 9, line_end: 9 },
        ],
        selector_version: READABILITY_SELECTOR_VERSION,
        target_set_identity: "7-7,9-9",
      },
    });
    expect(plan[0]?.route).toBe("model");
    expect(plan[0]?.readability_blocks?.map((block) => block.line_start)).toEqual([7, 9]);
  });

  it.each([
    ["a missing range", [{ line_start: 7, line_end: 7 }], READABILITY_SELECTOR_VERSION, undefined],
    [
      "an extra range",
      [
        { line_start: 7, line_end: 7 },
        { line_start: 9, line_end: 9 },
        { line_start: 3, line_end: 3 },
      ],
      READABILITY_SELECTOR_VERSION,
      undefined,
    ],
    [
      "a duplicate range",
      [
        { line_start: 7, line_end: 7 },
        { line_start: 7, line_end: 7 },
      ],
      READABILITY_SELECTOR_VERSION,
      undefined,
    ],
    [
      "a reordered range",
      [
        { line_start: 9, line_end: 9 },
        { line_start: 7, line_end: 7 },
      ],
      READABILITY_SELECTOR_VERSION,
      undefined,
    ],
    [
      "a stale selector version",
      [
        { line_start: 7, line_end: 7 },
        { line_start: 9, line_end: 9 },
      ],
      "0.0.1",
      undefined,
    ],
    [
      "an identity disagreeing with its own ranges",
      [
        { line_start: 7, line_end: 7 },
        { line_start: 9, line_end: 9 },
      ],
      READABILITY_SELECTOR_VERSION,
      "7-7",
    ],
  ])("fails closed on %s", (_label, blocks, selectorVersion, identity) => {
    const plan = planExceptional({
      readability: {
        blocks,
        selector_version: selectorVersion,
        ...(identity ? { target_set_identity: identity } : {}),
      },
    });
    expect(plan[0]?.route).toBe("unable");
    expect(plan[0]?.readability_blocks).toBeUndefined();
  });

  it("fails closed when the authority is absent for an authorised repair", () => {
    expect(planExceptional({ other: { blocks: [{ line_start: 7, line_end: 7 }] } })[0]?.route).toBe(
      "unable",
    );
  });
});

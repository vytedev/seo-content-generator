import { describe, expect, it } from "vitest";
import type { RevisionRequest } from "../src/shared/milestone-four.js";
import {
  DETERMINISTIC_REVISION_ALLOWLIST,
  REVISION_PLANNING_VERSION,
  mergeRevisionPlan,
  planRevisionRequest,
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
    expect(REVISION_PLANNING_VERSION).toBe("1.3.0");
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

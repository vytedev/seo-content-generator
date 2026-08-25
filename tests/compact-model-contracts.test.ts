import { describe, expect, it } from "vitest";
import type { CoherenceRequest, RevisionRequest } from "../src/shared/milestone-four.js";
import type { ReviewRequest } from "../src/shared/milestone-three.js";
import {
  applyCompactRevisionPlan,
  prepareCoherenceWindows,
  prepareReviewDocument,
  prepareRevisionTargets,
} from "../src/server/providers/compact-model-contracts.js";

const draft = {
  title: "Walnut table guide",
  slug: "walnut-table-guide",
  meta_description: "A walnut table guide.",
  og_title: "Walnut table guide",
  og_description: "A walnut table guide.",
  images: [],
  faqs: [],
  markdown:
    "# Walnut table guide\n\nOpening.\n\n## Care\n\nUse a dry cloth.\n\n## Sizing\n\nMeasure first.",
  claims: [],
};
const handoff = {
  plane_ticket: "MOB-1",
  primary_keyword: "walnut table",
  related_keywords: [],
  page_type: "blog" as const,
  word_count_target: 800,
  locales_for_translation: [],
};

it("prepares lossless deterministic review sections", () => {
  const prepared = prepareReviewDocument({ draft } as unknown as ReviewRequest);
  expect(prepared.sections.map((section) => section.t).join("\n")).toBe(draft.markdown);
  expect(prepared.sections).toMatchObject([
    { id: "loc-0001", h: "Walnut table guide", a: 1, b: 2 },
    { id: "loc-0002", h: "Walnut table guide", a: 3, b: 4 },
    { id: "loc-0003", h: "Care", a: 5, b: 6 },
    { id: "loc-0004", h: "Care", a: 7, b: 8 },
    { id: "loc-0005", h: "Sizing", a: 9, b: 10 },
    { id: "loc-0006", h: "Sizing", a: 11, b: 11 },
  ]);
});

it("keeps long review documents lossless with stable application-issued IDs", () => {
  const markdown = Array.from({ length: 300 }, (_, index) =>
    index % 10 === 0 ? `## Section ${index / 10}` : `Line ${index}`,
  ).join("\n");
  const prepared = prepareReviewDocument({
    draft: { ...draft, markdown },
  } as unknown as ReviewRequest);
  expect(prepared.sections.map((section) => section.t).join("\n")).toBe(markdown);
  expect(prepared.sections.at(-1)?.id).toBe("loc-0060");
});

it("preclassifies ambiguous and server-owned revision locations without exposing content", () => {
  const request = {
    ...({ current_document: draft } as unknown as RevisionRequest),
    accepted_findings: [
      {
        id: "f1",
        location: { field: "claims" },
        rule_reference: "fact.claim",
        issue: "Do not expose claims.",
        suggested_fix: "Change claims.",
      },
      {
        id: "f2",
        location: { field: "body_markdown", section: "Missing" },
        rule_reference: "style.clarity",
        issue: "Ambiguous.",
        suggested_fix: "Change text.",
      },
    ],
  } as RevisionRequest;
  expect(prepareRevisionTargets(request)).toEqual([
    {
      id: "f1",
      rule: "fact.claim",
      location: { field: "claims" },
      preclassified: "unable",
    },
    {
      id: "f2",
      rule: "style.clarity",
      location: { field: "body_markdown", section: "Missing" },
      preclassified: "unable",
    },
  ]);
});

it("expands a finding-scoped edit plan while preserving server-owned fields", () => {
  const request = {
    operation_id: "op",
    run_id: "run",
    document_version_id: "v1",
    revision: 1,
    handoff,
    current_document: draft,
    accepted_findings: [
      {
        id: "f1",
        stable_key: "care",
        category: "style",
        rule_reference: "style.clarity",
        severity: "warning",
        location: { field: "body_markdown", section: "Care" },
        issue: "Too vague.",
        suggested_fix: "Clarify care.",
        disposition: "accepted",
        origin_document_version_id: "v1",
      },
    ],
    reference_snapshots: [],
    prompt: { template_id: "mobelaris.revision_pass", template_version: "2.0.0" },
    model: "model",
    temperature: 0,
  } satisfies RevisionRequest;
  const result = applyCompactRevisionPlan(request, {
    edits: [
      {
        id: "f1",
        st: "applied",
        why: "Scoped edit.",
        replacement: "## Care\n\nWipe with a dry cloth.",
      },
    ],
  });
  expect(result.document.markdown).toContain("Wipe with a dry cloth.");
  expect(result.document.markdown).toContain("## Sizing\n\nMeasure first.");
  expect(result.document.claims).toEqual(draft.claims);
});

describe("coherence preparation", () => {
  it("sends changed sections with bounded neighbouring context, not full documents", () => {
    const current = {
      ...draft,
      markdown: draft.markdown.replace("Use a dry cloth.", "Wipe it dry."),
    };
    const prepared = prepareCoherenceWindows({
      parent_document: draft,
      current_document: current,
      revision_audits: [
        {
          finding_id: "f1",
          status: "applied",
          reason: "Applied.",
          location: { field: "body_markdown", section: "Care" },
          hunks: [{ source_start: 7, source_end: 7, proposed_start: 7, proposed_end: 7 }],
          changed: true,
          before_hash: "a".repeat(64),
          after_hash: "b".repeat(64),
        },
      ],
    } as unknown as CoherenceRequest);
    expect(prepared.neighbour_lines).toBe(6);
    expect(prepared.windows[0]?.proposed).toMatchObject({ a: 1, b: 11 });
    expect(prepared.windows[0]?.proposed.text).toContain("Wipe it dry.");
  });

  it("fails closed instead of omitting a changed hunk that exceeds the review budget", () => {
    const parent = {
      ...draft,
      markdown: Array.from({ length: 220 }, (_, index) => `Parent line ${index + 1}`).join("\n"),
    };
    const current = {
      ...draft,
      markdown: Array.from({ length: 220 }, (_, index) => `Current line ${index + 1}`).join("\n"),
    };
    expect(() =>
      prepareCoherenceWindows({
        parent_document: parent,
        current_document: current,
        revision_audits: [
          {
            finding_id: "large-change",
            status: "applied",
            reason: "Applied.",
            location: { field: "body_markdown", line_start: 1, line_end: 200 },
            hunks: [{ source_start: 1, source_end: 200, proposed_start: 1, proposed_end: 200 }],
            changed: true,
          },
        ],
      } as unknown as CoherenceRequest),
    ).toThrow("Final coherence context exceeds the safe review limit");
  });

  it("preserves complete paired coordinate windows for insertions and deletions", () => {
    const parent = { ...draft, markdown: "# Guide\n\nBefore\n\nAfter" };
    const current = { ...draft, markdown: "# Guide\n\nInserted\n\nAfter" };
    const prepared = prepareCoherenceWindows({
      parent_document: parent,
      current_document: current,
      revision_audits: [
        {
          finding_id: "f1",
          status: "applied",
          reason: "Applied.",
          location: { field: "body_markdown", line_start: 3 },
          hunks: [
            { source_start: 3, source_end: 3, proposed_start: 3, proposed_end: 2 },
            { source_start: 3, source_end: 2, proposed_start: 3, proposed_end: 3 },
          ],
          changed: true,
        },
      ],
    } as unknown as CoherenceRequest);
    expect(prepared.windows).toHaveLength(2);
    expect(prepared.windows[0]?.source.text).toContain("Before");
    expect(prepared.windows[1]?.proposed.text).toContain("Inserted");
    expect(prepared.windows.every((window) => window.source.a <= window.source.b)).toBe(true);
    expect(prepared.windows.every((window) => window.proposed.a <= window.proposed.b)).toBe(true);
  });
});

import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import { StructuredDraftSchema, type StructuredDraft } from "../../shared/milestone-two.js";
import {
  ReviewFindingSchema,
  type ReviewFinding,
  type ReviewRequest,
} from "../../shared/milestone-three.js";
import type { CoherenceRequest, RevisionRequest } from "../../shared/milestone-four.js";

const compactText = z.string().trim().min(1).max(2_000);
const locationId = z.string().regex(/^loc-[0-9]{4}$/);

export const CompactLocationSchema = z
  .object({
    id: locationId.nullable(),
    f: compactText.nullable(),
    a: z.number().int().positive().nullable(),
    b: z.number().int().positive().nullable(),
    s: compactText.nullable(),
  })
  .strict();

export const CompactReviewFindingSchema = z
  .object({
    k: compactText.regex(/^[a-z0-9][a-z0-9._:-]*$/),
    c: compactText,
    r: compactText,
    v: z.enum(["info", "warning", "blocker"]),
    l: CompactLocationSchema,
    i: compactText,
    e: compactText.nullable(),
    x: compactText,
  })
  .strict();

export const CompactReviewEnvelopeSchema = z
  .object({ f: z.array(CompactReviewFindingSchema).max(100) })
  .strict();

export function expandCompactReviewFinding(
  finding: z.infer<typeof CompactReviewFindingSchema>,
  resolvedLocation?: ReviewFinding["location"],
): ReviewFinding {
  return ReviewFindingSchema.parse({
    stable_key: finding.k,
    category: finding.c,
    rule_reference: finding.r,
    severity: finding.v,
    location:
      resolvedLocation ??
      ({
        field: finding.l.f,
        ...(finding.l.a == null ? {} : { line_start: finding.l.a }),
        ...(finding.l.b == null ? {} : { line_end: finding.l.b }),
        ...(finding.l.s == null ? {} : { section: finding.l.s }),
      } as ReviewFinding["location"]),
    issue: finding.i,
    ...(finding.e == null ? {} : { evidence: finding.e }),
    suggested_fix: finding.x,
  });
}

interface PreparedSection {
  readonly id: string;
  readonly h: string;
  readonly a: number;
  readonly b: number;
  readonly t: string;
}

/** Deterministically turns Markdown into stable paragraph/block locations, never whole sections. */
export function prepareReviewDocument(request: ReviewRequest): {
  title: string;
  sections: PreparedSection[];
} {
  const lines = request.draft.markdown.split("\n");
  const nodes = fromMarkdown(request.draft.markdown).children;
  let heading = "Document";
  const sections = nodes.map((node, index) => {
    const start = node.position?.start.line;
    const nextStart = nodes[index + 1]?.position?.start.line;
    if (start === undefined) throw new Error("Compact review block has no source position");
    // Assign inter-block blank lines to the preceding block so the packet remains lossless.
    const end = nextStart === undefined ? lines.length : nextStart - 1;
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(lines[start - 1] ?? "");
    if (headingMatch) heading = headingMatch[1]!.trim();
    return {
      id: `loc-${String(index + 1).padStart(4, "0")}`,
      h: heading,
      a: start,
      b: end,
      t: lines.slice(start - 1, end).join("\n"),
    };
  });
  const reconstructed = sections.map((section) => section.t).join("\n");
  if (reconstructed !== request.draft.markdown)
    throw new Error("Compact review preparation truncated the document");
  return { title: request.draft.title, sections };
}

export const COMPACT_REVISION_NORMALISER_VERSION = "1.0.0";

export const CompactRevisionEditSchema = z
  .object({
    id: compactText,
    st: z.enum(["applied", "unable"]),
    why: compactText,
    replacement: z.string().max(100_000).nullable(),
  })
  .strict()
  .superRefine((edit, context) => {
    if (edit.st === "applied" && edit.replacement === null)
      context.addIssue({
        code: "custom",
        path: ["replacement"],
        message: "Applied edits need text",
      });
    if (edit.st === "unable" && edit.replacement !== null)
      context.addIssue({
        code: "custom",
        path: ["replacement"],
        message: "Unable edits cannot change text",
      });
  });

export const CompactRevisionPlanSchema = z
  .object({ edits: z.array(CompactRevisionEditSchema) })
  .strict();
export type CompactRevisionPlan = z.infer<typeof CompactRevisionPlanSchema>;

/**
 * Versioned compatibility shim for the only compact aliases previously emitted
 * by otherwise schema-capable providers. It never drops keys or prose: unknown
 * keys remain present so the strict schema rejects them.
 */
export function normaliseCompactRevisionPlanV1(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const envelope = raw as Record<string, unknown>;
  const rows = envelope.edits ?? envelope.results;
  const normalisedEnvelope: Record<string, unknown> = { ...envelope };
  if (!("edits" in envelope) && "results" in envelope) {
    delete normalisedEnvelope.results;
    normalisedEnvelope.edits = rows;
  }
  if (!Array.isArray(rows)) return normalisedEnvelope;
  normalisedEnvelope.edits = rows.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    const normalised: Record<string, unknown> = { ...row };
    const alias = (canonical: string, alternate: string) => {
      if (!(canonical in row) && alternate in row) {
        normalised[canonical] = row[alternate];
        delete normalised[alternate];
      }
    };
    alias("id", "finding_id");
    alias("st", "status");
    alias("why", "reason");
    if (normalised.st === "cannot_apply") normalised.st = "unable";
    return normalised;
  });
  return normalisedEnvelope;
}

export function parseCompactRevisionPlan(raw: unknown): CompactRevisionPlan {
  return CompactRevisionPlanSchema.parse(normaliseCompactRevisionPlanV1(raw));
}

function markdownRange(
  markdown: string,
  location: RevisionRequest["accepted_findings"][number]["location"],
): [number, number] | null {
  const lines = markdown.split("\n");
  if (location.line_start !== undefined) {
    const start = location.line_start - 1;
    const end = (location.line_end ?? location.line_start) - 1;
    return start >= 0 && end >= start && end < lines.length ? [start, end] : null;
  }
  if (!location.section) return null;
  const wanted = location.section.trim().toLocaleLowerCase("en-GB");
  if (wanted === "introduction") {
    const firstH2 = lines.findIndex((line, index) => index > 0 && /^##\s+/.test(line));
    return [0, (firstH2 < 0 ? lines.length : firstH2) - 1];
  }
  const matches = lines.flatMap((line, index) =>
    /^#{1,6}\s+(.+)$/.exec(line)?.[1]?.trim().toLocaleLowerCase("en-GB") === wanted ? [index] : [],
  );
  if (matches.length !== 1) return null;
  const start = matches[0]!;
  const next = lines.findIndex((line, index) => index > start && /^#{1,6}\s+/.test(line));
  return [start, (next < 0 ? lines.length : next) - 1];
}

function normalisedPath(field: string): string[] {
  const parts = field.split(".");
  if (parts[0] === "on_page") parts.shift();
  if (parts[0] === "body_markdown") parts[0] = "markdown";
  return parts;
}

const EXACT_STRING_LEAVES = new Set([
  "title",
  "slug",
  "meta_title",
  "meta_description",
  "og_title",
  "og_description",
]);

function isExactEditablePath(path: string[]): boolean {
  if (path.length === 1 && EXACT_STRING_LEAVES.has(path[0]!)) return true;
  return (
    path.length === 3 &&
    ((path[0] === "images" &&
      /^(?:0|[1-9][0-9]*)$/.test(path[1]!) &&
      ["alt", "filename"].includes(path[2]!)) ||
      (path[0] === "faqs" &&
        /^(?:0|[1-9][0-9]*)$/.test(path[1]!) &&
        ["question", "answer"].includes(path[2]!)))
  );
}

export function prepareRevisionTargets(request: RevisionRequest) {
  return request.accepted_findings.map((finding) => {
    const path = normalisedPath(finding.location.field);
    const range =
      path[0] === "markdown"
        ? markdownRange(request.current_document.markdown, finding.location)
        : null;
    let current: unknown;
    if (range)
      current = request.current_document.markdown
        .split("\n")
        .slice(range[0], range[1] + 1)
        .join("\n");
    else {
      current = request.current_document as unknown;
      for (const segment of path)
        current = (current as Record<string, unknown> | undefined)?.[segment];
    }
    const eligible = Boolean(range) || isExactEditablePath(path);
    return {
      id: finding.id,
      rule: finding.rule_reference,
      location: finding.location,
      preclassified: eligible ? null : "unable",
      ...(eligible
        ? {
            issue: finding.issue,
            fix: finding.suggested_fix,
            current: current === undefined ? null : current,
          }
        : {}),
    };
  });
}

/** Expands a transient finding-scoped plan into the durable full-document response candidate. */
export function applyCompactRevisionPlan(
  request: RevisionRequest,
  rawPlan: unknown,
): {
  document: StructuredDraft;
  finding_results: Array<{ finding_id: string; status: "applied" | "unable"; reason: string }>;
} {
  const parsedPlan = parseCompactRevisionPlan(rawPlan);
  const prepared = prepareRevisionTargets(request);
  const plan: CompactRevisionPlan = {
    edits: parsedPlan.edits.map((edit, index) =>
      prepared[index]?.preclassified === "unable"
        ? {
            id: edit.id,
            st: "unable",
            why: "Application rejected an ambiguous or server-owned target.",
            replacement: null,
          }
        : edit,
    ),
  };
  if (
    plan.edits.length !== request.accepted_findings.length ||
    plan.edits.some((edit, index) => edit.id !== request.accepted_findings[index]?.id)
  )
    throw new Error("Compact revision plan does not cover accepted findings in order");

  const document = structuredClone(request.current_document) as StructuredDraft;
  const markdownEdits: Array<{ start: number; end: number; replacement: string }> = [];
  for (let index = 0; index < plan.edits.length; index += 1) {
    const edit = plan.edits[index]!;
    if (edit.st === "unable") continue;
    const finding = request.accepted_findings[index]!;
    const path = normalisedPath(finding.location.field);
    if (path[0] === "markdown") {
      const range = markdownRange(request.current_document.markdown, finding.location);
      if (!range) throw new Error("Compact revision edit has no precise Markdown target");
      markdownEdits.push({ start: range[0], end: range[1], replacement: edit.replacement! });
      continue;
    }
    if (!isExactEditablePath(path))
      throw new Error("Compact revision edit targets a server-owned or non-leaf field");
    let parent: unknown = document;
    for (const segment of path.slice(0, -1)) {
      if (typeof parent !== "object" || parent === null || !(segment in parent))
        throw new Error("Compact revision edit target does not exist");
      parent = (parent as Record<string, unknown>)[segment];
    }
    const leaf = path.at(-1)!;
    if (typeof parent !== "object" || parent === null || !(leaf in parent))
      throw new Error("Compact revision edit target does not exist");
    const previous = (parent as Record<string, unknown>)[leaf];
    (parent as Record<string, unknown>)[leaf] =
      typeof previous === "string" ? edit.replacement! : JSON.parse(edit.replacement!);
  }
  markdownEdits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < markdownEdits.length; index += 1)
    if (markdownEdits[index - 1]!.start <= markdownEdits[index]!.end)
      throw new Error("Compact revision edits overlap");
  const lines = document.markdown.split("\n");
  for (const edit of markdownEdits)
    lines.splice(edit.start, edit.end - edit.start + 1, ...edit.replacement.split("\n"));
  document.markdown = lines.join("\n");
  return {
    document: StructuredDraftSchema.parse(document),
    finding_results: plan.edits.map((edit) => ({
      finding_id: edit.id,
      status: edit.st,
      reason: edit.why,
    })),
  };
}

const COHERENCE_NEIGHBOUR_LINES = 6;
const COHERENCE_MAX_LINES = 120;

/** Builds bounded, absolute-line-numbered parent/current windows around persisted changed hunks. */
export function prepareCoherenceWindows(request: CoherenceRequest) {
  const parentLines = request.parent_document.markdown.split("\n");
  const currentLines = request.current_document.markdown.split("\n");
  const candidates = request.revision_audits.flatMap((audit) =>
    audit.changed &&
    (audit.location.field === "body_markdown" || audit.location.field === "markdown")
      ? audit.hunks.map((hunk) => {
          const source = {
            a: Math.max(1, hunk.source_start - COHERENCE_NEIGHBOUR_LINES),
            b: Math.min(
              parentLines.length,
              Math.max(hunk.source_start, hunk.source_end) + COHERENCE_NEIGHBOUR_LINES,
            ),
            changed_a: hunk.source_start,
            changed_b: hunk.source_end,
          };
          const proposed = {
            a: Math.max(1, hunk.proposed_start - COHERENCE_NEIGHBOUR_LINES),
            b: Math.min(
              currentLines.length,
              Math.max(hunk.proposed_start, hunk.proposed_end) + COHERENCE_NEIGHBOUR_LINES,
            ),
            changed_a: hunk.proposed_start,
            changed_b: hunk.proposed_end,
          };
          return { field: audit.location.field, source, proposed };
        })
      : [],
  );
  let remaining = COHERENCE_MAX_LINES;
  const windows = candidates.flatMap((window, index) => {
    const sourceCount = Math.max(0, window.source.b - window.source.a + 1);
    const proposedCount = Math.max(0, window.proposed.b - window.proposed.a + 1);
    const count = sourceCount + proposedCount;
    // Never slice a semantic change window merely to fit the packet budget.
    if (count > remaining) return [];
    remaining -= count;
    return [
      {
        id: `change-${String(index + 1).padStart(4, "0")}`,
        field: window.field,
        source: {
          ...window.source,
          text: parentLines.slice(window.source.a - 1, window.source.b).join("\n"),
        },
        proposed: {
          ...window.proposed,
          text: currentLines.slice(window.proposed.a - 1, window.proposed.b).join("\n"),
        },
      },
    ];
  });
  const fields = request.revision_audits.flatMap((audit) => {
    if (
      !audit.changed ||
      audit.location.field === "body_markdown" ||
      audit.location.field === "markdown"
    )
      return [];
    const path = normalisedPath(audit.location.field);
    const read = (draft: StructuredDraft) =>
      path.reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        draft,
      );
    return [
      {
        id: `field-${audit.finding_id}`,
        field: audit.location.field,
        parent: read(request.parent_document),
        current: read(request.current_document),
      },
    ];
  });
  const omittedRanges = Math.max(0, candidates.length - windows.length);
  if (omittedRanges > 0)
    throw new Error(
      "Final coherence context exceeds the safe review limit; no changed range was omitted or exported",
    );
  return {
    neighbour_lines: COHERENCE_NEIGHBOUR_LINES,
    windows,
    fields,
    omitted_ranges: 0,
  };
}

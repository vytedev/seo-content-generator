import { createHash } from "node:crypto";
import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import { StructuredDraftSchema, type StructuredDraft } from "./contracts/content.js";
import { inventoryFacts } from "./fact-inventory.js";
import { canonicalHash } from "./milestone-two.js";
import type { RevisionFinding } from "./milestone-four.js";
import type { FindingLocationSchema } from "./checker/index.js";

const text = z.string().trim().min(1);
export const FindingResultSchema = z
  .object({ finding_id: text, status: z.enum(["applied", "unable"]), reason: text })
  .strict();
export type FindingResult = z.infer<typeof FindingResultSchema>;
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

export const RevisionHunkSchema = z
  .object({
    source_start: z.number().int().positive(),
    source_end: z.number().int().nonnegative(),
    proposed_start: z.number().int().positive(),
    proposed_end: z.number().int().nonnegative(),
    before_hash: z.string().length(64),
    after_hash: z.string().length(64),
  })
  .strict();
export type RevisionHunk = z.infer<typeof RevisionHunkSchema>;

export type RevisionAudit = FindingResult & {
  ordinal: number;
  location: FindingLocation;
  hunks: RevisionHunk[];
  changed: boolean;
  before_hash: string;
  after_hash: string;
};

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

function path(field: string): string[] {
  const parts = field.split(".");
  const clean = parts[0] === "on_page" ? parts.slice(1) : parts;
  return clean;
}

function sectionRange(document: string, section: string): [number, number] | null {
  const lines = document.split("\n");
  const wanted = section.trim().toLocaleLowerCase("en-GB");
  if (wanted === "introduction") {
    const h1 = lines.findIndex((line) => /^#\s+/.test(line));
    const next = lines.findIndex((line, index) => index > h1 && /^##\s+/.test(line));
    return h1 >= 0 ? [h1 + 2, next < 0 ? lines.length : next] : null;
  }
  const matches = lines.flatMap((line, index) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.trim().toLocaleLowerCase("en-GB");
    return heading === wanted ? [index + 1] : [];
  });
  if (matches.length !== 1) return null;
  const start = matches[0]!;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return [start, end];
}

function locationRange(markdown: string, location: FindingLocation): [number, number] | null {
  if (location.line_start !== undefined)
    return [location.line_start, location.line_end ?? location.line_start];
  return location.section ? sectionRange(markdown, location.section) : null;
}

/** Source-coordinate line diff. Each run is expanded to complete Markdown syntax blocks. */
function markdownHunks(source: string, proposed: string): RevisionHunk[] {
  const a = source.split("\n"),
    b = proposed.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const raw: Array<{ as: number; ae: number; bs: number; be: number }> = [];
  let i = 0,
    j = 0,
    startA = -1,
    startB = -1;
  const flush = () => {
    if (startA >= 0) raw.push({ as: startA, ae: i, bs: startB, be: j });
    startA = startB = -1;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else {
      if (startA < 0) {
        startA = i;
        startB = j;
      }
      if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) i += 1;
      else j += 1;
    }
  }
  flush();

  // mdast positions ensure edits to paragraphs, headings, lists, blockquotes, tables-as-blocks and links
  // are authorised as complete semantic blocks rather than arbitrary sequential section replacements.
  const blocks = (value: string) => {
    const root = fromMarkdown(value);
    return root.children.map(
      (node) => [node.position?.start.line ?? 1, node.position?.end.line ?? 1] as [number, number],
    );
  };
  const sourceBlocks = blocks(source),
    proposedBlocks = blocks(proposed);
  const expand = (start: number, end: number, ranges: [number, number][]) => {
    if (start === end) return [start + 1, start] as [number, number];
    const touched = ranges.filter(([s, e]) => e >= start + 1 && s <= end);
    return touched.length
      ? ([Math.min(...touched.map((x) => x[0])), Math.max(...touched.map((x) => x[1]))] as [
          number,
          number,
        ])
      : ([start + 1, end] as [number, number]);
  };
  const expanded = raw.map((r) => {
    const [ss, se] = expand(r.as, r.ae, sourceBlocks),
      [ps, pe] = expand(r.bs, r.be, proposedBlocks);
    return { ss, se, ps, pe };
  });
  // Block expansion can make neighbouring raw runs overlap; merge before authority attribution.
  const merged: typeof expanded = [];
  for (const item of expanded) {
    const last = merged.at(-1);
    if (last && item.ss <= last.se + 1 && item.ps <= last.pe + 1) {
      last.se = Math.max(last.se, item.se);
      last.pe = Math.max(last.pe, item.pe);
    } else merged.push({ ...item });
  }
  return merged.map(({ ss, se, ps, pe }) => {
    const before = ss <= se ? a.slice(ss - 1, se).join("\n") : "";
    const after = ps <= pe ? b.slice(ps - 1, pe).join("\n") : "";
    return {
      source_start: ss,
      source_end: se,
      proposed_start: ps,
      proposed_end: pe,
      before_hash: hash(before),
      after_hash: hash(after),
    };
  });
}

function overlaps(range: [number, number], hunk: RevisionHunk): boolean {
  if (hunk.source_end < hunk.source_start)
    return hunk.source_start >= range[0] && hunk.source_start <= range[1] + 1;
  return hunk.source_start <= range[1] && hunk.source_end >= range[0];
}

function markdownField(location: FindingLocation): boolean {
  const root = path(location.field)[0];
  return root === "body_markdown" || root === "markdown";
}

function exactStructuredTarget(
  current: StructuredDraft,
  proposed: StructuredDraft,
  finding: RevisionFinding,
) {
  const parts = path(finding.location.field),
    root = parts[0];
  if (
    ["title", "meta_title", "slug", "meta_description", "og_title", "og_description"].includes(
      root ?? "",
    ) &&
    parts.length === 1
  ) {
    const key = root as
      "title" | "meta_title" | "slug" | "meta_description" | "og_title" | "og_description";
    const proposedValue = proposed[key] ?? (key === "meta_title" ? proposed.title : undefined);
    if (proposedValue === undefined) return null;
    return {
      // Legacy frozen drafts predate the distinct meta_title field. Treat the
      // documented title-derived value as their immutable before-state while
      // still writing a new, independent meta_title leaf on correction.
      before: current[key] ?? (key === "meta_title" ? current.title : undefined),
      after: proposedValue,
      apply: (d: StructuredDraft) => void (d[key] = proposedValue),
    };
  }
  if ((root === "images" || root === "faqs") && parts.length === 3) {
    const index = Number(parts[1]),
      key = parts[2];
    if (!Number.isInteger(index) || index < 0) return null;
    if (
      root === "images" &&
      (key === "alt" || key === "filename") &&
      current.images[index] &&
      proposed.images[index]
    )
      return {
        before: current.images[index]![key],
        after: proposed.images[index]![key],
        apply: (d: StructuredDraft) => void (d.images[index]![key] = proposed.images[index]![key]),
      };
    if (
      root === "faqs" &&
      (key === "question" || key === "answer") &&
      current.faqs[index] &&
      proposed.faqs[index]
    )
      return {
        before: current.faqs[index]![key],
        after: proposed.faqs[index]![key],
        apply: (d: StructuredDraft) => void (d.faqs[index]![key] = proposed.faqs[index]![key]),
      };
  }
  return null;
}

function sameLocation(a: FindingLocation, b: FindingLocation): boolean {
  return canonicalHash(a) === canonicalHash(b);
}

export function revisionManifestHash(audits: RevisionAudit[]): string {
  return canonicalHash(
    audits.map(
      ({ finding_id, ordinal, status, location, hunks, changed, before_hash, after_hash }) => ({
        finding_id,
        ordinal,
        status,
        location,
        hunks,
        changed,
        before_hash,
        after_hash,
      }),
    ),
  );
}

/** Computes one source-based edit script, attributes every hunk exactly once, then applies in reverse source order. */
export function applyRevisionEnvelope(input: {
  current: StructuredDraft;
  proposed: StructuredDraft;
  findings: RevisionFinding[];
  results: FindingResult[];
  rejected_locations?: FindingLocation[];
  verified_fact_locations?: FindingLocation[];
}): { document: StructuredDraft; audits: RevisionAudit[]; manifest_hash: string } {
  if (
    input.results.length !== input.findings.length ||
    input.results.some((r, i) => r.finding_id !== input.findings[i]?.id)
  )
    throw new Error("Revision finding results do not exactly match accepted finding order");
  if (new Set(input.results.map((r) => r.finding_id)).size !== input.results.length)
    throw new Error("Duplicate revision finding result");
  const document = structuredClone(input.current),
    audits: RevisionAudit[] = [];
  const structuredLocationCounts = new Map<string, number>();
  for (const finding of input.findings) {
    if (markdownField(finding.location)) continue;
    // Count authority by the same normalised target path used for application, so aliases
    // such as title/on_page.meta_title cannot claim one structured leaf twice.
    const key = canonicalHash(path(finding.location.field));
    structuredLocationCounts.set(key, (structuredLocationCounts.get(key) ?? 0) + 1);
  }
  const hunks = markdownHunks(input.current.markdown, input.proposed.markdown);
  const sourceLines = input.current.markdown.split("\n");
  const proposedLines = input.proposed.markdown.split("\n");
  // A true move is represented by the diff as a deletion plus a separate insertion. Treat both
  // endpoints as one indivisible operation: this implementation cannot prove that accepted
  // findings explicitly authorise the relationship, so it fails closed rather than deleting text.
  const movedHunks = new Set<number>();
  for (const [deletedIndex, deleted] of hunks.entries()) {
    if (deleted.source_end < deleted.source_start || deleted.proposed_end >= deleted.proposed_start)
      continue;
    const removed = sourceLines.slice(deleted.source_start - 1, deleted.source_end).join("\n");
    if (!removed) continue;
    for (const [insertedIndex, inserted] of hunks.entries()) {
      if (
        inserted.source_end >= inserted.source_start ||
        inserted.proposed_end < inserted.proposed_start
      )
        continue;
      const added = proposedLines
        .slice(inserted.proposed_start - 1, inserted.proposed_end)
        .join("\n");
      if (added === removed) {
        movedHunks.add(deletedIndex);
        movedHunks.add(insertedIndex);
      }
    }
  }
  const owners = new Map<number, number>();
  const rejected = input.rejected_locations ?? [];
  const factual = inventoryFacts(input.current)
    .map((item) => item.location)
    .filter(markdownField);

  for (const [hi, hunk] of hunks.entries()) {
    if (movedHunks.has(hi)) continue;
    const candidates = input.findings.flatMap((finding, index) => {
      if (!markdownField(finding.location)) return [];
      // Markdown authority must be an app-issued exact block range. A section label is context only.
      if (finding.location.line_start === undefined) return [];
      const range = locationRange(input.current.markdown, finding.location);
      return range && overlaps(range, hunk) ? [index] : [];
    });
    if (candidates.length !== 1) continue;
    const owner = candidates[0]!,
      accepted = input.findings[owner]!;
    const rejectedOverlap = rejected.some(
      (location) =>
        markdownField(location) &&
        locationRange(input.current.markdown, location) &&
        overlaps(locationRange(input.current.markdown, location)!, hunk),
    );
    if (rejectedOverlap) continue;
    const factualOverlap = factual.some((location) =>
      overlaps([location.line_start!, location.line_end ?? location.line_start!], hunk),
    );
    const verified = (input.verified_fact_locations ?? []).some((location) =>
      sameLocation(location, accepted.location),
    );
    const factAuthority =
      accepted.category === "fact_check" ||
      accepted.category === "factual_accuracy" ||
      accepted.rule_reference.includes("fact");
    if (factualOverlap && !(factAuthority && verified)) continue;
    owners.set(hi, owner);
  }

  const appliedHunks = new Set<number>();
  for (let index = 0; index < input.findings.length; index += 1) {
    const finding = input.findings[index]!,
      supplied = input.results[index]!;
    let result = supplied;
    const owned = hunks.flatMap((h, hi) => (owners.get(hi) === index ? [{ h, hi }] : []));
    const target = exactStructuredTarget(input.current, input.proposed, finding);
    const structuredRejected = rejected.some((location) =>
      sameLocation(location, finding.location),
    );
    const structuredAmbiguous =
      !markdownField(finding.location) &&
      (structuredLocationCounts.get(canonicalHash(path(finding.location.field))) ?? 0) !== 1;
    if (result.status === "applied" && markdownField(finding.location) && owned.length === 0)
      result = {
        ...result,
        status: "unable",
        reason:
          "No exact, unambiguous and non-conflicting source hunk is authorised by this location.",
      };
    if (
      result.status === "applied" &&
      !markdownField(finding.location) &&
      (!target ||
        structuredRejected ||
        structuredAmbiguous ||
        hash(target.before) === hash(target.after))
    )
      result = {
        ...result,
        status: "unable",
        reason:
          "The structured location was unchanged, rejected or could not be established exactly.",
      };
    const before = target?.before ?? owned.map((x) => x.h.before_hash);
    if (result.status === "applied") {
      if (target) {
        target.apply(document);
        // Narrow OG mirror: only mirror an already mirrored pair to the exact revised counterpart.
        const root = path(finding.location.field)[0];
        if (
          root === "meta_title" &&
          input.current.og_title === (input.current.meta_title ?? input.current.title) &&
          input.proposed.og_title === (input.proposed.meta_title ?? input.proposed.title)
        )
          document.og_title = input.proposed.og_title;
        if (
          root === "meta_description" &&
          input.current.og_description === input.current.meta_description &&
          input.proposed.og_description === input.proposed.meta_description
        )
          document.og_description = input.proposed.og_description;
      }
      owned.forEach((x) => appliedHunks.add(x.hi));
    }
    const after = target
      ? (document as any)[path(finding.location.field)[0]!]
      : owned.map((x) => x.h.after_hash);
    audits.push({
      ...result,
      ordinal: index,
      location: finding.location,
      hunks: owned.map((x) => x.h),
      changed: result.status === "applied",
      before_hash: hash(before),
      after_hash: result.status === "applied" ? hash(after) : hash(before),
    });
  }
  const lines = document.markdown.split("\n");
  [...appliedHunks]
    .sort((a, b) => hunks[b]!.source_start - hunks[a]!.source_start)
    .forEach((index) => {
      const h = hunks[index]!;
      lines.splice(
        h.source_start - 1,
        Math.max(0, h.source_end - h.source_start + 1),
        ...(h.proposed_start <= h.proposed_end
          ? proposedLines.slice(h.proposed_start - 1, h.proposed_end)
          : []),
      );
    });
  document.markdown = lines.join("\n");
  // Placement is never prose authority. Restore the typed contract and exact markers from source.
  document.images = document.images.map((image, index) => ({
    ...image,
    placement: structuredClone(input.current.images[index]?.placement ?? image.placement),
  }));
  for (const image of input.current.images) {
    const marker = `<!-- MOBELARIS_IMAGE:${image.placement.marker} -->`;
    if (input.current.markdown.includes(marker) && !document.markdown.includes(marker))
      throw new Error("Revision removed an exact image placement marker");
  }
  document.claims = structuredClone(input.current.claims);
  const parsed = StructuredDraftSchema.parse(document);
  return { document: parsed, audits, manifest_hash: revisionManifestHash(audits) };
}

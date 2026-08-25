import { PROVISIONAL_US_TO_UK_WORD_MAP_V1 } from "./checker/v1/policy-data.js";
import type { StructuredDraft } from "./contracts/content.js";
import type { RevisionFinding, RevisionRequest } from "./milestone-four.js";
import { shortenTitleAtWordBoundary, unicodeLength } from "./editorial-integrity.js";
import type { FindingResult } from "./revision-application.js";

export const REVISION_PLANNING_VERSION = "1.3.0";
export const DETERMINISTIC_REVISION_POLICY_VERSION = "bounded-editorial-corrections-v2";
export const DETERMINISTIC_REVISION_ALLOWLIST = [
  "style.british_english_provisional",
  "on_page.meta_title.length",
  "on_page.meta_description.length",
  "keyword.primary.h2",
  "keyword.related.meaningful_section",
  "links.verified_internal_presence",
] as const;

export type RevisionPlanRoute = "deterministic" | "model" | "unable";
export interface PlannedRevisionFinding {
  finding: RevisionFinding;
  ordinal: number;
  route: RevisionPlanRoute;
  replacement?:
    | {
        kind: "markdown";
        line_start: number;
        line_end: number;
        source: string;
        target: string;
        block_source: string;
        block_target: string;
      }
    | {
        kind: "field";
        field: "meta_title" | "meta_description";
        source: string;
        target: string;
      };
  reason?: string;
}

function preserveCasing(source: string, replacement: string): string {
  return [...replacement]
    .map((character, index) => {
      const sourceCharacter = source[Math.min(index, source.length - 1)]!;
      return sourceCharacter === sourceCharacter.toLocaleUpperCase("en-GB")
        ? character.toLocaleUpperCase("en-GB")
        : character.toLocaleLowerCase("en-GB");
    })
    .join("");
}

function britishEnglishPlan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  const { line_start: start, line_end } = finding.location;
  if (finding.location.field !== "body_markdown" || start === undefined) return null;
  const lines = request.current_document.markdown.split("\n");
  const end = line_end ?? start;
  if (start < 1 || end < start || end > lines.length) return null;
  const block = lines.slice(start - 1, end).join("\n");
  const candidates = Object.entries(PROVISIONAL_US_TO_UK_WORD_MAP_V1).flatMap(([us, uk]) => {
    const matches = [...block.matchAll(new RegExp(`\\b${us}\\b`, "gi"))];
    return matches.map((match) => ({ match: match[0]!, uk }));
  });
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const target = preserveCasing(candidate.match, candidate.uk);
  return {
    kind: "markdown",
    line_start: start,
    line_end: end,
    source: candidate.match,
    target,
    block_source: block,
    block_target: block.replace(new RegExp(`\\b${candidate.match}\\b`), target),
  };
}

function metaTitleLengthPlan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  const field = finding.location.field.replace(/^on_page\./, "");
  const source = request.current_document.meta_title ?? request.current_document.title;
  if (field !== "meta_title" || unicodeLength(source) <= 60) return null;
  const target = shortenTitleAtWordBoundary(source, 60);
  if (
    target.length < 55 ||
    !target
      .toLocaleLowerCase("en-GB")
      .includes(request.handoff.primary_keyword.toLocaleLowerCase("en-GB"))
  )
    return null;
  return { kind: "field", field: "meta_title", source, target };
}

function metaDescriptionLengthPlan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  const field = finding.location.field.replace(/^on_page\./, "");
  const source = request.current_document.meta_description;
  if (field !== "meta_description") return null;
  const length = unicodeLength(source);
  // A short, neutral UK qualifier is only safe when it lands directly inside
  // the required range. Larger editorial changes remain model-owned.
  if (length < 145 || length > 149) return null;
  const target = `${source.replace(/[.,;:!?\s]+$/u, "")} — UK`;
  return unicodeLength(target) >= 150 && unicodeLength(target) <= 155
    ? { kind: "field", field: "meta_description", source, target }
    : null;
}

function primaryKeywordH2Plan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  if (!["body_markdown", "markdown"].includes(finding.location.field)) return null;
  const lines = request.current_document.markdown.split("\n");
  const authorisedLine = finding.location.line_start;
  const index =
    authorisedLine === undefined
      ? lines.findIndex((line) => /^##\s+\S/.test(line))
      : authorisedLine - 1;
  if (index < 0 || index >= lines.length || !/^##\s+\S/.test(lines[index]!)) return null;
  const block = lines[index]!;
  const keyword = request.handoff.primary_keyword.trim();
  if (!keyword || block.toLocaleLowerCase("en-GB").includes(keyword.toLocaleLowerCase("en-GB")))
    return null;
  const blockTarget = `${block.replace(/[.:;!?\s]+$/u, "")}: ${keyword}`;
  return {
    kind: "markdown",
    line_start: index + 1,
    line_end: index + 1,
    source: block,
    target: blockTarget,
    block_source: block,
    block_target: blockTarget,
  };
}

function exactMarkdownBlock(
  request: RevisionRequest,
  finding: RevisionFinding,
): { lines: string[]; start: number; end: number; block: string } | null {
  const start = finding.location.line_start;
  if (finding.location.field !== "body_markdown" || start === undefined) return null;
  const lines = request.current_document.markdown.split("\n");
  const end = finding.location.line_end ?? start;
  if (start < 1 || end < start || end > lines.length) return null;
  return { lines, start, end, block: lines.slice(start - 1, end).join("\n") };
}

function verifiedLinkPlan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  const target = exactMarkdownBlock(request, finding);
  if (!target || request.internal_links?.length !== 1) return null;
  const frozenUrl = request.internal_links[0]!.url;
  const matches = [...target.block.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)].filter(
    (match) => match[2] !== frozenUrl,
  );
  // URL-only replacement: anchor prose and every surrounding byte remain unchanged.
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const source = match[0];
  const replacement = `[${match[1]}](${frozenUrl})`;
  return {
    kind: "markdown",
    line_start: target.start,
    line_end: target.end,
    source,
    target: replacement,
    block_source: target.block,
    block_target:
      target.block.slice(0, match.index) +
      replacement +
      target.block.slice(match.index! + source.length),
  };
}

function isSafeModelTarget(finding: RevisionFinding): boolean {
  const field = finding.location.field.replace(/^on_page\./, "");
  if (
    ["title", "meta_title", "slug", "meta_description", "og_title", "og_description"].includes(
      field,
    )
  )
    return true;
  if (/^(?:images\.[0-9]+\.(?:alt|filename)|faqs\.[0-9]+\.(?:question|answer))$/.test(field))
    return true;
  return (
    (field === "body_markdown" || field === "markdown") && finding.location.line_start !== undefined
  );
}

/** Frozen, versioned request reducer. Deterministic authority is deliberately one-rule-only. */
export function planRevisionRequest(request: RevisionRequest): PlannedRevisionFinding[] {
  return request.accepted_findings.map((finding, ordinal) => {
    if ((DETERMINISTIC_REVISION_ALLOWLIST as readonly string[]).includes(finding.rule_reference)) {
      const replacement =
        finding.rule_reference === "style.british_english_provisional"
          ? britishEnglishPlan(request, finding)
          : finding.rule_reference === "on_page.meta_title.length"
            ? metaTitleLengthPlan(request, finding)
            : finding.rule_reference === "on_page.meta_description.length"
              ? metaDescriptionLengthPlan(request, finding)
              : finding.rule_reference === "keyword.primary.h2"
                ? primaryKeywordH2Plan(request, finding)
                : finding.rule_reference === "keyword.related.meaningful_section"
                  ? null
                  : verifiedLinkPlan(request, finding);
      if (replacement) return { finding, ordinal, route: "deterministic", replacement };
      // Initial operator revision may use a scoped model edit for a missing keyword or link.
      // Exceptional link repair is stricter: without one existing URL to replace, a model
      // could only invent anchor or surrounding prose, so retain the blocker for the operator.
      const exceptionalMissingLink =
        request.revision_source === "operator_authorised_repair" &&
        finding.rule_reference === "links.verified_internal_presence";
      if (
        !exceptionalMissingLink &&
        ["keyword.related.meaningful_section", "links.verified_internal_presence"].includes(
          finding.rule_reference,
        ) &&
        isSafeModelTarget(finding)
      )
        return { finding, ordinal, route: "model" };
      return {
        finding,
        ordinal,
        route: "unable",
        reason: exceptionalMissingLink
          ? "Exceptional link repair could not safely replace one exact existing URL without changing anchor or surrounding prose."
          : "The authorised location did not support one exact frozen-policy correction.",
      };
    }
    return isSafeModelTarget(finding)
      ? { finding, ordinal, route: "model" }
      : {
          finding,
          ordinal,
          route: "unable",
          reason: "Application rejected an ambiguous or server-owned target before model planning.",
        };
  });
}

export function mergeRevisionPlan(input: {
  request: RevisionRequest;
  plan: PlannedRevisionFinding[];
  modelDocument?: StructuredDraft;
  modelResults?: FindingResult[];
}): { document: StructuredDraft; results: FindingResult[] } {
  const document = structuredClone(input.modelDocument ?? input.request.current_document);
  const byId = new Map((input.modelResults ?? []).map((result) => [result.finding_id, result]));
  const results = input.plan.map((item) => {
    if (item.route === "model") {
      const result = byId.get(item.finding.id);
      if (!result) throw new Error("Model revision subset did not cover its findings in order");
      return result;
    }
    if (item.route === "unable")
      return { finding_id: item.finding.id, status: "unable" as const, reason: item.reason! };
    const replacement = item.replacement!;
    if (replacement.kind === "field") {
      // Resolve the authorised source exactly as the planner did. Legacy frozen
      // drafts predate the distinct meta_title field, so its documented
      // before-state is the title (see revision-application.ts). Comparing the
      // bare leaf would make every such authorised repair permanently "unable",
      // deadlocking a run on a blocker it is allowed to fix. The comparison
      // itself stays exact.
      const authorisedSource =
        document[replacement.field] ??
        (replacement.field === "meta_title" ? document.title : undefined);
      if (authorisedSource !== replacement.source)
        return {
          finding_id: item.finding.id,
          status: "unable" as const,
          reason: "The deterministic field no longer matched its authorised source.",
        };
      document[replacement.field] = replacement.target;
    } else {
      const occurrences = document.markdown.split(replacement.block_source).length - 1;
      if (occurrences !== 1)
        return {
          finding_id: item.finding.id,
          status: "unable" as const,
          reason: "The deterministic target no longer had one exact authorised occurrence.",
        };
      document.markdown = document.markdown.replace(
        replacement.block_source,
        replacement.block_target,
      );
    }
    return {
      finding_id: item.finding.id,
      status: "applied" as const,
      reason: `Applied frozen policy ${DETERMINISTIC_REVISION_POLICY_VERSION}.`,
    };
  });
  return { document, results };
}

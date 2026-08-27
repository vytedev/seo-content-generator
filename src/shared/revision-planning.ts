import { PROVISIONAL_US_TO_UK_WORD_MAP_V1 } from "./checker/v1/policy-data.js";
// The frozen checker's own grade function: ranking targets with anything else
// could drift from the rule the candidate preflight must actually satisfy.
import { calculateReadabilityGrade } from "./checker/v1/rules.js";
import type { StructuredDraft } from "./contracts/content.js";
import { inventoryFacts } from "./fact-inventory.js";
import type { RevisionFinding, RevisionRequest } from "./milestone-four.js";
import { shortenTitleAtWordBoundary, unicodeLength } from "./editorial-integrity.js";
import type { FindingLocation, FindingResult } from "./revision-application.js";

export const REVISION_PLANNING_VERSION = "1.5.0";
export const DETERMINISTIC_REVISION_POLICY_VERSION = "bounded-editorial-corrections-v3";
export const DETERMINISTIC_REVISION_ALLOWLIST = [
  "style.british_english_provisional",
  "on_page.meta_title.length",
  "on_page.meta_description.length",
  "keyword.primary.h2",
  "keyword.related.meaningful_section",
  "links.verified_internal_presence",
] as const;

/**
 * Identity of the application-owned location binding below. The checker emits
 * several rules with a field but no line range, and both the deterministic
 * planners and `isSafeModelTarget` require an exact `line_start`, so those
 * findings could never be corrected. Binding is deliberately rule-specific:
 * only rules listed here gain a location, because binding an arbitrary
 * paragraph to a structural rule would authorise an edit that cannot resolve
 * it. Every other locationless rule keeps reaching the bounded Step 1.11
 * fallback instead.
 */
export const REVISION_BINDING_VERSION = "2.0.0";
export const BINDABLE_LOCATIONLESS_RULES = [
  "keyword.primary.h2",
  "style.readability_grade_8",
] as const;

const PROTECTED_HEADING_LABELS = new Set(["conclusion", "key takeaways", "faq", "faqs"]);
const IMAGE_MARKER_PREFIX = "<!-- MOBELARIS_IMAGE:";

export interface BoundRevisionLocation {
  field: "body_markdown";
  line_start: number;
  line_end: number;
  section?: string;
}

/** Protected source ranges plus protected section labels a binding must never target. */
export interface RevisionBindingExclusions {
  lines?: ReadonlyArray<readonly [number, number]>;
  sections?: ReadonlySet<string>;
}

const normaliseHeading = (value: string) =>
  value.trim().toLocaleLowerCase("en-GB").replace(/\s+/gu, " ");

function excluded(
  start: number,
  end: number,
  section: string | null,
  exclusions: RevisionBindingExclusions | undefined,
): boolean {
  if ((exclusions?.lines ?? []).some(([from, to]) => start <= to && end >= from)) return true;
  return section !== null && Boolean(exclusions?.sections?.has(normaliseHeading(section)));
}

interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

function headings(lines: string[]): MarkdownHeading[] {
  return lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match ? [{ level: match[1]!.length, text: match[2]!, line: index + 1 }] : [];
  });
}

/**
 * The exact `keyword.primary.h2` correction for one authorised source line, or
 * null when that line is not a safely editable H2.
 *
 * This is the single safety predicate: the binder uses it to choose a line and
 * the planner re-applies it to whatever line it was authorised for. Re-checking
 * matters because an exceptional binding is persisted and replayed later, so
 * the document it was chosen against may no longer look the same.
 *
 * The correction appends the keyword to the heading text, so the `##` prefix —
 * and therefore the heading hierarchy — is preserved by construction. H1 and
 * deeper levels, the protected Conclusion/Key Takeaways/FAQ headings, excluded
 * ranges, headings that already contain the keyword, and any correction that
 * would duplicate an existing heading are all refused.
 */
export function primaryKeywordH2Correction(input: {
  markdown: string;
  line: number;
  primaryKeyword: string;
  exclusions?: RevisionBindingExclusions;
}): { source: string; target: string } | null {
  const keyword = input.primaryKeyword.trim();
  const normalisedKeyword = normaliseHeading(keyword);
  if (!normalisedKeyword) return null;
  const lines = input.markdown.split("\n");
  const source = lines[input.line - 1];
  if (source === undefined) return null;
  const match = /^##\s+(.+?)\s*$/.exec(source);
  if (!match) return null;
  const text = match[1]!;
  const label = normaliseHeading(text);
  if (PROTECTED_HEADING_LABELS.has(label) || label.includes(normalisedKeyword)) return null;
  if (excluded(input.line, input.line, text, input.exclusions)) return null;
  const target = `${source.replace(/[.:;!?\s]+$/u, "")}: ${keyword}`;
  const corrected = normaliseHeading(target.replace(/^##\s+/, ""));
  const existing = new Set(headings(lines).map((heading) => normaliseHeading(heading.text)));
  return existing.has(corrected) ? null : { source, target };
}

/** Binds `keyword.primary.h2` to the first H2 line the shared predicate accepts. */
export function bindPrimaryKeywordH2(input: {
  markdown: string;
  primaryKeyword: string;
  exclusions?: RevisionBindingExclusions;
}): BoundRevisionLocation | null {
  const lines = input.markdown.split("\n");
  for (const heading of headings(lines)) {
    if (heading.level !== 2) continue;
    const correction = primaryKeywordH2Correction({
      markdown: input.markdown,
      line: heading.line,
      primaryKeyword: input.primaryKeyword,
      ...(input.exclusions ? { exclusions: input.exclusions } : {}),
    });
    if (correction)
      return { field: "body_markdown", line_start: heading.line, line_end: heading.line };
  }
  return null;
}

interface MarkdownParagraph {
  start: number;
  end: number;
  words: number;
  section: string | null;
  first: boolean;
}

/**
 * List, quote and HTML blocks are not prose. Excluding HTML matters: the image
 * placement marker is an HTML comment on its own line, and counting it as the
 * first block would make the direct-answer paragraph look like ordinary body
 * prose and therefore selectable.
 */
const nonProse = (line: string) => /^\s*(?:[-*>]|<|\d+[.)]\s+)/.test(line);

/** Exact prose paragraphs, in source order, with the section heading that owns each. */
function paragraphs(lines: string[]): MarkdownParagraph[] {
  const found: MarkdownParagraph[] = [];
  let section: string | null = null;
  let seenProse = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (/^#{1,6}\s+/.test(line)) {
      section = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.trim() ?? null;
      index += 1;
      continue;
    }
    if (!line.trim() || nonProse(line)) {
      index += 1;
      continue;
    }
    const start = index + 1;
    let words = 0;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^#{1,6}\s+/.test(lines[index]!) &&
      !nonProse(lines[index]!)
    ) {
      words += lines[index]!.trim().split(/\s+/).length;
      index += 1;
    }
    found.push({ start, end: index, words, section, first: !seenProse });
    seenProse = true;
  }
  return found;
}

/**
 * Deterministic, versioned selection of readability targets.
 *
 * `style.readability_grade_8` is a whole-document rule, so one paragraph
 * usually cannot move Grade 9.7 to Grade 8. One accepted readability finding
 * may therefore authorise several exact, non-contiguous prose blocks — never
 * `body_markdown` as a whole, and never one broad span that would swallow
 * unauthorised content between the blocks.
 *
 * Ranking reuses the frozen checker's own `calculateReadabilityGrade`, so the
 * "hardest paragraph" signal cannot drift from the rule being satisfied. Only
 * paragraphs already above the target are eligible: simplifying prose that is
 * already simple cannot lower the document mean.
 */
export const READABILITY_SELECTOR_VERSION = "1.0.0";
export const READABILITY_TARGET_GRADE = 8;
export const READABILITY_MAX_BLOCKS = 6;
export const READABILITY_MAX_SOURCE_CHARACTERS = 6_000;
export const READABILITY_MAX_SOURCE_LINES = 40;

export interface ReadabilityBlock {
  /** Application-issued identity; the model may only ever echo these back. */
  id: string;
  line_start: number;
  line_end: number;
  text: string;
  grade: number;
}

function eligibleReadabilityParagraphs(
  lines: string[],
  exclusions: RevisionBindingExclusions | undefined,
  reserved: ReadonlyArray<readonly [number, number]> | undefined,
): MarkdownParagraph[] {
  return paragraphs(lines).filter((item) => {
    // The direct answer is owned and word-bounded by `structure.direct_answer`.
    if (item.first || item.section === null) return false;
    if (PROTECTED_HEADING_LABELS.has(normaliseHeading(item.section))) return false;
    if (excluded(item.start, item.end, item.section, exclusions)) return false;
    // A paragraph another accepted finding already authorises would make hunk
    // ownership ambiguous, so it is never offered to readability.
    if ((reserved ?? []).some(([from, to]) => item.start <= to && item.end >= from)) return false;
    const block = lines.slice(item.start - 1, item.end).join("\n");
    return !block.includes(IMAGE_MARKER_PREFIX) && !/\[[^\]\n]+\]\([^)\s]+\)/.test(block);
  });
}

export function selectReadabilityBlocks(input: {
  findingId: string;
  markdown: string;
  exclusions?: RevisionBindingExclusions;
  reservedRanges?: ReadonlyArray<readonly [number, number]>;
}): ReadabilityBlock[] {
  const lines = input.markdown.split("\n");
  const ranked = eligibleReadabilityParagraphs(lines, input.exclusions, input.reservedRanges)
    .map((item) => {
      const text = lines.slice(item.start - 1, item.end).join("\n");
      return { item, text, grade: calculateReadabilityGrade(text) };
    })
    .filter((entry) => entry.grade > READABILITY_TARGET_GRADE)
    // Hardest first; `start` breaks ties so the set is stable for one document.
    .sort((a, b) => b.grade - a.grade || a.item.start - b.item.start);
  const selected: ReadabilityBlock[] = [];
  let characters = 0;
  let sourceLines = 0;
  for (const entry of ranked) {
    if (selected.length >= READABILITY_MAX_BLOCKS) break;
    const blockLines = entry.item.end - entry.item.start + 1;
    if (characters + entry.text.length > READABILITY_MAX_SOURCE_CHARACTERS) continue;
    if (sourceLines + blockLines > READABILITY_MAX_SOURCE_LINES) continue;
    characters += entry.text.length;
    sourceLines += blockLines;
    selected.push({
      id: `${input.findingId}::rb${selected.length + 1}`,
      line_start: entry.item.start,
      line_end: entry.item.end,
      text: entry.text,
      grade: entry.grade,
    });
  }
  // Issue blocks in source order so every downstream consumer, including the
  // provider request, sees one stable ordering.
  return selected
    .sort((a, b) => a.line_start - b.line_start)
    .map((block, index) => ({ ...block, id: `${input.findingId}::rb${index + 1}` }));
}

/** Stable identity of one selected target set, for revision operation identity. */
export function readabilityTargetSetIdentity(blocks: readonly ReadabilityBlock[]): string {
  return blocks.map((block) => `${block.line_start}-${block.line_end}`).join(",");
}

/** The first selected block, used as the finding's exact primary location. */
export function bindReadabilityParagraph(input: {
  markdown: string;
  exclusions?: RevisionBindingExclusions;
  reservedRanges?: ReadonlyArray<readonly [number, number]>;
  findingId?: string;
}): BoundRevisionLocation | null {
  const lines = input.markdown.split("\n");
  const blocks = selectReadabilityBlocks({
    findingId: input.findingId ?? "binding",
    markdown: input.markdown,
    ...(input.exclusions ? { exclusions: input.exclusions } : {}),
    ...(input.reservedRanges ? { reservedRanges: input.reservedRanges } : {}),
  });
  const first = blocks[0];
  if (!first) return null;
  const owner = paragraphs(lines).find((item) => item.start === first.line_start);
  return {
    field: "body_markdown",
    line_start: first.line_start,
    line_end: first.line_end,
    ...(owner?.section ? { section: owner.section } : {}),
  };
}

/**
 * The single rule-specific binding entry point shared by the normal Step 1.10
 * route and the exceptional operator-authorised route, so both authorise
 * exactly the same locations.
 */
export function bindLocationlessRule(input: {
  rule: string;
  markdown: string;
  primaryKeyword: string;
  exclusions?: RevisionBindingExclusions;
  reservedRanges?: ReadonlyArray<readonly [number, number]>;
}): BoundRevisionLocation | null {
  if (input.rule === "keyword.primary.h2")
    return bindPrimaryKeywordH2({
      markdown: input.markdown,
      primaryKeyword: input.primaryKeyword,
      ...(input.exclusions ? { exclusions: input.exclusions } : {}),
    });
  if (input.rule === "style.readability_grade_8")
    return bindReadabilityParagraph({
      markdown: input.markdown,
      ...(input.exclusions ? { exclusions: input.exclusions } : {}),
      ...(input.reservedRanges ? { reservedRanges: input.reservedRanges } : {}),
    });
  return null;
}

const markdownLocation = (location: { field: string }) =>
  location.field === "body_markdown" || location.field === "markdown";

/**
 * Derives the protected ranges a binding must avoid. Factual ranges come from
 * the same inventory the envelope uses to refuse fact-unsafe hunks, so a
 * binding can never authorise an edit the envelope would discard.
 */
export function revisionBindingExclusions(input: {
  document: StructuredDraft;
  rejectedLocations?: readonly FindingLocation[];
}): RevisionBindingExclusions {
  const lines: Array<readonly [number, number]> = [];
  const sections = new Set<string>();
  for (const location of inventoryFacts(input.document).map((item) => item.location))
    if (markdownLocation(location) && location.line_start !== undefined)
      lines.push([location.line_start, location.line_end ?? location.line_start]);
  for (const location of input.rejectedLocations ?? []) {
    if (!markdownLocation(location)) continue;
    if (location.line_start !== undefined)
      lines.push([location.line_start, location.line_end ?? location.line_start]);
    if (location.section) sections.add(normaliseHeading(location.section));
  }
  return { lines, sections };
}

/**
 * Applies rule-specific bindings to accepted findings the checker emitted
 * without a line range, so the deterministic planner, the model gate and
 * `applyRevisionEnvelope` all see the same exact authority. Findings whose
 * rule has no binding are returned untouched and stay `unable`.
 */
export interface RevisionFindingBindingResult {
  findings: RevisionFinding[];
  readability_blocks: Readonly<Record<string, ReadabilityBlock[]>>;
}

/**
 * Binds findings and freezes the complete readability target set once. The
 * first block in that set is the primary location; sibling ranges are reserved
 * before selection so a hard sibling cannot become an out-of-set primary.
 */
export function bindRevisionFindingsWithAuthority(input: {
  document: StructuredDraft;
  primaryKeyword: string;
  findings: readonly RevisionFinding[];
  rejectedLocations?: readonly FindingLocation[];
  exclusions?: RevisionBindingExclusions;
}): RevisionFindingBindingResult {
  const exclusions =
    input.exclusions ??
    revisionBindingExclusions({
      document: input.document,
      ...(input.rejectedLocations ? { rejectedLocations: input.rejectedLocations } : {}),
    });
  const provisional = input.findings.map((finding) => {
    if (!markdownLocation(finding.location) || finding.location.line_start !== undefined)
      return finding;
    if (finding.rule_reference === "style.readability_grade_8") return finding;
    const bound = bindLocationlessRule({
      rule: finding.rule_reference,
      markdown: input.document.markdown,
      primaryKeyword: input.primaryKeyword,
      exclusions,
    });
    return bound ? { ...finding, location: { ...finding.location, ...bound } } : finding;
  });
  const reserved: Array<readonly [number, number]> = provisional.flatMap((finding) => {
    if (finding.rule_reference === "style.readability_grade_8") return [];
    const { field, line_start: start, line_end: end } = finding.location;
    return markdownLocation({ field }) && start !== undefined
      ? [[start, end ?? start] as const]
      : [];
  });
  const readability_blocks: Record<string, ReadabilityBlock[]> = {};
  const findings = provisional.map((finding) => {
    if (
      finding.rule_reference !== "style.readability_grade_8" ||
      !markdownLocation(finding.location)
    )
      return finding;
    const blocks = selectReadabilityBlocks({
      findingId: finding.id,
      markdown: input.document.markdown,
      exclusions,
      reservedRanges: reserved,
    });
    if (blocks.length === 0) return finding;
    readability_blocks[finding.id] = blocks;
    reserved.push(...blocks.map((block) => [block.line_start, block.line_end] as const));
    const first = blocks[0]!;
    return {
      ...finding,
      location: {
        ...finding.location,
        field: "body_markdown" as const,
        line_start: first.line_start,
        line_end: first.line_end,
        ...(paragraphs(input.document.markdown.split("\n")).find(
          (item) => item.start === first.line_start,
        )?.section
          ? {
              section: paragraphs(input.document.markdown.split("\n")).find(
                (item) => item.start === first.line_start,
              )!.section!,
            }
          : {}),
      },
    };
  });
  return { findings, readability_blocks };
}

/** Backwards-compatible findings-only view for callers that do not dispatch a provider. */
export function bindRevisionFindings(input: {
  document: StructuredDraft;
  primaryKeyword: string;
  findings: readonly RevisionFinding[];
  rejectedLocations?: readonly FindingLocation[];
  exclusions?: RevisionBindingExclusions;
}): RevisionFinding[] {
  return bindRevisionFindingsWithAuthority(input).findings;
}

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
  /**
   * Exact, non-contiguous blocks this one finding authorises. Only
   * `style.readability_grade_8` uses it; every block carries its own immutable
   * source range and application-issued id.
   */
  readability_blocks?: ReadabilityBlock[];
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

/**
 * Shortens an over-length meta description into the frozen checker's 150–155
 * range.
 *
 * The checker measures `value.length`, so this counts UTF-16 code units too;
 * iterating code points means a surrogate pair is never split even though the
 * budget is expressed in units. Complete words are preferred, the exact
 * primary keyword must survive, and a candidate that cannot land inside the
 * range returns `null` so the finding stays honestly `unable`.
 */
function shortenMetaDescription(source: string, primaryKeyword: string): string | null {
  let prefix = "";
  for (const character of Array.from(source)) {
    if (prefix.length + character.length > 155) break;
    prefix += character;
  }
  const candidates: string[] = [];
  let boundary = prefix.replace(/[^\s\u00a0]*$/u, "");
  for (let guard = 0; guard < 16 && boundary.trim(); guard += 1) {
    candidates.push(boundary);
    boundary = boundary.trimEnd().replace(/[^\s\u00a0]*$/u, "");
  }
  // A mid-word cut is the last resort: preferred word boundaries come first.
  candidates.push(prefix);
  const keyword = primaryKeyword.trim().toLocaleLowerCase("en-GB");
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[\s\u00a0]+$/u, "").replace(/[.,;:!?\-–—]+$/u, "");
    if (
      trimmed.length >= 150 &&
      trimmed.length <= 155 &&
      trimmed.toLocaleLowerCase("en-GB").includes(keyword)
    )
      return trimmed;
  }
  return null;
}

function metaDescriptionLengthPlan(
  request: RevisionRequest,
  finding: RevisionFinding,
): PlannedRevisionFinding["replacement"] | null {
  const field = finding.location.field.replace(/^on_page\./, "");
  const source = request.current_document.meta_description;
  if (field !== "meta_description") return null;
  if (source.length > 155) {
    const target = shortenMetaDescription(source, request.handoff.primary_keyword);
    return target ? { kind: "field", field: "meta_description", source, target } : null;
  }
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
  exclusions: RevisionBindingExclusions,
): PlannedRevisionFinding["replacement"] | null {
  if (!["body_markdown", "markdown"].includes(finding.location.field)) return null;
  // No locationless fallback: an H2 is editable only once the shared binder has
  // supplied exact line authority. Picking the first H2 here would edit a
  // heading the binder had already refused as protected or duplicate-producing.
  const authorisedLine = finding.location.line_start;
  if (authorisedLine === undefined) return null;
  const correction = primaryKeywordH2Correction({
    markdown: request.current_document.markdown,
    line: authorisedLine,
    primaryKeyword: request.handoff.primary_keyword,
    exclusions,
  });
  if (!correction) return null;
  return {
    kind: "markdown",
    line_start: authorisedLine,
    line_end: authorisedLine,
    source: correction.source,
    target: correction.target,
    block_source: correction.source,
    block_target: correction.target,
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
/** Frozen readability authority persisted by an exceptional authorisation. */
export interface AuthorisedReadabilityAuthority {
  blocks: ReadonlyArray<{ line_start: number; line_end: number }>;
  selector_version?: string;
  target_set_identity?: string;
}

export function planRevisionRequest(
  request: RevisionRequest,
  options?: {
    exclusions?: RevisionBindingExclusions;
    /**
     * Present only for `operator_authorised_repair`. Execution then uses the
     * persisted ranges verbatim and fails closed on any drift, so authority can
     * never widen after the operator authorised it.
     */
    authorisedReadability?: Readonly<Record<string, AuthorisedReadabilityAuthority>>;
    /** One-pass normal-route readability authority from the binder. */
    readabilityBlocksByFinding?: Readonly<Record<string, readonly ReadabilityBlock[]>>;
  },
): PlannedRevisionFinding[] {
  // One frozen exclusion set for the H2 predicate and for readability block
  // selection, so the provider can never be shown a rejected paragraph.
  const frozenExclusions =
    options?.exclusions ?? revisionBindingExclusions({ document: request.current_document });
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
                ? primaryKeywordH2Plan(request, finding, frozenExclusions)
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
    if (finding.rule_reference === "style.readability_grade_8") {
      // A whole-document rule cannot be proved by one paragraph, so it
      // authorises a bounded set of exact blocks — or nothing at all.
      const supplied = options?.readabilityBlocksByFinding?.[finding.id];
      const reservedRanges = readabilityReservedRanges(request, finding, options);
      const selected = selectReadabilityBlocks({
        findingId: finding.id,
        markdown: request.current_document.markdown,
        exclusions: frozenExclusions,
        reservedRanges,
      });
      const computed = supplied ? supplied.map((block) => ({ ...block })) : selected;
      // The normal binder is the sole issuer of supplied blocks. Re-check the
      // complete set and each content-bearing field before a provider can see
      // it, so stale, duplicated, reordered or hand-crafted authority fails
      // closed rather than widening markdown scope.
      if (supplied && !sameReadabilityBlocks(computed, selected))
        return {
          finding,
          ordinal,
          route: "unable",
          reason:
            "The frozen readability block set is stale or inconsistent with the current document.",
        };
      const authorised = options?.authorisedReadability?.[finding.id];
      // An operator-authorised repair may only ever execute the authority the
      // operator confirmed. Recomputing it here would let authority widen after
      // authorisation, so a missing entry fails closed.
      if (!authorised && request.revision_source === "operator_authorised_repair")
        return {
          finding,
          ordinal,
          route: "unable",
          reason:
            "The exceptional authorisation recorded no readability authority for this blocker.",
        };
      if (
        computed.length > 0 &&
        (finding.location.line_start !== computed[0]!.line_start ||
          finding.location.line_end !== computed[0]!.line_end)
      )
        return {
          finding,
          ordinal,
          route: "unable",
          reason: "The primary readability location is outside the complete frozen block set.",
        };
      if (authorised) {
        const frozen = authorisedReadabilityBlocks(request, finding, authorised, computed);
        return frozen
          ? { finding, ordinal, route: "model", readability_blocks: frozen }
          : {
              finding,
              ordinal,
              route: "unable",
              reason:
                "The authorised readability blocks no longer match the exact persisted authority.",
            };
      }
      return computed.length > 0
        ? { finding, ordinal, route: "model", readability_blocks: computed }
        : {
            finding,
            ordinal,
            route: "unable",
            reason: "No safe eligible prose block remained for a bounded readability correction.",
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

/**
 * Rebuilds the readability blocks from the exact persisted authority.
 *
 * Returns null — and therefore an honest `unable` before any provider dispatch —
 * when the selector version has moved, the recorded identity disagrees with its
 * own ranges, or a freshly computed selection differs in any way (a stale
 * document, or a missing, extra, duplicate or reordered range). The blocks
 * themselves are built from the persisted ranges, never from the recomputed set.
 */
function authorisedReadabilityBlocks(
  request: RevisionRequest,
  finding: RevisionFinding,
  authorised: AuthorisedReadabilityAuthority,
  computed: readonly ReadabilityBlock[],
): ReadabilityBlock[] | null {
  if (authorised.selector_version !== READABILITY_SELECTOR_VERSION) return null;
  if (authorised.blocks.length === 0) return null;
  const persistedIdentity = authorised.blocks
    .map((block) => `${block.line_start}-${block.line_end}`)
    .join(",");
  if (authorised.target_set_identity && authorised.target_set_identity !== persistedIdentity)
    return null;
  if (persistedIdentity !== readabilityTargetSetIdentity(computed)) return null;
  if (
    finding.location.line_start !== authorised.blocks[0]?.line_start ||
    finding.location.line_end !== authorised.blocks[0]?.line_end
  )
    return null;
  const lines = request.current_document.markdown.split("\n");
  return authorised.blocks.map((block, index) => {
    const text = lines.slice(block.line_start - 1, block.line_end).join("\n");
    return {
      id: `${finding.id}::rb${index + 1}`,
      line_start: block.line_start,
      line_end: block.line_end,
      text,
      grade: calculateReadabilityGrade(text),
    };
  });
}

/** Exact markdown ranges other accepted findings already own. */
function reservedMarkdownRanges(
  request: RevisionRequest,
  self: RevisionFinding,
): Array<readonly [number, number]> {
  return request.accepted_findings.flatMap((finding) => {
    if (finding.id === self.id) return [];
    const { field, line_start: start, line_end: end } = finding.location;
    if (field !== "body_markdown" && field !== "markdown") return [];
    return start === undefined ? [] : [[start, end ?? start] as const];
  });
}

function readabilityReservedRanges(
  request: RevisionRequest,
  self: RevisionFinding,
  options:
    | {
        authorisedReadability?: Readonly<Record<string, AuthorisedReadabilityAuthority>>;
        readabilityBlocksByFinding?: Readonly<Record<string, readonly ReadabilityBlock[]>>;
      }
    | undefined,
): Array<readonly [number, number]> {
  const ranges = reservedMarkdownRanges(request, self);
  for (const finding of request.accepted_findings) {
    if (finding.id === self.id || finding.rule_reference !== "style.readability_grade_8") continue;
    const blocks =
      options?.readabilityBlocksByFinding?.[finding.id] ??
      options?.authorisedReadability?.[finding.id]?.blocks;
    if (blocks) ranges.push(...blocks.map((block) => [block.line_start, block.line_end] as const));
  }
  return ranges;
}

function sameReadabilityBlocks(
  actual: readonly ReadabilityBlock[],
  expected: readonly ReadabilityBlock[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((block, index) => {
      const target = expected[index];
      return Boolean(
        target &&
        block.id === target.id &&
        block.line_start === target.line_start &&
        block.line_end === target.line_end &&
        block.text === target.text &&
        block.grade === target.grade,
      );
    })
  );
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
      // A readability finding was expanded into one issued block per authorised
      // range, so collapse those rows back into the single audit the original
      // finding owns. Any missing block id fails closed.
      if (item.readability_blocks) {
        const rows = item.readability_blocks.map((block) => {
          const row = byId.get(block.id);
          if (!row) throw new Error("Model revision subset did not cover its findings in order");
          return row;
        });
        const applied = rows.filter((row) => row.status === "applied").length;
        return applied > 0
          ? {
              finding_id: item.finding.id,
              status: "applied" as const,
              reason: `Simplified ${applied} of ${rows.length} authorised readability blocks.`,
            }
          : {
              finding_id: item.finding.id,
              status: "unable" as const,
              reason: rows[0]?.reason ?? "No authorised readability block could be simplified.",
            };
      }
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

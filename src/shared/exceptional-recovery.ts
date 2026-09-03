import { z } from "zod";
import { FindingLocationSchema } from "./checker/index.js";
import type { StructuredDraft } from "./contracts/content.js";
import type { Handoff } from "./pipeline.js";
import type { InternalLink } from "./milestone-two.js";
import {
  READABILITY_SELECTOR_VERSION,
  bindLocationlessRule,
  readabilityTargetSetIdentity,
  planRevisionRequest,
  revisionBindingExclusions,
  selectReadabilityBlocks,
  type RevisionBindingExclusions,
} from "./revision-planning.js";

/**
 * One authorised blocker.
 *
 * `location` is the exact primary range. `readability_blocks` records every
 * additional exact range a multi-block readability correction may send to the
 * provider, so the immutable operator authorisation contains the complete
 * provider-visible authority rather than only its first block. `selector_version`
 * pins the selector that produced them, so execution can fail closed rather
 * than silently reinterpreting a stale set.
 */
export const ExceptionalBlockerBindingSchema = z
  .object({
    finding_id: z.string().min(1),
    location: FindingLocationSchema,
    readability_blocks: z
      .array(
        z
          .object({
            line_start: z.number().int().positive(),
            line_end: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
    selector_version: z.string().min(1).optional(),
    target_set_identity: z.string().min(1).optional(),
  })
  .strict();
export type ExceptionalBlockerBinding = z.infer<typeof ExceptionalBlockerBindingSchema>;

export interface ExceptionalCorrectionFinding {
  id: string;
  stable_key: string;
  category: string;
  rule_reference: string;
  severity: "blocker";
  location: z.infer<typeof FindingLocationSchema>;
  issue: string;
  evidence?: string;
  suggested_fix: string;
}

const markdownField = (field: string) => field === "body_markdown" || field === "markdown";
const normaliseSection = (value: string) =>
  value.trim().toLocaleLowerCase("en-GB").replace(/\s+/gu, " ");

function locationExcluded(
  location: z.infer<typeof FindingLocationSchema>,
  exclusions: RevisionBindingExclusions,
): boolean {
  if (!markdownField(location.field)) return false;
  if (location.section && exclusions.sections?.has(normaliseSection(location.section))) return true;
  const start = location.line_start;
  if (start === undefined) return false;
  const end = location.line_end ?? start;
  return Boolean(exclusions.lines?.some(([from, to]) => start <= to && end >= from));
}

/** One shared projection of exact exceptional authority and its revision-policy route. */
export function previewExceptionalCorrection(input: {
  draft: StructuredDraft;
  handoff: Handoff;
  documentVersionId: string;
  findings: ExceptionalCorrectionFinding[];
  exclusions: RevisionBindingExclusions;
  internalLinks?: InternalLink[];
}): { bindings: ExceptionalBlockerBinding[]; requires_ai: boolean } | null {
  const bindings = bindExceptionalBlockers(
    input.draft,
    input.handoff.primary_keyword,
    input.findings,
    input.exclusions,
  );
  if (!bindings) return null;
  const byId = new Map(bindings.map((binding) => [binding.finding_id, binding]));
  const accepted = input.findings.map((finding) => ({
    ...finding,
    location: byId.get(finding.id)!.location,
    disposition: "accepted" as const,
    origin_document_version_id: input.documentVersionId,
  }));
  const authorisedReadability = Object.fromEntries(
    bindings.flatMap((binding) =>
      binding.readability_blocks
        ? [
            [
              binding.finding_id,
              {
                blocks: binding.readability_blocks,
                ...(binding.selector_version ? { selector_version: binding.selector_version } : {}),
                ...(binding.target_set_identity
                  ? { target_set_identity: binding.target_set_identity }
                  : {}),
              },
            ],
          ]
        : [],
    ),
  );
  const plan = planRevisionRequest(
    {
      operation_id: "exceptional-correction-preview",
      run_id: "exceptional-correction-preview",
      document_version_id: input.documentVersionId,
      revision: 1,
      handoff: input.handoff,
      current_document: input.draft,
      ...(input.internalLinks ? { internal_links: input.internalLinks } : {}),
      accepted_findings: accepted,
      revision_source: "operator_authorised_repair",
      reference_snapshots: [],
      prompt: { template_id: "mobelaris.revision_pass", template_version: "preview" },
      model: "preview",
      temperature: 0,
    },
    { exclusions: input.exclusions, authorisedReadability },
  );
  // Availability means every frozen blocker has an executable correction
  // route. An `unable` plan would otherwise expose an action guaranteed to
  // preserve at least one blocker.
  if (plan.some((item) => item.route === "unable")) return null;
  return { bindings, requires_ai: plan.some((item) => item.route === "model") };
}

/**
 * Derives exact edit authority for the persisted Step 1.11 blockers that one
 * operator-authorised correction will target.
 *
 * Locationless findings are bound only through the shared rule-specific
 * binding that the normal Step 1.10 route uses, so both routes authorise
 * identical locations and neither can bind arbitrary prose to a structural
 * rule. A blocker with no safe binding makes the whole exceptional correction
 * unavailable rather than authorising an edit that cannot resolve it.
 */
export function bindExceptionalBlockers(
  draft: StructuredDraft,
  primaryKeyword: string,
  findings: Array<{
    id: string;
    rule_reference: string;
    location: z.infer<typeof FindingLocationSchema>;
  }>,
  exclusionsInput?: RevisionBindingExclusions,
): ExceptionalBlockerBinding[] | null {
  const exclusions = exclusionsInput ?? revisionBindingExclusions({ document: draft });
  // Explicit ranges are reserved before any locationless rule is bound. Once a
  // readability set is selected, reserve every block before selecting the next
  // readability finding so exceptional and normal routes cannot share authority.
  const reserved: Array<readonly [number, number]> = findings.flatMap((finding) =>
    markdownField(finding.location.field) && finding.location.line_start !== undefined
      ? [
          [
            finding.location.line_start,
            finding.location.line_end ?? finding.location.line_start,
          ] as const,
        ]
      : [],
  );
  const lines = draft.markdown.split("\n");
  const sectionAt = (line: number): string | undefined => {
    let section: string | undefined;
    for (let index = 0; index < line - 1; index += 1) {
      const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index]!);
      if (match) section = match[1]!.trim();
    }
    return section;
  };
  const bindings: ExceptionalBlockerBinding[] = [];
  for (const finding of findings) {
    if (!markdownField(finding.location.field) || finding.location.line_start !== undefined) {
      if (locationExcluded(finding.location, exclusions)) return null;
      bindings.push({ finding_id: finding.id, location: finding.location });
      continue;
    }
    if (finding.rule_reference === "style.readability_grade_8") {
      const blocks = selectReadabilityBlocks({
        findingId: finding.id,
        markdown: draft.markdown,
        exclusions,
        reservedRanges: reserved,
      });
      const first = blocks[0];
      // The complete set, including its primary, must be proven before the
      // exceptional authorisation is persisted; an empty set is not authority.
      if (!first) return null;
      const section = sectionAt(first.line_start);
      bindings.push({
        finding_id: finding.id,
        location: {
          ...finding.location,
          field: "body_markdown",
          line_start: first.line_start,
          line_end: first.line_end,
          ...(section ? { section } : {}),
        },
        readability_blocks: blocks.map((block) => ({
          line_start: block.line_start,
          line_end: block.line_end,
        })),
        selector_version: READABILITY_SELECTOR_VERSION,
        target_set_identity: readabilityTargetSetIdentity(blocks),
      });
      reserved.push(...blocks.map((block) => [block.line_start, block.line_end] as const));
      continue;
    }
    const bound = bindLocationlessRule({
      rule: finding.rule_reference,
      markdown: draft.markdown,
      primaryKeyword,
      exclusions,
      reservedRanges: reserved,
    });
    if (!bound) return null;
    bindings.push({ finding_id: finding.id, location: { ...finding.location, ...bound } });
    if (markdownField(bound.field)) reserved.push([bound.line_start, bound.line_end]);
  }
  return bindings;
}

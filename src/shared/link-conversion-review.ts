import { z } from "zod";
import { InternalLinkHierarchySchema } from "./checker/contracts.js";
import { parseMarkdown } from "./checker/markdown.js";
import { canonicaliseInternalUrl } from "./internal-link-url.js";
import {
  INTERNAL_LINK_HIERARCHY_RANK,
  classifyInternalLinkHierarchy,
} from "./internal-link-hierarchy.js";
import type { ReviewFinding } from "./milestone-three.js";
import { InternalLinkSchema, type InternalLink, type StructuredDraft } from "./milestone-two.js";

const text = z.string().trim().min(1);

export const LinkVerificationOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("direct_200"),
      method: z.enum(["head", "get"]),
      verified_at: z.string().datetime(),
      hierarchy: InternalLinkHierarchySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("confirmed_non_200"),
      method: z.enum(["head", "get"]),
      status: z
        .number()
        .int()
        .min(100)
        .max(599)
        .refine((status) => status !== 200 && (status < 300 || status >= 400), {
          message: "confirmed_non_200 excludes HTTP 200 and redirects",
        }),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("redirect"),
      method: z.enum(["head", "get"]),
      status: z.number().int().min(300).max(399),
      location: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unresolved_transport"),
      reason: z.enum(["no_network", "timeout", "dns", "network", "unsafe", "unknown"]),
    })
    .strict(),
]);
export type LinkVerificationOutcome = z.infer<typeof LinkVerificationOutcomeSchema>;

export interface DraftLinkVerifier {
  verify(url: string): Promise<LinkVerificationOutcome>;
}

export const LinkReviewOccurrenceSchema = z
  .object({
    anchor: text,
    url: z.string().url(),
    location: z
      .object({
        field: z.literal("body_markdown"),
        line_start: z.number().int().positive(),
        section: text.optional(),
      })
      .strict(),
    context: text,
  })
  .strict();

export const LinkReviewShortlistItemSchema = z
  .object({
    title: text,
    url: z.string().url(),
    hierarchy: InternalLinkHierarchySchema.optional(),
    hierarchy_rank: z.number().int().min(1).max(6).optional(),
    relevance: z.number().min(0).max(1),
  })
  .strict();

export const LinkReviewContextSchema = z
  .object({
    occurrences: z.array(LinkReviewOccurrenceSchema),
    shortlist: z.array(LinkReviewShortlistItemSchema),
  })
  .strict();
export type LinkReviewContext = z.infer<typeof LinkReviewContextSchema>;

export interface LinkAuditInput {
  draft: StructuredDraft;
  shortlist: InternalLink[];
  internal_origins: string[];
}

export { classifyInternalLinkHierarchy } from "./internal-link-hierarchy.js";

function key(rule: string, subject: string): string {
  let hash = 2166136261;
  for (const char of `${rule}|${subject}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `link:${rule.replace(/^link\./, "")}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function finding(
  rule: string,
  subject: string,
  issue: string,
  suggested_fix: string,
  location: ReviewFinding["location"],
  severity: ReviewFinding["severity"] = "blocker",
): ReviewFinding {
  return {
    stable_key: key(rule, subject),
    category: "link_conversion",
    rule_reference: rule,
    severity,
    location,
    issue,
    suggested_fix,
  };
}

/**
 * Deterministic Step 1.8 audit. Membership is established before the verifier is
 * called, so an injected verifier can never receive an external or off-shortlist URL.
 */
export async function auditDraftLinks(
  input: LinkAuditInput,
  verifier: DraftLinkVerifier,
): Promise<{ findings: ReviewFinding[]; review_context: LinkReviewContext }> {
  const parsed = parseMarkdown(input.draft.markdown);
  const origins = [...new Set(input.internal_origins.map((value) => new URL(value).origin))];
  const shortlist = new Map<string, InternalLink>();
  for (const raw of input.shortlist) {
    const canonical = canonicaliseInternalUrl(raw.url, origins);
    if (canonical && !shortlist.has(canonical))
      shortlist.set(canonical, InternalLinkSchema.parse(raw));
  }
  const occurrences = parsed.links.flatMap((link) => {
    const canonical = canonicaliseInternalUrl(link.url, origins);
    if (!canonical) return [];
    const block = parsed.blocks.find(
      (candidate) =>
        candidate.semantic_key && link.semantic_key?.startsWith(candidate.semantic_key),
    );
    return [
      {
        canonical,
        model: LinkReviewOccurrenceSchema.parse({
          anchor: link.text,
          url: canonical,
          location: {
            field: "body_markdown",
            line_start: link.line,
            ...(link.section ? { section: link.section } : {}),
          },
          context: block?.text ?? link.text,
        }),
      },
    ];
  });
  const findings: ReviewFinding[] = [];
  const rejectedTargets = new Set<string>();
  const approvedTargets = new Map<string, (typeof occurrences)[number]>();
  for (const occurrence of occurrences) {
    if (!shortlist.has(occurrence.canonical)) {
      if (!rejectedTargets.has(occurrence.canonical)) {
        rejectedTargets.add(occurrence.canonical);
        findings.push(
          finding(
            "link.shortlist_membership",
            occurrence.canonical,
            `Internal link target “${occurrence.canonical}” is absent from the run shortlist.`,
            "Remove the link or replace it with a contextually suitable shortlist target.",
            occurrence.model.location,
          ),
        );
      }
      continue;
    }
    if (!approvedTargets.has(occurrence.canonical))
      approvedTargets.set(occurrence.canonical, occurrence);
  }
  for (const [url, occurrence] of approvedTargets) {
    let outcome: LinkVerificationOutcome;
    try {
      outcome = LinkVerificationOutcomeSchema.parse(await verifier.verify(url));
    } catch {
      outcome = { outcome: "unresolved_transport", reason: "unknown" };
    }
    if (outcome.outcome === "redirect")
      findings.push(
        finding(
          "link.target_redirect",
          url,
          `Internal link target “${url}” redirects instead of returning a direct HTTP 200.`,
          "Replace it with a direct, contextually suitable shortlist target.",
          occurrence.model.location,
        ),
      );
    else if (outcome.outcome === "confirmed_non_200")
      findings.push(
        finding(
          "link.target_status",
          url,
          `Internal link target “${url}” returned HTTP ${outcome.status}, not 200.`,
          "Remove it or replace it with a direct status-200 shortlist target.",
          occurrence.model.location,
        ),
      );
    else if (outcome.outcome === "unresolved_transport")
      findings.push(
        finding(
          "link.target_unresolved",
          url,
          `Internal link target “${url}” could not be verified (${outcome.reason}).`,
          "Retry verification or replace the link; do not treat an unresolved target as valid.",
          occurrence.model.location,
          "warning",
        ),
      );
    else {
      const entry = shortlist.get(url)!;
      const classified = classifyInternalLinkHierarchy(url);
      if (!classified) {
        findings.push(
          finding(
            "link.hierarchy_classification",
            url,
            `Hierarchy metadata for “${url}” could not be classified safely.`,
            "Correct the malformed target before relying on hierarchy priority.",
            occurrence.model.location,
            "warning",
          ),
        );
        continue;
      }
      const expectedRank = INTERNAL_LINK_HIERARCHY_RANK[classified];
      if (
        outcome.hierarchy !== classified ||
        entry.hierarchy !== classified ||
        entry.hierarchy_rank !== expectedRank
      )
        findings.push(
          finding(
            "link.hierarchy_classification",
            url,
            `Hierarchy metadata for “${url}” does not match ${classified} at rank ${expectedRank}.`,
            "Correct the shortlist hierarchy metadata before relying on hierarchy priority.",
            occurrence.model.location,
            "warning",
          ),
        );
    }
  }
  return {
    findings,
    review_context: LinkReviewContextSchema.parse({
      occurrences: occurrences.map((item) => item.model),
      shortlist: [...shortlist.values()].map((item) => ({
        title: item.title,
        url: canonicaliseInternalUrl(item.url, origins)!,
        ...(item.hierarchy ? { hierarchy: item.hierarchy } : {}),
        ...(item.hierarchy_rank ? { hierarchy_rank: item.hierarchy_rank } : {}),
        relevance: item.relevance,
      })),
    }),
  };
}

export class NoNetworkDraftLinkVerifier implements DraftLinkVerifier {
  async verify(): Promise<LinkVerificationOutcome> {
    return { outcome: "unresolved_transport", reason: "no_network" };
  }
}

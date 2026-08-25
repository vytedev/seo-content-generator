import { z } from "zod";
import { FindingLocationSchema } from "./checker/index.js";
import type { StructuredDraft } from "./contracts/content.js";

export const ExceptionalBlockerBindingSchema = z
  .object({ finding_id: z.string().min(1), location: FindingLocationSchema })
  .strict();
export type ExceptionalBlockerBinding = z.infer<typeof ExceptionalBlockerBindingSchema>;

/** Derives one bounded, deterministic prose block when an older global checker finding had only field authority. */
export function bindExceptionalBlockers(
  draft: StructuredDraft,
  findings: Array<{
    id: string;
    rule_reference: string;
    location: z.infer<typeof FindingLocationSchema>;
  }>,
): ExceptionalBlockerBinding[] | null {
  const lines = draft.markdown.split("\n");
  const firstH2Line = lines.findIndex((line) => /^##\s+\S/.test(line)) + 1;
  const paragraphs: Array<{ start: number; end: number; words: number; section: string | null }> =
    [];
  let section: string | null = null;
  for (let index = 0; index < lines.length;) {
    const heading = /^#{1,6}\s+(.+)$/.exec(lines[index]!);
    if (heading) {
      section = heading[1]!.trim();
      index += 1;
      continue;
    }
    if (!lines[index]!.trim() || /^\s*(?:[-*>]|\d+[.)]\s+)/.test(lines[index]!)) {
      index += 1;
      continue;
    }
    const start = index + 1;
    let words = 0;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^#{1,6}\s+/.test(lines[index]!) &&
      !/^\s*(?:[-*>]|\d+[.)]\s+)/.test(lines[index]!)
    ) {
      words += lines[index]!.trim().split(/\s+/).length;
      index += 1;
    }
    paragraphs.push({ start, end: index, words, section });
  }
  const allowed = paragraphs.filter(
    (item) =>
      item.section &&
      !["conclusion", "key takeaways", "faq", "faqs"].includes(
        item.section.toLocaleLowerCase("en-GB"),
      ),
  );
  return findings.flatMap((finding) => {
    if (!["body_markdown", "markdown"].includes(finding.location.field))
      return [{ finding_id: finding.id, location: finding.location }];
    if (finding.location.line_start !== undefined)
      return [{ finding_id: finding.id, location: finding.location }];
    if (finding.rule_reference === "keyword.primary.h2")
      return firstH2Line > 0
        ? [
            {
              finding_id: finding.id,
              location: {
                field: "body_markdown" as const,
                line_start: firstH2Line,
                line_end: firstH2Line,
              },
            },
          ]
        : [];
    const target =
      finding.rule_reference === "style.readability_grade_8"
        ? [...allowed].sort((a, b) => b.words - a.words || a.start - b.start)[0]
        : allowed[0];
    return target
      ? [
          {
            finding_id: finding.id,
            location: {
              field: "body_markdown" as const,
              line_start: target.start,
              line_end: target.end,
              ...(target.section ? { section: target.section } : {}),
            },
          },
        ]
      : [];
  }).length === findings.length
    ? findings.map((finding) => {
        if (!["body_markdown", "markdown"].includes(finding.location.field))
          return { finding_id: finding.id, location: finding.location };
        if (finding.location.line_start !== undefined)
          return { finding_id: finding.id, location: finding.location };
        if (finding.rule_reference === "keyword.primary.h2")
          return {
            finding_id: finding.id,
            location: {
              field: "body_markdown" as const,
              line_start: firstH2Line,
              line_end: firstH2Line,
            },
          };
        const target =
          finding.rule_reference === "style.readability_grade_8"
            ? [...allowed].sort((a, b) => b.words - a.words || a.start - b.start)[0]!
            : allowed[0]!;
        return {
          finding_id: finding.id,
          location: {
            field: "body_markdown" as const,
            line_start: target.start,
            line_end: target.end,
            ...(target.section ? { section: target.section } : {}),
          },
        };
      })
    : null;
}

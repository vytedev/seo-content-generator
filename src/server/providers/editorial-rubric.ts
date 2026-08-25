export const DETERMINISTIC_EDITORIAL_RUBRIC = [
  "The title/meta title must be 55–60 characters and contain the exact primary keyword.",
  "The meta description must be 150–155 characters.",
  "The Markdown must contain exactly one H1 and it must contain the exact primary keyword.",
  "The first prose paragraph immediately after the H1 must be a 40–70 word direct answer and must contain the exact primary keyword within the first 100 body words.",
  "Include an H2 whose text contains the exact primary keyword.",
  'Include an exact "## Key Takeaways" section with 3–5 unordered Markdown bullets.',
  'Include 1–3 Markdown blockquote callouts whose lines begin with "> ".',
  'Include an exact "## Conclusion" section which states the bottom line first.',
  "Provide 3–6 structured FAQ items, each with a 40–80 word answer.",
  "Use every exact related keyword naturally in prose beneath a relevant heading.",
  "Use only internal URLs from the supplied shortlist. Include at least one shortlisted commercial link in an ordinary body paragraph, outside Conclusion, Key Takeaways, FAQs and blockquotes.",
  "Keep the prose at Flesch-Kincaid Grade 8 or below: prefer short sentences, common words and compact paragraphs.",
  "Populate the title, slug, meta description, Open Graph title and description, images, FAQs, Markdown and claims fields.",
] as const;

export function formatDeterministicEditorialRubric(): string {
  return DETERMINISTIC_EDITORIAL_RUBRIC.map((rule, index) => `${index + 1}. ${rule}`).join("\n");
}

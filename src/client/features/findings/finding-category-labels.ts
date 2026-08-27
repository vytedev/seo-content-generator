export const findingCategories = [
  "content",
  "definition",
  "deterministic",
  "fact_advisory",
  "fact_advisory_unavailable",
  "fact_checking",
  "grammar",
  "information_gain",
  "information_gain_advisory_unavailable",
  "link_conversion",
  "on_page_metadata",
  "provenance",
  "style",
  "style_advisory_unavailable",
  "writing_style",
] as const;

export type FindingCategory = (typeof findingCategories)[number];

export const findingCategoryLabels = {
  content: "Content",
  definition: "Definition",
  deterministic: "Deterministic",
  fact_advisory: "Fact advisory",
  fact_advisory_unavailable: "Fact advisory unavailable",
  fact_checking: "Fact checking",
  grammar: "Grammar",
  information_gain: "Information gain",
  information_gain_advisory_unavailable: "Information gain advisory unavailable",
  link_conversion: "Link and conversion",
  on_page_metadata: "On-page metadata",
  provenance: "Provenance",
  style: "Style",
  style_advisory_unavailable: "Style advisory unavailable",
  writing_style: "Writing style",
} as const satisfies Record<FindingCategory, string>;

export function isFindingCategory(value: string): value is FindingCategory {
  return Object.hasOwn(findingCategoryLabels, value);
}

export function findingCategoryLabel(value: FindingCategory): string {
  return findingCategoryLabels[value];
}

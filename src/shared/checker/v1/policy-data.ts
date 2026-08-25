/** Immutable policy data used by the frozen v1 checker and inventory. */
export const PROVISIONAL_US_TO_UK_WORD_MAP_V1 = {
  color: "colour",
  favorite: "favourite",
  center: "centre",
  organize: "organise",
  organization: "organisation",
  recognize: "recognise",
  optimize: "optimise",
  behavior: "behaviour",
} as const;

export const PROVISIONAL_VAGUE_HEADINGS_V1 = [
  "introduction",
  "overview",
  "things to consider",
  "more information",
  "final thoughts",
] as const;

export const PROVISIONAL_BANNED_PHRASES_V1 = ["always", "never", "guaranteed"] as const;

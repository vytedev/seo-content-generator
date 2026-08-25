/**
 * Editorial values approved for the deterministic checker. Keep policy values
 * separate from rule execution so they can move to versioned reference data
 * without changing the detection algorithm.
 */
export const REPEATED_ADJECTIVE_POLICY = {
  occurrencesPerThousandWords: 4,
  minimumOccurrences: 4,
  severity: "warning" as const,
  // Conservative high-confidence descriptors. Suffix matching below extends
  // coverage without treating every repeated word as an adjective.
  adjectives: [
    "beautiful",
    "classic",
    "comfortable",
    "compact",
    "contemporary",
    "elegant",
    "excellent",
    "exceptional",
    "flexible",
    "functional",
    "ideal",
    "innovative",
    "modern",
    "perfect",
    "practical",
    "premium",
    "simple",
    "stylish",
    "suitable",
    "timeless",
    "unique",
    "versatile",
  ],
  adjectiveSuffixes: [
    "able",
    "ible",
    "al",
    "ant",
    "ary",
    "ent",
    "ful",
    "ic",
    "ive",
    "less",
    "ory",
    "ous",
  ],
} as const;

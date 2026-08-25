import { RULE_INVENTORY_V1 } from "../v1/inventory.js";

/**
 * Deterministic checker v2 inventory: every frozen v1 rule plus the two new
 * editorial-integrity blockers. v1 is never edited — a behavioural change to the
 * deterministic rule set requires a new version, so v2 is additive and v1 keeps
 * its historical fingerprints for every already-frozen manifest.
 */
export const RULE_INVENTORY_V2_ADDITIONS = [
  {
    id: "on_page.title.complete",
    applicability: "always",
    parameters: {
      fields: ["meta_title", "og_title"],
      forbidden_final_connectors: [
        "for",
        "and",
        "or",
        "with",
        "to",
        "of",
        "in",
        "on",
        "a",
        "an",
        "the",
      ],
      severity: "blocker",
    },
  },
  {
    id: "structure.faq_pair_alignment",
    applicability: "when_two_to_six_faqs_exist",
    parameters: { method: "strong_alternative_permutation_signal_v1", severity: "blocker" },
  },
] as const;

export const RULE_INVENTORY_V2 = [...RULE_INVENTORY_V1, ...RULE_INVENTORY_V2_ADDITIONS] as const;

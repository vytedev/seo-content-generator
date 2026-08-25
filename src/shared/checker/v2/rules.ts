import { CheckerInputSchema, type CheckerInput, type Finding } from "../contracts.js";
import { hasDanglingTitleEnding, suspiciousFaqPairIndexes } from "../../editorial-integrity.js";
import {
  finding,
  runDeterministicChecksV1,
  type CheckerRunV1,
  type RuleEvaluationV1,
} from "../v1/rules.js";
import { RULE_INVENTORY_V2_ADDITIONS } from "./inventory.js";

/**
 * Deterministic checker v2: frozen v1 composed with two additive editorial
 * blockers. v1 is executed unchanged rather than forked, so its historical
 * behaviour cannot drift, and the new findings are appended in a fixed order.
 *
 * Both additions produce one finding per distinct subject (each title field,
 * each FAQ index), so every semantic occurrence is 1 and no v1 occurrence
 * counter state is needed.
 */
export function runDeterministicChecksV2(rawInput: CheckerInput): CheckerRunV1 {
  const input = CheckerInputSchema.parse(rawInput);
  const base = runDeterministicChecksV1(input);
  const additional: Finding[] = [];

  for (const [field, value] of [
    ["meta_title", input.on_page.meta_title],
    ["og_title", input.on_page.og_title],
  ] as const)
    if (hasDanglingTitleEnding(value))
      additional.push(
        finding({
          rule: "on_page.title.complete",
          field: `on_page.${field}`,
          issue: `${field.replaceAll("_", " ")} ends with a dangling connector or preposition.`,
          suggested_fix:
            "Complete the title at the editorial boundary; never truncate it during export.",
        }),
      );

  const faqCount = input.on_page.faqs.length;
  const faqApplicable = faqCount >= 2 && faqCount <= 6;
  if (faqApplicable)
    for (const index of suspiciousFaqPairIndexes(input.on_page.faqs, input.primary_keyword))
      additional.push(
        finding({
          rule: "structure.faq_pair_alignment",
          field: `on_page.faqs.${index}.answer`,
          semantic_location_key: `on_page.faqs.${index}`,
          subject_key: `faq-${index}`,
          issue: `FAQ ${index + 1} has a strong alternative-answer permutation signal.`,
          suggested_fix:
            "Correct the question-and-answer pair as one object; do not rotate answers.",
        }),
      );

  // Coverage must be exactly the v2 inventory: v1's evaluations plus one entry
  // per addition, carrying an explicit reason whenever an addition is skipped.
  const additionalEvaluations: RuleEvaluationV1[] = RULE_INVENTORY_V2_ADDITIONS.map((rule) =>
    rule.id === "structure.faq_pair_alignment" && !faqApplicable
      ? { rule_id: rule.id, status: "skipped", reason: "faq_count_outside_two_to_six" }
      : { rule_id: rule.id, status: "evaluated" },
  );

  return {
    findings: [...base.findings, ...additional],
    evaluations: [...base.evaluations, ...additionalEvaluations],
  };
}

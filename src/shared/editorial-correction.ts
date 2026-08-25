import { CHECKER_REGISTRY, CURRENT_CHECKER_VERSION } from "./checker/registry.js";
import type { CheckerInput, Finding } from "./checker/contracts.js";
import type { DeterministicManifest } from "./deterministic-run.js";
import { PersistedReviewFindingSchema, type PersistedReviewFinding } from "./milestone-three.js";

/**
 * A controlled editorial correction for a run whose deterministic baseline was
 * frozen under an earlier checker version.
 *
 * The frozen manifest is never rewritten and the frozen document version is
 * never mutated. The current checker is evaluated against the existing frozen
 * draft purely to discover rules that did not exist when the baseline was
 * taken; only those newly applicable findings are raised, so the operator sees
 * exactly the new editorial blockers and nothing already dispositioned. Every
 * correction then flows through the ordinary findings review and controlled
 * revision, which produces the new immutable child version.
 */
export interface EditorialCorrectionPlan {
  /** Checker version used for the correction check; the manifest keeps its own. */
  readonly checker_version: string;
  /** Rule ids present in the current checker but absent from the frozen baseline. */
  readonly newly_applicable_rule_ids: readonly string[];
  /** Findings raised only by those newly applicable rules. */
  readonly findings: readonly PersistedReviewFinding[];
}

export const EDITORIAL_CORRECTION_STABLE_KEY_PREFIX = "editorial-correction:";

/**
 * Stable across repeated invocations for the same rule and location, so a
 * repeated correction cannot duplicate a finding.
 */
export function editorialCorrectionStableKey(finding: Finding): string {
  return `${EDITORIAL_CORRECTION_STABLE_KEY_PREFIX}${finding.id}`;
}

export function planEditorialCorrection(input: {
  manifest: DeterministicManifest;
  checkerInput: CheckerInput;
}): EditorialCorrectionPlan {
  const checker = CHECKER_REGISTRY[CURRENT_CHECKER_VERSION];
  if (!checker) throw new Error("The current deterministic checker is not registered");
  // Rules the frozen baseline actually evaluated. Anything outside this set did
  // not exist for that run, so raising it now is new information rather than a
  // re-litigation of an already-dispositioned finding.
  const evaluated = new Set(input.manifest.rule_inventory.map((rule) => rule.id));
  const newlyApplicable = checker.inventory
    .map((rule) => rule.id)
    .filter((id) => !evaluated.has(id));
  const applicable = new Set(newlyApplicable);
  const findings = checker
    .run(input.checkerInput)
    .findings.filter((finding) => applicable.has(finding.rule))
    .map((finding) =>
      PersistedReviewFindingSchema.parse({
        stable_key: editorialCorrectionStableKey(finding),
        category: "deterministic",
        rule_reference: finding.rule,
        severity: finding.severity,
        location: finding.location,
        issue: finding.issue,
        suggested_fix: finding.suggested_fix,
        hard_flag: false,
      }),
    );
  return {
    checker_version: CURRENT_CHECKER_VERSION,
    newly_applicable_rule_ids: newlyApplicable,
    findings,
  };
}

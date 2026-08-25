import type { CheckerInput, Finding } from "./contracts.js";
import { RULE_INVENTORY_V1 } from "./v1/inventory.js";
import { runDeterministicChecksV1, type RuleEvaluationV1 } from "./v1/rules.js";
import { RULE_INVENTORY_V2 } from "./v2/inventory.js";
import { runDeterministicChecksV2 } from "./v2/rules.js";

export interface RegisteredChecker {
  readonly inventory: readonly { readonly id: string }[];
  run(input: CheckerInput): { findings: Finding[]; evaluations: RuleEvaluationV1[] };
}

/** Historical versions stay registered so already-frozen manifests keep validating. */
export const CHECKER_VERSION_V1 = "1.0.0" as const;
export const CHECKER_VERSION_V2 = "2.0.0" as const;
/** The version new runs are created with. */
export const CURRENT_CHECKER_VERSION = CHECKER_VERSION_V2;
export const CHECKER_REGISTRY: Readonly<Record<string, RegisteredChecker>> = Object.freeze({
  [CHECKER_VERSION_V1]: Object.freeze({
    inventory: RULE_INVENTORY_V1,
    run: runDeterministicChecksV1,
  }),
  [CHECKER_VERSION_V2]: Object.freeze({
    inventory: RULE_INVENTORY_V2,
    run: runDeterministicChecksV2,
  }),
});

export const CURRENT_CHECKER = CHECKER_REGISTRY[CURRENT_CHECKER_VERSION]!;

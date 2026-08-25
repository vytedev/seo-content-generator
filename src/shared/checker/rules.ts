import type { CheckerInput, Finding } from "./contracts.js";
import {
  calculateReadabilityGrade,
  PROVISIONAL_BANNED_PHRASES,
  PROVISIONAL_US_TO_UK_WORD_MAP,
  PROVISIONAL_VAGUE_HEADINGS,
} from "./v1/rules.js";
import { CURRENT_CHECKER } from "./registry.js";

export {
  calculateReadabilityGrade,
  PROVISIONAL_BANNED_PHRASES,
  PROVISIONAL_US_TO_UK_WORD_MAP,
  PROVISIONAL_VAGUE_HEADINGS,
};

/** Public current checker delegates to the registered frozen v1 executable. */
export function runDeterministicChecks(input: CheckerInput): Finding[] {
  return CURRENT_CHECKER.run(input).findings;
}

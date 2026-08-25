import type { RunDetail } from "../../../shared/contracts/run-detail.js";

/** The four operator-facing states of the Blog Post page. */
export type BlogPostPhase = "start" | "running" | "needs-decision" | "done";

/**
 * Derives the Blog Post page state from the run's server-side status — never
 * from where the operator clicked.
 *
 * - `waiting` is only set by the pipeline when a run parks at step 1.9
 *   (findings review), so it maps to the decision state.
 * - `succeeded` and `cancelled` are terminal; the page shows the finished
 *   result with its export link.
 * - Everything else (`queued`, `running`, `retryable_failed` and `blocked`,
 *   which renders the operator-action banner inside the progress view) is
 *   still "the pipeline working", so it maps to the running state.
 */
export function phaseFromRunStatus(status: RunDetail["status"]): BlogPostPhase {
  switch (status) {
    case "waiting":
      return "needs-decision";
    case "succeeded":
    case "cancelled":
      return "done";
    default:
      return "running";
  }
}

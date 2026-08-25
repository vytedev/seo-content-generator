import { RunDetailSchema, type RunDetail } from "../../shared/contracts/run-detail.js";

const MILESTONE_TWO_STEPS = new Set(["internal_link_discovery", "draft"]);
const MILESTONE_THREE_STEPS = new Set([
  "automated_checks",
  "review_writing_style",
  "review_information_gain",
  "review_fact_checking",
  "review_link_conversion",
]);

/**
 * Steps 1.2–1.3 resume through milestone two, 1.4–1.8 through milestone
 * three. `findings_review` (1.9) is deliberately excluded from milestone
 * three: once the operator has submitted dispositions, continuing means
 * advancing into the milestone-four revision pass, not re-running the wait.
 */
export function resumeEndpoint(runId: string, currentStep: string | null): string {
  const id = encodeURIComponent(runId);
  const step = currentStep ?? "";
  if (MILESTONE_TWO_STEPS.has(step)) return `/api/runs/${id}/milestone-two/resume`;
  if (MILESTONE_THREE_STEPS.has(step)) return `/api/runs/${id}/milestone-three/resume`;
  return `/api/runs/${id}/milestone-four/resume`;
}

export function resumeRequest(currentStep: string | null): RequestInit {
  if (currentStep !== "internal_link_discovery") return { method: "POST" };
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_link_discovery: true }),
  };
}

export function runDetailErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return fallback;
}

export function parseRunDetailResponse(
  body: unknown,
  responseOk: boolean,
  fallback: string,
): RunDetail {
  if (!responseOk) throw new Error(runDetailErrorMessage(body, fallback));
  return RunDetailSchema.parse(body);
}

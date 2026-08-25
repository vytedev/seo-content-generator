import {
  PIPELINE_STEPS,
  type PipelineStepId,
  type RunStatus,
  type StepStatus,
} from "./pipeline.js";

export const MAX_COHERENCE_RETURN_CYCLES = 2 as const;

export interface WorkflowState {
  readonly run_status: RunStatus;
  readonly current_step: PipelineStepId;
  readonly step_status: StepStatus;
  readonly attempt_number: number;
  readonly coherence_return_cycles: number;
}

export type WorkflowEvent =
  | { readonly type: "start" }
  | { readonly type: "complete_step" }
  | { readonly type: "findings_ready" }
  | { readonly type: "approve_findings" }
  | { readonly type: "coherence_blocker" }
  | { readonly type: "retry" }
  | { readonly type: "fail_retryable" }
  | { readonly type: "block" }
  | { readonly type: "cancel" };

const NEXT_STEP: Readonly<Partial<Record<PipelineStepId, PipelineStepId>>> = Object.fromEntries(
  PIPELINE_STEPS.slice(0, -1).map((step, index) => [step.id, PIPELINE_STEPS[index + 1]?.id]),
) as Partial<Record<PipelineStepId, PipelineStepId>>;

/**
 * The sole public authority for legal workflow transitions.
 *
 * Database leases wrap an attempt before its handler runs; this reducer records
 * the durable business state after lease acquisition. Moving to another step
 * always starts attempt 1. Retrying the same step increments its attempt.
 */
export function transitionWorkflow(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  validateState(state);

  switch (event.type) {
    case "start":
      requireState(state, "queued", "ingest_handoff", "queued");
      if (state.attempt_number !== 0) {
        throw new TransitionError("A queued run must not have an existing attempt");
      }
      return { ...state, run_status: "running", step_status: "running", attempt_number: 1 };

    case "complete_step": {
      requireActive(state);
      if (state.current_step === "findings_review") {
        throw new TransitionError("Findings review must enter the operator wait");
      }
      if (state.current_step === "final_coherence_export") {
        return { ...state, run_status: "succeeded", step_status: "succeeded" };
      }
      return moveToNextStep(state);
    }

    case "findings_ready":
      requireState(state, "running", "findings_review", "running");
      return { ...state, run_status: "waiting", step_status: "waiting" };

    case "approve_findings":
      requireState(state, "waiting", "findings_review", "waiting");
      return moveToStep(state, "revision_pass");

    case "coherence_blocker":
      requireState(state, "running", "final_coherence_export", "running");
      if (state.coherence_return_cycles >= MAX_COHERENCE_RETURN_CYCLES) {
        return { ...state, run_status: "blocked", step_status: "blocked" };
      }
      return {
        ...moveToStep(state, "revision_pass"),
        coherence_return_cycles: state.coherence_return_cycles + 1,
      };

    case "fail_retryable":
      requireActive(state);
      return { ...state, run_status: "retryable_failed", step_status: "retryable_failed" };

    case "retry":
      if (state.run_status !== "retryable_failed" || state.step_status !== "retryable_failed") {
        throw new TransitionError(
          `Cannot retry from ${state.run_status}/${state.current_step}/${state.step_status}`,
        );
      }
      return {
        ...state,
        run_status: "running",
        step_status: "running",
        attempt_number: state.attempt_number + 1,
      };

    case "block":
      if (!(
        (state.run_status === "running" && state.step_status === "running") ||
        (state.run_status === "waiting" && state.step_status === "waiting") ||
        (state.run_status === "retryable_failed" && state.step_status === "retryable_failed")
      )) {
        throw new TransitionError(
          `Cannot block from ${state.run_status}/${state.current_step}/${state.step_status}`,
        );
      }
      return { ...state, run_status: "blocked", step_status: "blocked" };

    case "cancel":
      if (["succeeded", "cancelled"].includes(state.run_status)) {
        throw new TransitionError(`Cannot cancel a ${state.run_status} run`);
      }
      return { ...state, run_status: "cancelled", step_status: "cancelled" };
  }
}

function moveToNextStep(state: WorkflowState): WorkflowState {
  const next = NEXT_STEP[state.current_step];
  if (!next) throw new TransitionError(`No next step after ${state.current_step}`);
  return moveToStep(state, next);
}

function moveToStep(state: WorkflowState, step: PipelineStepId): WorkflowState {
  return {
    ...state,
    run_status: "running",
    current_step: step,
    step_status: "running",
    attempt_number: 1,
  };
}

function requireActive(state: WorkflowState): void {
  if (state.run_status !== "running" || state.step_status !== "running") {
    throw new TransitionError(
      `Active event not allowed from ${state.run_status}/${state.current_step}/${state.step_status}`,
    );
  }
}

function requireState(
  state: WorkflowState,
  runStatus: RunStatus,
  currentStep: PipelineStepId,
  stepStatus: StepStatus,
): void {
  if (
    state.run_status !== runStatus ||
    state.current_step !== currentStep ||
    state.step_status !== stepStatus
  ) {
    throw new TransitionError(
      `Event not allowed from ${state.run_status}/${state.current_step}/${state.step_status}`,
    );
  }
}

function validateState(state: WorkflowState): void {
  if (
    !Number.isInteger(state.coherence_return_cycles) ||
    state.coherence_return_cycles < 0 ||
    state.coherence_return_cycles > MAX_COHERENCE_RETURN_CYCLES
  ) {
    throw new TransitionError(
      `Invalid coherence return cycle count: ${state.coherence_return_cycles}`,
    );
  }
  if (!Number.isInteger(state.attempt_number) || state.attempt_number < 0) {
    throw new TransitionError(`Invalid attempt number: ${state.attempt_number}`);
  }
}

export class TransitionError extends Error {
  override readonly name = "TransitionError";
}

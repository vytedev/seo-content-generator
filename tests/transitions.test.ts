import { describe, expect, it } from "vitest";
import {
  PIPELINE_STEPS,
  TransitionError,
  transitionWorkflow,
  type WorkflowState,
} from "../src/shared/index.js";

const initial: WorkflowState = {
  run_status: "queued",
  current_step: "ingest_handoff",
  step_status: "queued",
  attempt_number: 0,
  coherence_return_cycles: 0,
};

function advance(state: WorkflowState, count: number): WorkflowState {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = transitionWorkflow(next, { type: "complete_step" });
  }
  return next;
}

describe("workflow transitions", () => {
  it("starts and follows the exact task registry order", () => {
    let state = transitionWorkflow(initial, { type: "start" });
    expect(state).toMatchObject({
      run_status: "running",
      step_status: "running",
      attempt_number: 1,
    });
    const observed = [state.current_step];
    for (let index = 0; index < 7; index += 1) {
      state = transitionWorkflow(state, { type: "complete_step" });
      observed.push(state.current_step);
      expect(state.attempt_number).toBe(1);
    }
    expect(observed).toEqual(PIPELINE_STEPS.slice(0, 8).map(({ id }) => id));
  });

  it("requires findings to wait for explicit operator approval", () => {
    const atFindings = advance(transitionWorkflow(initial, { type: "start" }), 8);
    expect(atFindings.current_step).toBe("findings_review");
    expect(() => transitionWorkflow(atFindings, { type: "complete_step" })).toThrow(
      "must enter the operator wait",
    );
    const waiting = transitionWorkflow(atFindings, { type: "findings_ready" });
    expect(waiting).toMatchObject({
      run_status: "waiting",
      current_step: "findings_review",
      step_status: "waiting",
    });
    expect(() => transitionWorkflow(waiting, { type: "retry" })).toThrow(TransitionError);
    const approved = transitionWorkflow(waiting, { type: "approve_findings" });
    expect(approved).toMatchObject({
      run_status: "running",
      current_step: "revision_pass",
      step_status: "running",
      attempt_number: 1,
    });
  });

  it("permits only revision, checks rerun and final review in each coherence cycle", () => {
    const atFinal: WorkflowState = {
      run_status: "running",
      current_step: "final_coherence_export",
      step_status: "running",
      attempt_number: 1,
      coherence_return_cycles: 0,
    };
    const first = transitionWorkflow(atFinal, { type: "coherence_blocker" });
    expect(first).toMatchObject({ current_step: "revision_pass", coherence_return_cycles: 1 });
    const checks = transitionWorkflow(first, { type: "complete_step" });
    expect(checks.current_step).toBe("automated_checks_rerun");
    const finalAgain = transitionWorkflow(checks, { type: "complete_step" });
    expect(finalAgain.current_step).toBe("final_coherence_export");

    const second = transitionWorkflow(finalAgain, { type: "coherence_blocker" });
    expect(second).toMatchObject({ current_step: "revision_pass", coherence_return_cycles: 2 });
    const finalThird = advance(second, 2);
    expect(transitionWorkflow(finalThird, { type: "coherence_blocker" })).toMatchObject({
      run_status: "blocked",
      current_step: "final_coherence_export",
      step_status: "blocked",
      coherence_return_cycles: 2,
    });
  });

  it("increments attempts when retrying the same failed step", () => {
    const running = transitionWorkflow(initial, { type: "start" });
    const failed = transitionWorkflow(running, { type: "fail_retryable" });
    expect(failed).toMatchObject({
      run_status: "retryable_failed",
      current_step: "ingest_handoff",
      step_status: "retryable_failed",
      attempt_number: 1,
    });
    expect(transitionWorkflow(failed, { type: "retry" })).toMatchObject({
      run_status: "running",
      current_step: "ingest_handoff",
      step_status: "running",
      attempt_number: 2,
    });
  });

  it("rejects active events from inconsistent run/step states", () => {
    const inconsistent: WorkflowState = {
      ...initial,
      run_status: "running",
      step_status: "succeeded",
      attempt_number: 1,
    };
    expect(() => transitionWorkflow(inconsistent, { type: "complete_step" })).toThrow(
      TransitionError,
    );
    expect(() => transitionWorkflow(inconsistent, { type: "fail_retryable" })).toThrow(
      TransitionError,
    );
    expect(() => transitionWorkflow(inconsistent, { type: "block" })).toThrow(TransitionError);
  });

  it("succeeds only when final coherence/export completes", () => {
    const final: WorkflowState = {
      run_status: "running",
      current_step: "final_coherence_export",
      step_status: "running",
      attempt_number: 1,
      coherence_return_cycles: 0,
    };
    expect(transitionWorkflow(final, { type: "complete_step" })).toMatchObject({
      run_status: "succeeded",
      step_status: "succeeded",
    });
  });

  it("supports cancellation and rejects malformed counters", () => {
    expect(transitionWorkflow(initial, { type: "cancel" }).run_status).toBe("cancelled");
    expect(() =>
      transitionWorkflow({ ...initial, coherence_return_cycles: 3 }, { type: "start" }),
    ).toThrow("Invalid coherence return cycle count");
    expect(() => transitionWorkflow({ ...initial, attempt_number: -1 }, { type: "start" })).toThrow(
      "Invalid attempt number",
    );
  });
});

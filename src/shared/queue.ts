import { z } from "zod";
import type { PipelineStepId } from "./pipeline.js";

export const QueueJobStateSchema = z.enum([
  "ready",
  "leased",
  "retry_wait",
  "parked",
  "operator_action",
  "completed",
  "cancelled",
]);
export type QueueJobState = z.infer<typeof QueueJobStateSchema>;

export const QueueJobPhaseSchema = z.enum(["pre_downstream", "downstream_started"]);
export type QueueJobPhase = z.infer<typeof QueueJobPhaseSchema>;

export const QueueOptionsSchema = z
  .object({
    refresh_link_discovery: z.boolean().optional(),
    authorise_legacy_draft_recovery: z.boolean().optional(),
    authorise_legacy_review_recovery: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const authorities = Object.values(value).filter(Boolean).length;
    if (authorities > 1)
      context.addIssue({
        code: "custom",
        message: "Queue authorities must be requested separately",
      });
  });
export type QueueOptions = z.infer<typeof QueueOptionsSchema>;

export interface QueueLease {
  id: string;
  run_id: string;
  token: string;
  attempt: number;
  phase: QueueJobPhase;
  options: QueueOptions;
}

export type SafeQueueRetryCode = "queue_pre_dispatch_coordination";

/**
 * The only automatic retry producer. Before orchestrator dispatch, the queue has performed
 * coordination reads only, so a failure cannot represent an unknown provider outcome.
 */
export function mapPreDispatchQueueFailure(error: unknown): ProvenSafeQueueError {
  return new ProvenSafeQueueError(
    "queue_pre_dispatch_coordination",
    "Pre-dispatch queue coordination failed safely",
    { cause: error },
  );
}

export class ProvenSafeQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProvenSafeQueueError";
    this.code = z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,63}$/)
      .parse(code);
  }
}

export interface PipelineQueueRepository {
  enqueueRun(runId: string, options?: QueueOptions): Promise<void>;
  claimQueueJob(owner: string, leaseMs: number): Promise<QueueLease | null>;
  heartbeatQueueJob(jobId: string, token: string, leaseMs: number): Promise<boolean>;
  /**
   * Atomically closes the refresh window under the current fence. A refresh that serialised first
   * is promoted; otherwise paid downstream authority is durably marked as started.
   */
  closeRefreshWindow(
    jobId: string,
    token: string,
  ): Promise<"refresh_promoted" | "downstream_started" | null>;
  finishQueueJob(
    jobId: string,
    token: string,
    state: Extract<QueueJobState, "parked" | "operator_action" | "completed" | "cancelled">,
    errorCode?: string,
  ): Promise<boolean>;
  retryQueueJob(jobId: string, token: string, delayMs: number, errorCode: string): Promise<boolean>;
  recoverQueueJobs(): Promise<void>;
  hasActiveQueueJob(runId: string): Promise<boolean>;
  /** Return a leased job to a short coordination wait without spending its attempt budget. */
  deferQueueJob(jobId: string, token: string, delayMs: number): Promise<boolean>;
  queueExecutionState(runId: string): Promise<{
    run_status: string;
    current_step: PipelineStepId | null;
    ambiguous: boolean;
    coordination_wait: boolean;
  }>;
}

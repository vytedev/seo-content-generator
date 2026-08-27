import {
  mapPreDispatchQueueFailure,
  ProvenSafeQueueError,
  type PipelineQueueRepository,
  type QueueLease,
  type QueueJobState,
} from "../../shared/queue.js";
import type { MilestoneTwoOrchestrator } from "./milestone-two.js";
import type { MilestoneThreeOrchestrator } from "./milestone-three.js";
import type { MilestoneFourOrchestrator } from "./milestone-four.js";
import { classifyError, logger } from "../logger.js";

export interface QueueWorkerOrchestrators {
  milestoneTwo: MilestoneTwoOrchestrator;
  milestoneThree: MilestoneThreeOrchestrator;
  milestoneFour: MilestoneFourOrchestrator;
}

export class QueueLeaseLostError extends Error {
  constructor() {
    super("Queue lease ownership was lost");
    this.name = "QueueLeaseLostError";
  }
}

export type QueueWorkerStopResult = "drained" | "deadline_exceeded";

export class PipelineQueueWorker {
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveWake: (() => void) | null = null;
  private abandonCurrent: (() => void) | null = null;
  private fatalError: unknown = null;

  constructor(
    private readonly repository: PipelineQueueRepository,
    private readonly orchestrators: QueueWorkerOrchestrators,
    private readonly owner = `pipeline-worker-${process.pid}`,
    private readonly leaseMs = 30_000,
    private readonly pollMs = 250,
    private readonly random = Math.random,
    private readonly drainMs = 10_000,
    private readonly onFailure: (error: unknown) => void = () => undefined,
  ) {}

  health(): { status: "running" | "stopped" | "failed"; error?: unknown } {
    if (this.fatalError) return { status: "failed", error: this.fatalError };
    return { status: this.loopPromise ? "running" : "stopped" };
  }

  async start(): Promise<void> {
    if (this.loopPromise) return;
    this.stopping = false;
    this.fatalError = null;
    logger.info("queue.worker_starting", { worker_status: "starting" });
    // Startup recovery is readiness-critical. Deliberately let rejection reach the caller.
    await this.repository.recoverQueueJobs();
    logger.info("queue.recovery_completed", { worker_status: "starting" });
    this.loopPromise = this.loop().catch((error: unknown) => {
      this.fatalError = error;
      logger.error("queue.worker_failed", {
        worker_status: "failed",
        ...classifyError(error),
      });
      this.onFailure(error);
    });
    logger.info("queue.worker_started", { worker_status: "running" });
  }

  async stop(deadlineMs = this.drainMs): Promise<QueueWorkerStopResult> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0)
      throw new Error("Worker shutdown deadline must be a non-negative integer");
    this.stopping = true;
    logger.info("queue.worker_stopping", { worker_status: "stopping" });
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.resolveWake?.();
      this.resolveWake = null;
    }
    const loop = this.loopPromise;
    if (!loop) return "drained";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      loop.then(() => "drained" as const),
      new Promise<"deadline_exceeded">((resolve) => {
        timer = setTimeout(() => resolve("deadline_exceeded"), deadlineMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result === "drained") this.loopPromise = null;
    else {
      // Do not release or mutate the durable queue claim. Stop heartbeating/fence this local
      // execution so ownership expires naturally and a supervised worker can recover it.
      this.abandonCurrent?.();
    }
    logger.info("queue.worker_stopped", {
      worker_status: result === "drained" ? "stopped" : "deadline_exceeded",
      outcome: result,
    });
    return result;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const job = await this.repository.claimQueueJob(this.owner, this.leaseMs);
      if (!job) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.wakeTimer = null;
            this.resolveWake = null;
            resolve();
          };
          this.resolveWake = wake;
          this.wakeTimer = setTimeout(wake, this.pollMs);
          if (this.stopping) {
            clearTimeout(this.wakeTimer);
            wake();
          }
        });
        continue;
      }
      logger.info("queue.job_claimed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        attempt: job.attempt,
      });
      await this.execute(job);
    }
  }

  private async execute(job: QueueLease): Promise<void> {
    let leaseLost = false;
    let heartbeatBusy = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatBusy || leaseLost) return;
        heartbeatBusy = true;
        void this.repository
          .heartbeatQueueJob(job.id, job.token, this.leaseMs)
          .then((renewed) => {
            if (!renewed) {
              leaseLost = true;
              logger.warn("queue.heartbeat_rejected", {
                queue_job_id: job.id,
                run_id: job.run_id,
              });
            } else {
              logger.debug("queue.heartbeat_renewed", {
                queue_job_id: job.id,
                run_id: job.run_id,
              });
            }
          })
          .catch((error: unknown) => {
            // A DB error cannot prove continued ownership.
            leaseLost = true;
            logger.warn("queue.heartbeat_failed", {
              queue_job_id: job.id,
              run_id: job.run_id,
              ...classifyError(error),
            });
          })
          .finally(() => {
            heartbeatBusy = false;
          });
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref?.();
    this.abandonCurrent = () => {
      leaseLost = true;
      clearInterval(heartbeat);
    };

    const own = () => {
      if (leaseLost) throw new QueueLeaseLostError();
    };
    const finish = async (
      state: Extract<QueueJobState, "parked" | "operator_action" | "completed" | "cancelled">,
      code?: string,
    ) => {
      own();
      if (!(await this.repository.finishQueueJob(job.id, job.token, state, code)))
        throw new QueueLeaseLostError();
      logger.info(`queue.job_${state}`, {
        queue_job_id: job.id,
        run_id: job.run_id,
        transition: state,
        ...(code ? { code } : {}),
      });
    };

    try {
      let before;
      try {
        before = await this.repository.queueExecutionState(job.run_id);
      } catch (error) {
        throw mapPreDispatchQueueFailure(error);
      }
      own();
      logger.info("queue.state_observed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        status: before.run_status,
        step: before.current_step,
      });
      const refreshOnly =
        job.options.refresh_link_discovery === true && Object.keys(job.options).length === 1;
      if (before.run_status === "cancelled") {
        await finish("cancelled");
        return;
      }
      // A dedicated refresh is evidence/cache-only and remains valid after the workflow parks or
      // succeeds. Its exact option shape is the authority boundary: no paid orchestrator runs.
      if (refreshOnly) {
        const refreshStarted = Date.now();
        logger.info("queue.refresh_started", { queue_job_id: job.id, run_id: job.run_id });
        await this.orchestrators.milestoneTwo.refreshLinks(job.run_id, this.owner);
        own();
        logger.info("queue.refresh_completed", {
          queue_job_id: job.id,
          run_id: job.run_id,
          duration_ms: Date.now() - refreshStarted,
        });
        own();
        const afterRefresh = await this.repository.queueExecutionState(job.run_id);
        own();
        if (afterRefresh.run_status === "cancelled") await finish("cancelled");
        else if (afterRefresh.run_status === "succeeded") await finish("completed");
        else if (["waiting", "blocked"].includes(afterRefresh.run_status))
          await finish("parked", "refresh_completed");
        else await finish("parked", "refresh_completed");
        return;
      }
      if (before.run_status === "succeeded") {
        await finish("completed");
        return;
      }
      if (before.coordination_wait) {
        if (!(await this.repository.deferQueueJob(job.id, job.token, 1_000)))
          throw new QueueLeaseLostError();
        logger.info("queue.job_deferred", { queue_job_id: job.id, run_id: job.run_id });
        return;
      }
      if (before.ambiguous) {
        await finish("operator_action", "ambiguous_paid_operation");
        return;
      }
      let milestoneStarted = Date.now();
      logger.info("queue.milestone_started", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_two",
      });
      await this.orchestrators.milestoneTwo.run(job.run_id, this.owner, {
        refreshLinkDiscovery: job.options.refresh_link_discovery ?? false,
        operatorAuthorisedDraftRecovery: job.options.authorise_legacy_draft_recovery ?? false,
      });
      own();
      logger.info("queue.milestone_completed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_two",
        duration_ms: Date.now() - milestoneStarted,
      });
      own();
      // Atomically close the refresh window before granting any paid downstream authority. The
      // enqueue transaction serialises on the same row, so it either wins and is promoted here or
      // observes downstream_started and returns an explicit conflict.
      const boundary = await this.repository.closeRefreshWindow(job.id, job.token);
      if (boundary === null) throw new QueueLeaseLostError();
      logger.info("queue.refresh_boundary", {
        queue_job_id: job.id,
        run_id: job.run_id,
        outcome: boundary,
      });
      if (boundary === "refresh_promoted") return;
      own();
      milestoneStarted = Date.now();
      logger.info("queue.milestone_started", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_three",
      });
      await this.orchestrators.milestoneThree.run(job.run_id, this.owner);
      own();
      logger.info("queue.milestone_completed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_three",
        duration_ms: Date.now() - milestoneStarted,
      });
      own();
      milestoneStarted = Date.now();
      logger.info("queue.milestone_started", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_four",
      });
      await this.orchestrators.milestoneFour.run(job.run_id, this.owner);
      own();
      logger.info("queue.milestone_completed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        phase: "milestone_four",
        duration_ms: Date.now() - milestoneStarted,
      });
      own();
      const after = await this.repository.queueExecutionState(job.run_id);
      own();
      if (after.run_status === "waiting") await finish("parked", "operator_wait");
      else if (after.run_status === "cancelled") await finish("cancelled");
      else if (after.run_status === "succeeded") await finish("completed");
      else if (after.ambiguous) await finish("operator_action", "ambiguous_paid_operation");
      else await finish("parked", "workflow_blocked");
    } catch (error) {
      if (error instanceof QueueLeaseLostError || leaseLost) {
        logger.warn("queue.lease_lost", {
          queue_job_id: job.id,
          run_id: job.run_id,
          category: "lease_lost",
        });
        return;
      }
      const failure = classifyError(error);
      logger.warn("queue.job_failed", {
        queue_job_id: job.id,
        run_id: job.run_id,
        ...failure,
      });
      const state = await this.repository.queueExecutionState(job.run_id).catch(() => null);
      own();
      if (state?.run_status === "cancelled") await finish("cancelled");
      else if (state?.coordination_wait) {
        if (!(await this.repository.deferQueueJob(job.id, job.token, 1_000)))
          throw new QueueLeaseLostError();
        logger.info("queue.job_deferred", { queue_job_id: job.id, run_id: job.run_id });
      } else if (state?.run_status === "waiting") await finish("parked", "operator_wait");
      else if (state?.run_status === "blocked") await finish("parked", "workflow_blocked");
      else if (state?.ambiguous) {
        await finish("operator_action", "ambiguous_paid_operation");
        logger.warn("queue.final_job_failed", {
          queue_job_id: job.id,
          run_id: job.run_id,
          outcome: "operator_action",
          ...failure,
        });
      } else if (
        error instanceof ProvenSafeQueueError &&
        error.code === "queue_pre_dispatch_coordination"
      ) {
        const base = 1_000 * 2 ** Math.max(0, job.attempt - 1);
        const delay = Math.round(base * (0.75 + this.random() * 0.5));
        if (!(await this.repository.retryQueueJob(job.id, job.token, delay, error.code)))
          throw new QueueLeaseLostError();
        logger.info("queue.job_retried", {
          queue_job_id: job.id,
          run_id: job.run_id,
          attempt: job.attempt,
          code: error.code,
        });
      } else {
        await finish("operator_action", "unsafe_pipeline_failure");
        logger.warn("queue.final_job_failed", {
          queue_job_id: job.id,
          run_id: job.run_id,
          outcome: "operator_action",
          ...failure,
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.abandonCurrent = null;
    }
  }
}

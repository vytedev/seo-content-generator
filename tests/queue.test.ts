import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { PipelineQueueWorker } from "../src/server/pipeline/queue-worker.js";
import { mapPreDispatchQueueFailure } from "../src/shared/queue.js";
import { createApp } from "../src/server/app/create-app.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

function captureEvents() {
  const lines: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return {
    events: () =>
      lines
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { event: string; [key: string]: unknown }),
    restore: () => write.mockRestore(),
  };
}

describe("durable pipeline queue", () => {
  it("keeps leased options immutable and durably consumes one idempotent refresh continuation", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-ingest-1", repository);
    const lease = await repository.claimQueueJob("worker", 30_000);
    await repository.enqueueRun(run.run_id, { refresh_link_discovery: true });
    await repository.enqueueRun(run.run_id, { refresh_link_discovery: true });
    expect(lease?.options).toEqual({});
    expect(repository.queueJobs[0]).toMatchObject({
      state: "leased",
      options: {},
      pendingRefresh: true,
      pendingOptions: {},
    });
    expect(await repository.finishQueueJob(lease!.id, lease!.token, "parked")).toBe(true);
    expect(repository.queueJobs[0]).toMatchObject({
      state: "ready",
      attempt: 0,
      options: { refresh_link_discovery: true },
      pendingRefresh: false,
      pendingOptions: {},
    });
  });

  it("rejects cross-authority accumulation and never grants draft recovery to refresh", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-authority-isolation", repository);
    await repository.claimQueueJob("worker", 30_000);
    await repository.enqueueRun(run.run_id, { refresh_link_discovery: true });
    await expect(
      repository.enqueueRun(run.run_id, { authorise_legacy_draft_recovery: true }),
    ).rejects.toThrow("requested separately");
    expect(repository.queueJobs[0]).toMatchObject({
      pendingRefresh: true,
      pendingOptions: {},
    });
    await expect(
      repository.enqueueRun(run.run_id, {
        refresh_link_discovery: true,
        authorise_legacy_draft_recovery: true,
      }),
    ).rejects.toThrow("requested separately");
  });

  it.each(["waiting", "blocked", "succeeded"] as const)(
    "runs exact refresh-only work while %s without paid downstream dispatch",
    async (status) => {
      const repository = new InMemoryMilestoneRepository();
      await ingestHandoff(handoff, `queue-refresh-${status}`, repository);
      const initial = await repository.claimQueueJob("old", 30_000);
      await repository.enqueueRun(initial!.run_id, { refresh_link_discovery: true });
      (repository as any).runs.get(initial!.run_id).status = status;
      await repository.finishQueueJob(initial!.id, initial!.token, "parked");
      const refreshLinks = vi.fn();
      const downstream = vi.fn();
      const output = captureEvents();
      const worker = new PipelineQueueWorker(
        repository,
        {
          milestoneTwo: { refreshLinks, run: downstream } as never,
          milestoneThree: { run: downstream } as never,
          milestoneFour: { run: downstream } as never,
        },
        "refresh-worker",
        30_000,
        1,
      );
      await worker.start();
      await vi.waitFor(() => expect(refreshLinks).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(["parked", "completed"]).toContain(repository.queueJobs[0]?.state),
      );
      await worker.stop();
      expect(downstream).not.toHaveBeenCalled();
      expect((repository as any).runs.get(initial!.run_id).status).toBe(status);
      const events = output.events().map(({ event }) => event);
      expect(events).toContain("queue.refresh_started");
      expect(events).toContain("queue.refresh_completed");
      expect(events).toContain(status === "succeeded" ? "queue.job_completed" : "queue.job_parked");
      expect(events.indexOf("queue.refresh_started")).toBeLessThan(
        events.indexOf("queue.refresh_completed"),
      );
      output.restore();
    },
  );

  it("atomically promotes a refresh that wins the downstream boundary", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-refresh-race", repository);
    const milestoneTwoRun = vi.fn(async () => {
      if (milestoneTwoRun.mock.calls.length === 1)
        await repository.enqueueRun(run.run_id, { refresh_link_discovery: true });
    });
    const refreshLinks = vi.fn();
    const downstream = vi.fn();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: milestoneTwoRun, refreshLinks } as never,
        milestoneThree: { run: downstream } as never,
        milestoneFour: { run: downstream } as never,
      },
      "race-worker",
      30_000,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(refreshLinks).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(milestoneTwoRun).toHaveBeenCalledTimes(2));
    expect(downstream).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("conflicts a refresh that loses the atomic downstream boundary", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-refresh-loses-race", repository);
    const lease = await repository.claimQueueJob("worker", 30_000);
    await expect(repository.closeRefreshWindow(lease!.id, lease!.token)).resolves.toBe(
      "downstream_started",
    );
    await expect(
      repository.enqueueRun(run.run_id, { refresh_link_discovery: true }),
    ).rejects.toThrow("after paid downstream processing has started");
    expect(repository.queueJobs[0]).toMatchObject({
      phase: "downstream_started",
      pendingRefresh: false,
      options: {},
    });
  });

  it("fails resume closed without a durable queue and never invokes an orchestrator", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-required-route", repository);
    const runStep = vi.fn();
    const app = createApp({
      serveClient: false,
      milestoneTwo: { repository, orchestrator: { run: runStep } as never },
    });
    const response = await request(app).post(`/api/runs/${run.run_id}/milestone-two/resume`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(runStep).not.toHaveBeenCalled();
  });

  it("defers safely for an active step lease without spending queue attempts", async () => {
    let now = 0;
    const repository = new InMemoryMilestoneRepository(300_000, () => now);
    const run = await ingestHandoff(handoff, "queue-step-coordination", repository);
    await repository.claimStep(run.run_id, "internal_link_discovery", "old-worker");
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: vi.fn() } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "replacement",
      30_000,
      1,
    );
    const output = captureEvents();
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("retry_wait"));
    await worker.stop();
    expect(output.events().filter(({ event }) => event === "queue.job_deferred")).toHaveLength(1);
    output.restore();
    expect(repository.queueJobs[0]).toMatchObject({
      attempt: 0,
      error: "step_lease_coordination_wait",
    });
  });

  it("fences stale completion and bounds retries at three attempts", async () => {
    let now = 0;
    const repository = new InMemoryMilestoneRepository(300_000, () => now);
    await ingestHandoff(handoff, "queue-retry-1", repository);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await repository.claimQueueJob("worker", 100)!;
      expect(lease?.attempt).toBe(attempt);
      expect(await repository.finishQueueJob(lease!.id, "stale", "completed")).toBe(false);
      await repository.retryQueueJob(lease!.id, lease!.token, 10, "safe_failure");
      now += 11;
    }
    expect(repository.queueJobs[0]?.state).toBe("operator_action");
    expect(await repository.claimQueueJob("worker", 100)).toBeNull();
  });

  it("maps only the pre-dispatch coordination boundary to an automatic retry", () => {
    expect(mapPreDispatchQueueFailure(new Error("database unavailable"))).toMatchObject({
      name: "ProvenSafeQueueError",
      code: "queue_pre_dispatch_coordination",
    });
  });

  it("supervises a queue loop failure and exposes failed health", async () => {
    const repository = new InMemoryMilestoneRepository();
    vi.spyOn(repository, "claimQueueJob").mockRejectedValue(new Error("claim failed"));
    const onFailure = vi.fn();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: {} as never,
        milestoneThree: {} as never,
        milestoneFour: {} as never,
      },
      "test",
      100,
      1,
      Math.random,
      100,
      onFailure,
    );
    await worker.start();
    await vi.waitFor(() => expect(worker.health().status).toBe("failed"));
    expect(onFailure).toHaveBeenCalledOnce();
    const health = await request(
      createApp({ serveClient: false, workerHealth: () => worker.health() }),
    ).get("/api/health");
    expect(health.status).toBe(503);
    expect(health.body).toEqual({ status: "degraded", queue_worker: "failed" });
    await worker.stop();
  });

  it("returns at its deadline for a stuck operation and leaves its durable lease owned", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-bounded-stop", repository);
    const never = new Promise<void>(() => undefined);
    const runStep = vi.fn(() => never);
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: runStep } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "bounded-stop",
      30_000,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledOnce());
    await expect(worker.stop(5)).resolves.toBe("deadline_exceeded");
    expect(repository.queueJobs[0]).toMatchObject({ state: "leased" });
    expect(worker.health().status).toBe("running");
  });

  it("retries a proven pre-dispatch coordination failure without dispatching", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-safe-retry", repository);
    vi.spyOn(repository, "queueExecutionState").mockRejectedValueOnce(new Error("db read failed"));
    const runStep = vi.fn();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: runStep } as never,
        milestoneThree: { run: runStep } as never,
        milestoneFour: { run: runStep } as never,
      },
      "test",
      100,
      1,
      () => 0.5,
    );
    const output = captureEvents();
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("retry_wait"));
    await worker.stop();
    expect(output.events().filter(({ event }) => event === "queue.job_retried")).toHaveLength(1);
    output.restore();
    expect(runStep).not.toHaveBeenCalled();
    expect(repository.queueJobs[0]?.error).toBe("queue_pre_dispatch_coordination");
  });

  it("heartbeat loss lets a competitor park ambiguity without duplicate provider dispatch or stale finish", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-heartbeat-race", repository);
    let stateReads = 0;
    vi.spyOn(repository, "queueExecutionState").mockImplementation(async () => ({
      run_status: "running",
      current_step: "draft",
      ambiguous: stateReads++ > 0,
      coordination_wait: false,
    }));
    vi.spyOn(repository, "heartbeatQueueJob").mockResolvedValue(false);
    const output = captureEvents();
    let release!: () => void;
    const providerCall = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const noOp = vi.fn();
    const first = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: providerCall } as never,
        milestoneThree: { run: noOp } as never,
        milestoneFour: { run: noOp } as never,
      },
      "first",
      30,
      1,
    );
    await first.start();
    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 45));
    const competitor = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: providerCall } as never,
        milestoneThree: { run: noOp } as never,
        milestoneFour: { run: noOp } as never,
      },
      "competitor",
      30,
      1,
    );
    await competitor.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("operator_action"));
    release();
    await Promise.all([first.stop(), competitor.stop()]);
    expect(providerCall).toHaveBeenCalledOnce();
    expect(repository.queueJobs[0]?.error).toBe("ambiguous_paid_operation");
    const events = output.events().map(({ event }) => event);
    expect(events).toContain("queue.heartbeat_rejected");
    expect(events).not.toContain("queue.milestone_completed");
    output.restore();
  });

  it("emits heartbeat failure and no milestone completion after lease loss", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-heartbeat-failed", repository);
    vi.spyOn(repository, "heartbeatQueueJob").mockRejectedValue(new Error("database unavailable"));
    let release!: () => void;
    const runStep = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const output = captureEvents();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: runStep } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "heartbeat-failure-worker",
      30,
      1,
    );
    await worker.start();
    await vi.waitFor(() =>
      expect(output.events().some(({ event }) => event === "queue.heartbeat_failed")).toBe(true),
    );
    release();
    await worker.stop();
    const events = output.events().map(({ event }) => event);
    expect(events).not.toContain("queue.milestone_completed");
    expect(JSON.stringify(output.events())).not.toContain("database unavailable");
    output.restore();
  });

  it("emits exactly one completed event for an already-succeeded run", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-completed-once", repository);
    vi.spyOn(repository, "queueExecutionState").mockResolvedValue({
      run_status: "succeeded",
      current_step: "final_coherence_export",
      ambiguous: false,
      coordination_wait: false,
    });
    const output = captureEvents();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: vi.fn() } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "completed-worker",
      30_000,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("completed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await worker.stop();
    expect(output.events().filter(({ event }) => event === "queue.job_completed")).toHaveLength(1);
    output.restore();
  });

  it("emits ordered queue boundaries with one terminal transition", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-observability", repository);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: vi.fn() } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "observable-worker",
      30_000,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("parked"));
    await worker.stop();
    const events = write.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).event as string);
    expect(events).toEqual([
      "queue.worker_starting",
      "queue.recovery_completed",
      "queue.worker_started",
      "queue.job_claimed",
      "queue.state_observed",
      "queue.milestone_started",
      "queue.milestone_completed",
      "queue.refresh_boundary",
      "queue.milestone_started",
      "queue.milestone_completed",
      "queue.milestone_started",
      "queue.milestone_completed",
      "queue.job_parked",
      "queue.worker_stopping",
      "queue.worker_stopped",
    ]);
    expect(events.filter((event) => event === "queue.job_parked")).toHaveLength(1);
    expect(events).not.toContain("queue.job_transitioned");
    write.mockRestore();
  });

  it("emits cancellation without invoking orchestrators", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-cancelled-event", repository);
    vi.spyOn(repository, "queueExecutionState").mockResolvedValue({
      run_status: "cancelled",
      current_step: "draft",
      ambiguous: false,
      coordination_wait: false,
    });
    const runStep = vi.fn();
    const output = captureEvents();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: runStep } as never,
        milestoneThree: { run: runStep } as never,
        milestoneFour: { run: runStep } as never,
      },
      "cancelled-worker",
      100,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await worker.stop();
    expect(output.events().filter(({ event }) => event === "queue.job_cancelled")).toHaveLength(1);
    expect(runStep).not.toHaveBeenCalled();
    output.restore();
  });

  it("emits final failure only after an operator-action terminal transition", async () => {
    const repository = new InMemoryMilestoneRepository();
    await ingestHandoff(handoff, "queue-terminal-failure-order", repository);
    const output = captureEvents();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: {
          run: vi.fn().mockRejectedValue(new Error("provider uncertainty")),
        } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "terminal-failure-worker",
      100,
      1,
    );
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("operator_action"));
    await worker.stop();
    const events = output.events().map(({ event }) => event);
    expect(events.filter((event) => event === "queue.job_operator_action")).toHaveLength(1);
    expect(events.filter((event) => event === "queue.final_job_failed")).toHaveLength(1);
    expect(events.indexOf("queue.job_operator_action")).toBeLessThan(
      events.indexOf("queue.final_job_failed"),
    );
    output.restore();
  });

  it("parks an ambiguous paid operation without invoking orchestrators", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "queue-ambiguous-1", repository);
    vi.spyOn(repository, "queueExecutionState").mockResolvedValue({
      run_status: "retryable_failed",
      current_step: "draft",
      ambiguous: true,
      coordination_wait: false,
    });
    const runStep = vi.fn();
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: runStep } as never,
        milestoneThree: { run: runStep } as never,
        milestoneFour: { run: runStep } as never,
      },
      "test",
      100,
      1,
    );
    const output = captureEvents();
    await worker.start();
    await vi.waitFor(() => expect(repository.queueJobs[0]?.state).toBe("operator_action"));
    await worker.stop();
    expect(
      output.events().filter(({ event }) => event === "queue.job_operator_action"),
    ).toHaveLength(1);
    output.restore();
    expect(runStep).not.toHaveBeenCalled();
    expect(repository.queueJobs[0]).toMatchObject({
      run_id: run.run_id,
      error: "ambiguous_paid_operation",
    });
  });
});

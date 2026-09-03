import { describe, expect, it, vi } from "vitest";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { PipelineQueueWorker } from "../src/server/pipeline/queue-worker.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { buildRouteCommand } from "../src/server/routes/command-submission.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

describe("memory startup recovery reconciliation", () => {
  it("persists each step lifecycle transition once instead of synthesising current state", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "activity-lifecycle", repository);
    const lease = await repository.claimStep(run.run_id, "internal_link_discovery", "worker");
    await repository.completeStep(lease.execution_id, lease.token);
    const first = await repository.listCommandActivity(run.run_id);
    expect(await repository.listCommandActivity(run.run_id)).toEqual(first);
    expect(first.filter((event) => event.type === "step_started")).toHaveLength(1);
    expect(first.filter((event) => event.type === "step_succeeded")).toHaveLength(2);
    expect(first.map((event) => event.sequence)).toEqual(
      Array.from({ length: first.length }, (_, index) => index + 1),
    );
  });

  it("recovers claim then death after expiry and rejects the stale token", async () => {
    let now = 1_000;
    const repository = new InMemoryMilestoneRepository(100, () => now);
    const run = await ingestHandoff(handoff, "recover-expired", repository);
    const lease = await repository.claimQueueJob("dead-worker", 100);
    now += 101;
    await repository.recoverQueueJobs();
    expect(repository.queueJobs[0]).toMatchObject({ state: "ready", token: null });
    expect(await repository.finishQueueJob(lease!.id, lease!.token, "completed")).toBe(false);
    expect((await repository.claimQueueJob("restart", 100))?.run_id).toBe(run.run_id);
  });

  it("recreates an orphan command queue and projects terminal activity once", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "recover-orphan", repository);
    repository.queueJobs.splice(0);
    await repository.submitCommand(
      buildRouteCommand({
        kind: "resume_run",
        run_id: run.run_id,
        idempotency_key: "recover-command",
        body: { options: {} },
      }),
    );
    repository.queueJobs.splice(0);
    await repository.recoverQueueJobs();
    await repository.recoverQueueJobs();
    expect(repository.queueJobs).toHaveLength(1);
    await repository.cancelRun(run.run_id);
    await repository.recoverQueueJobs();
    await repository.recoverQueueJobs();
    expect(
      repository.commandActivity.filter((event) => event.type === "run_cancelled"),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "recovers an orphan create_run result idempotently (ambiguous=%s)",
    async (ambiguous) => {
      const repository = new InMemoryMilestoneRepository();
      const command = buildRouteCommand({
        kind: "create_run",
        idempotency_key: `orphan-create-${ambiguous}`,
        body: { handoff, warnings: [] },
      });
      const result = await repository.submitCommand(command);
      repository.queueJobs.splice(0);
      repository.commandActivity.splice(0);
      if (ambiguous)
        (repository as any).outputKeys.set(`paid:${result.run_id}:status`, "provider_in_flight");
      await repository.recoverQueueJobs();
      await repository.recoverQueueJobs();
      expect(repository.queueJobs).toHaveLength(1);
      expect(repository.queueJobs[0]).toMatchObject({
        run_id: result.run_id,
        state: ambiguous ? "operator_action" : "ready",
      });
      expect(repository.commandActivity).toHaveLength(1);
      expect(repository.commandActivity[0]).toMatchObject({
        command_id: command.command_id,
        run_id: result.run_id,
      });
    },
  );

  it.each([false, true])(
    "honours submit_findings queue_accepted=%s during orphan recovery",
    async (queueAccepted) => {
      const repository = new InMemoryMilestoneRepository();
      const run = await ingestHandoff(handoff, `recover-findings-${queueAccepted}`, repository);
      repository.queueJobs.splice(0);
      repository.commandActivity.splice(0);
      const command = buildRouteCommand({
        kind: "submit_findings",
        run_id: run.run_id,
        idempotency_key: `recover-findings-command-${queueAccepted}`,
        body: {
          dispositions: {
            document_version_id: "document-version",
            idempotency_key: `recover-findings-domain-${queueAccepted}`,
            dispositions: [{ finding_id: "finding", decision: "accepted" }],
          },
        },
      });
      repository.commands.push(command);
      (repository as any).commandResults.set(command.command_id, {
        command_id: command.command_id,
        run_id: run.run_id,
        replayed: false,
        queue_accepted: queueAccepted,
        result: { continuation_required: queueAccepted },
      });
      await repository.recoverQueueJobs();
      await repository.recoverQueueJobs();
      expect(repository.queueJobs).toHaveLength(queueAccepted ? 1 : 0);
      expect(repository.commandActivity).toHaveLength(1);
    },
  );

  it("fails closed for a malformed orphan create_run terminal result", async () => {
    const repository = new InMemoryMilestoneRepository();
    const command = buildRouteCommand({
      kind: "create_run",
      idempotency_key: "orphan-create-malformed",
      body: { handoff, warnings: [] },
    });
    await repository.submitCommand(command);
    repository.queueJobs.splice(0);
    repository.commandActivity.splice(0);
    (repository as any).commandResults.set(command.command_id, { run_id: "not-a-result" });
    await repository.recoverQueueJobs();
    expect(repository.queueJobs).toHaveLength(0);
    expect(repository.commandActivity).toHaveLength(0);
  });

  it("parks orphan work for a pending export with an existing external document", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "recover-export-ambiguity", repository);
    repository.queueJobs.splice(0);
    const command = buildRouteCommand({
      kind: "resume_run",
      run_id: run.run_id,
      idempotency_key: "recover-export-command",
      body: { options: {} },
    });
    repository.commands.push(command);
    (repository as any).commandResults.set(command.command_id, {
      command_id: command.command_id,
      run_id: run.run_id,
      replayed: false,
      queue_accepted: true,
      result: { queued: true },
    });
    repository.exports.push({
      run_id: run.run_id,
      document_version_id: "document-version",
      external_document_id: "google-document",
      external_url: "https://docs.google.com/document/d/google-document",
      status: "pending",
    });
    await repository.recoverQueueJobs();
    expect(repository.queueJobs).toHaveLength(1);
    expect(repository.queueJobs[0]).toMatchObject({
      state: "operator_action",
      error: "ambiguous_paid_operation",
    });
    expect(repository.exports[0]).toMatchObject({
      status: "pending",
      external_document_id: "google-document",
    });
  });

  it("parks ambiguous paid authority and shutdown never releases it", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await ingestHandoff(handoff, "recover-ambiguous", repository);
    (repository as any).outputKeys.set(`paid:${run.run_id}:status`, "provider_in_flight");
    await repository.recoverQueueJobs();
    expect(repository.queueJobs[0]).toMatchObject({
      state: "operator_action",
      error: "ambiguous_paid_operation",
    });
    const worker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: { run: vi.fn() } as never,
        milestoneThree: { run: vi.fn() } as never,
        milestoneFour: { run: vi.fn() } as never,
      },
      "shutdown-worker",
      100,
      1,
    );
    await worker.start();
    await worker.stop(1);
    expect((repository as any).outputKeys.get(`paid:${run.run_id}:status`)).toBe(
      "provider_in_flight",
    );
  });
});

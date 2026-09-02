import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { createIngestService } from "../src/server/routes/ingest-routes.js";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import {
  MilestoneTwoOrchestrator,
  MockLinkDiscoverer,
} from "../src/server/pipeline/milestone-two.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { ConflictError } from "../src/shared/errors.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";

function handoff(planeTicket: string) {
  return {
    plane_ticket: planeTicket,
    primary_keyword: "wishbone chair",
    related_keywords: ["wishbone chair replica"],
    page_type: "blog",
    word_count_target: 1200,
    locales_for_translation: [],
  };
}

/** Builds an app with all three milestone route groups wired to one repository. */
function wiredApp() {
  const repository = new InMemoryMilestoneRepository();
  const two = new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([]),
    new MockDraftProvider("mock-draft-2025-01"),
  );
  const app = createApp({
    serveClient: false,
    ingestService: createIngestService(repository),
    commands: repository,
    milestoneTwo: { repository, orchestrator: two },
    // The cancel route hangs off the milestone-four group; the repository
    // satisfies all three interfaces, and only the repository is needed here.
    milestoneFour: {
      repository,
      orchestrator: two as never,
    },
  });
  return { repository, app };
}

describe("run cancellation", () => {
  it("cancels a running run, revokes its lease and keeps the state against fenced writes", async () => {
    const { repository, app } = wiredApp();
    // Create a run (mock providers run synchronously to the 1.9 wait), then
    // force it back into a running state by claiming a step.
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "cancel-test-1")
      .send(handoff("MOB-CANCEL-1"));
    expect(created.status).toBe(202);
    const runId = created.body.run_id as string;

    // Simulate an in-flight step: claim the draft step for a second attempt.
    const lease = await repository.claimStep(runId, "automated_checks", "test-worker");
    expect((await repository.getRunDetail(runId)).status).toBe("running");

    const cancelled = await request(app)
      .post(`/api/runs/${runId}/cancel`)
      .set("Idempotency-Key", `cancel-second-${runId}`)
      .set("Idempotency-Key", `cancel-first-${runId}`)
      .set("Idempotency-Key", `cancel-${runId}`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toMatchObject({ run_id: runId, queue_accepted: false });

    // The revoked lease now bounces every fenced write: heartbeat, complete.
    expect(await repository.heartbeatStep(lease.execution_id, lease.token)).toBe(false);
    await expect(repository.completeStep(lease.execution_id, lease.token)).rejects.toThrow();
    // The unwinding orchestrator's failure write must no-op, not un-cancel.
    await expect(
      repository.failStep(lease.execution_id, lease.token, "some provider failure"),
    ).resolves.toBeUndefined();
    expect((await repository.getRunDetail(runId)).status).toBe("cancelled");
  });

  it.each([
    ["waiting", "parked"],
    ["blocked", "operator_action"],
  ] as const)(
    "cancels an operator-paused %s run and its %s queue job",
    async (status, queueState) => {
      const { repository } = wiredApp();
      const run = await ingestHandoff(
        handoff(`MOB-CANCEL-${status}`) as never,
        `cancel-${status}`,
        repository,
      );
      (repository as any).runs.get(run.run_id).status = status;
      repository.queueJobs[0]!.state = queueState;
      await repository.cancelRun(run.run_id);
      expect((await repository.getRunDetail(run.run_id)).status).toBe("cancelled");
      expect(repository.queueJobs[0]?.state).toBe("cancelled");
    },
  );

  it("refuses to cancel a run that is not running", async () => {
    const { repository, app } = wiredApp();
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "cancel-test-2")
      .send(handoff("MOB-CANCEL-2"));
    const runId = created.body.run_id as string;
    await repository.claimStep(runId, "automated_checks", "test-worker");
    // First stop while running succeeds.
    const first = await request(app)
      .post(`/api/runs/${runId}/cancel`)
      .set("Idempotency-Key", `cancel-first-${runId}`);
    expect(first.status).toBe(202);
    // A second stop on the now-cancelled run conflicts.
    const second = await request(app)
      .post(`/api/runs/${runId}/cancel`)
      .set("Idempotency-Key", `cancel-second-${runId}`);
    expect(second.status).toBe(409);
    // Unknown runs 404.
    const missing = await request(app)
      .post("/api/runs/00000000-0000-4000-8000-000000000000/cancel")
      .set("Idempotency-Key", "cancel-missing-run");
    expect(missing.status).toBe(404);
  });

  it("repo cancelRun is idempotent-hostile: second cancel conflicts", async () => {
    const { repository, app } = wiredApp();
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "cancel-test-3")
      .send(handoff("MOB-CANCEL-3"));
    const runId = created.body.run_id as string;
    await repository.claimStep(runId, "automated_checks", "test-worker");
    await repository.cancelRun(runId);
    await expect(repository.cancelRun(runId)).rejects.toThrow(ConflictError);
  });
});

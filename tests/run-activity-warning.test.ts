import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { buildRouteCommand } from "../src/server/routes/command-submission.js";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { SerpProbeWorker } from "../src/server/pipeline/serp-probe-worker.js";

const handoff = {
  plane_ticket: "MOB-DUPLICATE",
  primary_keyword: "designer chairs",
  related_keywords: ["modern chairs"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};

async function warnedRun(repository: InMemoryMilestoneRepository, key: string) {
  const submitted = await repository.submitCommand(
    buildRouteCommand({
      kind: "create_run",
      idempotency_key: key,
      body: { handoff, warnings: [] },
    }),
  );
  const worker = new SerpProbeWorker(repository, {
    provider: "test-serp",
    inspect: async () => ({ informational: 1, commercial: 3 }),
  });
  await worker.runOnce();
  return submitted.run_id;
}

describe("run warning acknowledgement and activity", () => {
  it("acknowledges a persisted warning without changing pipeline progression and survives refresh", async () => {
    const repository = new InMemoryMilestoneRepository();
    const runId = await warnedRun(repository, "warning-run-key");
    const before = await repository.getRunDetail(runId);
    const warning = before.serp_probe.warnings[0]!;
    const state = repository.runState(runId);
    const app = createApp({
      serveClient: false,
      commands: repository,
      milestoneTwo: { repository, orchestrator: { run: async () => undefined } as never },
    });

    const accepted = await request(app)
      .post(`/api/runs/${runId}/warnings/${encodeURIComponent(warning.warning_id)}/acknowledge`)
      .set("Idempotency-Key", "warning-ack-key")
      .expect(202);
    expect(accepted.body).toMatchObject({ run_id: runId, result: { acknowledged: true } });
    expect(repository.runState(runId)).toEqual(state);

    const refreshed = await request(app).get(`/api/runs/${runId}`).expect(200);
    expect(refreshed.body.serp_probe.warnings[0]).toMatchObject({
      warning_id: warning.warning_id,
      acknowledged: true,
      acknowledged_at: expect.any(String),
    });
    expect(refreshed.body.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "warning_recorded" }),
        expect.objectContaining({ type: "warning_acknowledged" }),
      ]),
    );
  });

  it("keeps duplicate Plane tickets separate by exact created run identity", async () => {
    const repository = new InMemoryMilestoneRepository();
    const first = await warnedRun(repository, "duplicate-run-one");
    const second = await warnedRun(repository, "duplicate-run-two");
    expect(first).not.toBe(second);
    expect((await repository.getRunDetail(first)).run_id).toBe(first);
    expect((await repository.getRunDetail(second)).run_id).toBe(second);
  });

  it("serves the ordered durable activity projection", async () => {
    const repository = new InMemoryMilestoneRepository();
    const runId = await warnedRun(repository, "activity-run-key");
    const app = createApp({
      serveClient: false,
      commands: repository,
      milestoneTwo: { repository, orchestrator: { run: async () => undefined } as never },
    });
    const response = await request(app).get(`/api/runs/${runId}/activity`).expect(200);
    expect(response.body.activity.length).toBeGreaterThan(0);
    expect(response.body.activity.map((item: { sequence: number }) => item.sequence)).toEqual(
      response.body.activity.map((_: unknown, index: number) => index + 1),
    );
  });
});

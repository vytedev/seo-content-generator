import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { createIngestService } from "../src/server/routes/ingest-routes.js";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog",
  word_count_target: 1200,
  locales_for_translation: [],
};

describe("S5 command-only pipeline routes", () => {
  it("returns durable 202 identity and replays ingest without duplicate queue work", async () => {
    const repository = new InMemoryMilestoneRepository();
    const app = createApp({
      serveClient: false,
      ingestService: createIngestService(repository),
      commands: repository,
    });
    const first = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "s5-create-command")
      .send(handoff)
      .expect(202);
    const replay = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "s5-create-command")
      .send(handoff)
      .expect(202);
    expect(first.body).toMatchObject({ replayed: false, queue_accepted: true });
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(replay.body.run_id).toBe(first.body.run_id);
    expect(repository.commands).toHaveLength(2);
    expect(repository.queueJobs).toHaveLength(1);
  });

  it("does not call orchestrators in normal composition and exceptional replay is observational", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await repository.createIngest("s5-seed", "a".repeat(64), handoff as never, []);
    repository.queueJobs.splice(0);
    vi.spyOn(repository, "authoriseExceptionalCorrection").mockResolvedValue("authorised");
    const orchestrator = { run: vi.fn() };
    const app = createApp({
      serveClient: false,
      commands: repository,
      milestoneFour: { repository, orchestrator: orchestrator as never },
    });
    const body = { explicit_confirmation: true, idempotency_key: "s5-exceptional-key" };
    const first = await request(app)
      .post(`/api/runs/${run.run_id}/exceptional-correction/authorise`)
      .send(body)
      .expect(202);
    const replay = await request(app)
      .post(`/api/runs/${run.run_id}/exceptional-correction/authorise`)
      .send(body)
      .expect(202);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(repository.commands).toHaveLength(1);
    expect(repository.queueJobs).toHaveLength(1);
    expect(orchestrator.run).not.toHaveBeenCalled();
  });
});

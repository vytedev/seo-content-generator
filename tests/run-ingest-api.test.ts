import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { createIngestService } from "../src/server/routes/ingest-routes.js";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import {
  MilestoneTwoOrchestrator,
  MockLinkDiscoverer,
  type LinkDiscoverer,
} from "../src/server/pipeline/milestone-two.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { RepositoryConflictError } from "../src/shared/errors.js";

const handoff = {
  plane_ticket: "MOB-123",
  primary_keyword: "designer chairs",
  related_keywords: ["modern chairs"],
  page_type: "blog",
  word_count_target: 900,
  locales_for_translation: [],
  client_insights: "Prioritise compact homes.",
};

const app = () => {
  const repository = new InMemoryMilestoneRepository();
  return {
    repository,
    app: createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(repository),
    }),
  };
};

describe("POST /api/runs", () => {
  it("creates and identically replays ingest without running milestone two when unwired", async () => {
    const setup = app();
    const first = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "run-key-123")
      .send(handoff);
    const replay = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "run-key-123")
      .send(handoff);
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/api/runs/${first.body.run_id}`);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(setup.repository.runState(first.body.run_id)).toEqual({
      status: "running",
      current_step: "internal_link_discovery",
    });
  });

  it("returns safe 400 paths and 409 idempotency conflicts", async () => {
    const setup = app();
    expect((await request(setup.app).post("/api/runs").send(handoff)).status).toBe(400);
    const invalid = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "valid-key")
      .send({ ...handoff, unknown: "do-not-echo" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details[0].path).toBe("unknown");
    expect(JSON.stringify(invalid.body)).not.toContain("do-not-echo");
    await request(setup.app).post("/api/runs").set("Idempotency-Key", "conflict-key").send(handoff);
    const conflict = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "conflict-key")
      .send({ ...handoff, word_count_target: 901 });
    expect(conflict.status).toBe(409);
  });

  it("maps typed repository conflicts without message matching", async () => {
    const typedConflict = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: {
        ingest: async () => {
          throw new RepositoryConflictError("a deliberately unrelated message");
        },
      },
    });
    const response = await request(typedConflict)
      .post("/api/runs")
      .set("Idempotency-Key", "typed-conflict")
      .send(handoff);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("maps bounded PostgreSQL unavailability to a redacted 503", async () => {
    const unavailableStore: InMemoryMilestoneRepository = new InMemoryMilestoneRepository();
    unavailableStore.findIngest = async () => {
      throw Object.assign(new Error("secret host detail"), { code: "08006" });
    };
    const response = await request(
      createApp({
        testOnlySynchronousPipeline: true,
        ingestService: createIngestService(unavailableStore),
      }),
    )
      .post("/api/runs")
      .set("Idempotency-Key", "unavailable-key")
      .send(handoff);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("retains JSON payload cap and redacts unexpected failures", async () => {
    const oversized = await request(app().app)
      .post("/api/runs")
      .set("Idempotency-Key", "large-key")
      .send({ data: "x".repeat(110_000) });
    expect(oversized.status).toBe(413);
    const broken = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: {
        ingest: async () => {
          throw new Error("secret database detail");
        },
      },
    });
    const response = await request(broken)
      .post("/api/runs")
      .set("Idempotency-Key", "broken-key")
      .send(handoff);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});

const fixtureLinks = [
  {
    url: "https://www.mobelaris.com/blogs/furniture-guides",
    title: "Mobelaris furniture guides",
    relevance: 0.9,
  },
];

function wiredApp(discoverer?: LinkDiscoverer) {
  const repository = new InMemoryMilestoneRepository();
  const provider = new MockDraftProvider("mock-draft-2025-01");
  const orchestrator = new MilestoneTwoOrchestrator(
    repository,
    discoverer ?? new MockLinkDiscoverer(fixtureLinks),
    provider,
  );
  return {
    repository,
    provider,
    app: createApp({
      testOnlySynchronousPipeline: true,
      serveClient: false,
      ingestService: createIngestService(repository),
      milestoneTwo: { repository, orchestrator },
    }),
  };
}

describe("POST /api/runs with milestone two wired", () => {
  it("auto-runs steps 1.2 and 1.3 exactly once and replays without re-running providers", async () => {
    const setup = wiredApp();
    const first = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "auto-run-key")
      .send(handoff);
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/api/runs/${first.body.run_id}`);
    expect(setup.repository.runState(first.body.run_id)).toEqual({
      status: "running",
      current_step: "automated_checks",
    });
    expect(await setup.repository.getDraft(first.body.run_id)).not.toBeNull();
    expect(await setup.repository.getLinks(first.body.run_id)).toEqual(fixtureLinks);
    expect(setup.provider.calls).toHaveLength(1);

    const replay = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "auto-run-key")
      .send(handoff);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(setup.provider.calls).toHaveLength(1);
    expect(setup.repository.runState(first.body.run_id)).toEqual({
      status: "running",
      current_step: "automated_checks",
    });
  });

  it("keeps the 201 ingest contract when the orchestrator fails, persisting a redacted retryable failure", async () => {
    const setup = wiredApp({
      discover: async () => {
        throw new Error("secret provider payload detail");
      },
    });
    const response = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "failing-key")
      .send(handoff);
    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/api/runs/${response.body.run_id}`);
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(setup.repository.runState(response.body.run_id)).toEqual({
      status: "retryable_failed",
      current_step: "internal_link_discovery",
    });
  });

  it("recovers a retryable failure through the milestone-two resume route", async () => {
    let calls = 0;
    const flaky: LinkDiscoverer = {
      discover: async (keyword) => {
        calls += 1;
        if (calls === 1) throw new Error("transient provider failure");
        return new MockLinkDiscoverer(fixtureLinks).discover(keyword);
      },
    };
    const setup = wiredApp(flaky);
    const created = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "resume-key")
      .send(handoff);
    expect(created.status).toBe(201);
    const runId = created.body.run_id;

    const resumed = await request(setup.app).post(`/api/runs/${runId}/milestone-two/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      run_id: runId,
      status: "running",
      current_step: "automated_checks",
      current_document: { draft: expect.any(Object) },
    });
    expect(setup.provider.calls).toHaveLength(1);

    const rerun = await request(setup.app).post(`/api/runs/${runId}/milestone-two/resume`);
    expect(rerun.status).toBe(200);
    expect(setup.provider.calls).toHaveLength(1);
  });

  it("records refresh=true through the route while an active job keeps its exact options", async () => {
    const setup = wiredApp();
    const created = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "route-refresh-key")
      .send(handoff);
    const queueApp = createApp({
      testOnlySynchronousPipeline: true,
      serveClient: false,
      milestoneTwo: { repository: setup.repository, orchestrator: {} as never },
      queue: setup.repository,
    });
    const job = setup.repository.queueJobs[0]!;
    job.state = "leased";
    job.token = "active-token";
    job.expiresAt = Date.now() + 30_000;
    job.options = {};
    const response = await request(queueApp)
      .post(`/api/runs/${created.body.run_id}/milestone-two/resume`)
      .send({ refresh_link_discovery: true });
    expect(response.status).toBe(200);
    expect(job.options).toEqual({});
    expect(job.pendingRefresh).toBe(true);
    expect(job.pendingOptions).toEqual({});
  });

  it("serves run detail and reports unknown runs", async () => {
    const setup = wiredApp();
    const created = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "detail-key")
      .send(handoff);
    const runId = created.body.run_id;
    expect((await request(setup.app).get(`/api/runs/${runId}`)).status).toBe(200);
    expect((await request(setup.app).get(`/api/runs/${runId}/costs`)).body).toMatchObject({
      cost_micros: expect.any(Number),
    });
    const missing = await request(setup.app).post("/api/runs/missing-run/milestone-two/resume");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});

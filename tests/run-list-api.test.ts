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

/** A strictly increasing clock keeps list ordering deterministic regardless of real timing. */
function incrementingClock() {
  let tick = 0;
  return () => {
    tick += 1;
    return tick;
  };
}

function wiredApp() {
  const repository = new InMemoryMilestoneRepository(60_000, incrementingClock());
  const orchestrator = new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([]),
    new MockDraftProvider("mock-draft-2025-01"),
  );
  return {
    repository,
    app: createApp({
      serveClient: false,
      ingestService: createIngestService(repository),
      milestoneTwo: { repository, orchestrator },
    }),
  };
}

function handoff(primaryKeyword: string, planeTicket: string) {
  return {
    plane_ticket: planeTicket,
    primary_keyword: primaryKeyword,
    related_keywords: ["seating"],
    page_type: "blog",
    word_count_target: 900,
    locales_for_translation: [],
  };
}

describe("GET /api/runs", () => {
  it("lists runs newest first with a plain summary shape and pagination", async () => {
    const setup = wiredApp();
    const first = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "list-key-1")
      .send(handoff("wishbone chair", "MOB-001"));
    const second = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "list-key-2")
      .send(handoff("dining chairs", "MOB-002"));

    const response = await request(setup.app).get("/api/runs");
    expect(response.status).toBe(200);
    expect(response.body.runs).toHaveLength(2);
    expect(response.body.runs[0]).toMatchObject({
      run_id: second.body.run_id,
      plane_ticket: "MOB-002",
      primary_keyword: "dining chairs",
      status: "running",
    });
    expect(response.body.runs[1]).toMatchObject({
      run_id: first.body.run_id,
      plane_ticket: "MOB-001",
      primary_keyword: "wishbone chair",
    });
    expect(typeof response.body.runs[0].created_at).toBe("string");
    expect(typeof response.body.runs[0].updated_at).toBe("string");
    expect(response.body).toMatchObject({
      filter: "all",
      pagination: {
        page: 1,
        limit: 10,
        total_items: 2,
        total_pages: 1,
        has_previous: false,
        has_next: false,
      },
    });
  });

  it("rejects malformed page, limit and filter values rather than defaulting", async () => {
    const setup = wiredApp();
    await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "reject-key")
      .send(handoff("keyword", "MOB-R"));

    for (const query of [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=not-a-number",
      "limit=0",
      "limit=not-a-number",
      // Above the documented maximum: silently clamping would return a
      // different page from the one that was asked for.
      "limit=51",
      "filter=everything",
      "filter=",
    ]) {
      const response = await request(setup.app).get(`/api/runs?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code, query).toBe("INVALID_INPUT");
    }
  });

  it("pages through history with a stable order and honest pagination", async () => {
    const setup = wiredApp();
    for (let index = 0; index < 5; index += 1) {
      await request(setup.app)
        .post("/api/runs")
        .set("Idempotency-Key", `page-key-${index}`)
        .send(handoff(`keyword ${index}`, `MOB-P${index}`));
    }

    const firstPage = await request(setup.app).get("/api/runs?page=1&limit=2");
    expect(firstPage.body.runs.map((run: { plane_ticket: string }) => run.plane_ticket)).toEqual([
      "MOB-P4",
      "MOB-P3",
    ]);
    expect(firstPage.body.pagination).toMatchObject({
      page: 1,
      total_items: 5,
      total_pages: 3,
      has_previous: false,
      has_next: true,
    });

    const lastPage = await request(setup.app).get("/api/runs?page=3&limit=2");
    expect(lastPage.body.runs.map((run: { plane_ticket: string }) => run.plane_ticket)).toEqual([
      "MOB-P0",
    ]);
    expect(lastPage.body.pagination).toMatchObject({ has_previous: true, has_next: false });

    // Every page together is every run, with nothing repeated or dropped.
    const middlePage = await request(setup.app).get("/api/runs?page=2&limit=2");
    const seen = [...firstPage.body.runs, ...middlePage.body.runs, ...lastPage.body.runs].map(
      (run: { run_id: string }) => run.run_id,
    );
    expect(new Set(seen).size).toBe(5);
  });

  it("returns an empty page beyond the last one rather than failing", async () => {
    const setup = wiredApp();
    await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "beyond-key")
      .send(handoff("keyword", "MOB-B"));

    const response = await request(setup.app).get("/api/runs?page=9&limit=10");
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([]);
    expect(response.body.pagination).toMatchObject({
      page: 9,
      total_items: 1,
      total_pages: 1,
      has_previous: true,
      has_next: false,
    });
  });

  it("filters by status group in the query, not in the browser", async () => {
    const setup = wiredApp();
    const kept = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "filter-key-1")
      .send(handoff("kept keyword", "MOB-F1"));
    const dropped = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "filter-key-2")
      .send(handoff("cancelled keyword", "MOB-F2"));
    await setup.repository.cancelRun(dropped.body.run_id);

    const cancelled = await request(setup.app).get("/api/runs?filter=cancelled");
    expect(cancelled.body.runs.map((run: { run_id: string }) => run.run_id)).toEqual([
      dropped.body.run_id,
    ]);
    expect(cancelled.body).toMatchObject({ filter: "cancelled" });
    expect(cancelled.body.pagination.total_items).toBe(1);

    const inProgress = await request(setup.app).get("/api/runs?filter=in_progress");
    expect(inProgress.body.runs.map((run: { run_id: string }) => run.run_id)).toEqual([
      kept.body.run_id,
    ]);

    // Counts are of matching rows, never of the whole table.
    const finished = await request(setup.app).get("/api/runs?filter=finished");
    expect(finished.body.runs).toEqual([]);
    expect(finished.body.pagination).toMatchObject({ total_items: 0, total_pages: 0 });

    const all = await request(setup.app).get("/api/runs?filter=all");
    expect(all.body.pagination.total_items).toBe(2);
  });

  it("returns an empty list rather than an error when no runs exist", async () => {
    const setup = wiredApp();
    const response = await request(setup.app).get("/api/runs");
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([]);
    expect(response.body.pagination).toMatchObject({ total_items: 0, total_pages: 0 });
  });
});

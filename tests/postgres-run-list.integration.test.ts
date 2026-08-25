import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import {
  RUN_LIST_FILTERS,
  RUN_LIST_FILTER_STATUSES,
  type RunListFilter,
} from "../src/shared/contracts/run-list.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

/**
 * Rows are inserted directly so creation times — including a deliberate tie —
 * are exact. Filtering, counting and paging must all happen in SQL, which only
 * a real database can prove.
 */
async function insertRun(input: {
  id: string;
  ticket: string;
  keyword: string;
  status: string;
  createdAt: string;
}) {
  // The runs table enforces its own invariants: only a queued run may have no
  // current step, and a succeeded run must sit at the final step.
  const currentStep =
    input.status === "queued"
      ? null
      : input.status === "succeeded"
        ? "final_coherence_export"
        : "draft";
  await pool!.query(
    `insert into runs(id,idempotency_key,input_hash,plane_ticket,handoff,status,current_step,created_at,updated_at)
     values($1,$2,$3,$4,$5::jsonb,$6::run_status,$8::pipeline_step,$7,$7)`,
    [
      input.id,
      `key-${input.id}`,
      "a".repeat(64),
      input.ticket,
      JSON.stringify({
        plane_ticket: input.ticket,
        primary_keyword: input.keyword,
        related_keywords: [],
        page_type: "blog",
        word_count_target: 900,
        locales_for_translation: [],
      }),
      input.status,
      input.createdAt,
      currentStep,
    ],
  );
}

const uuid = (suffix: string) => `00000000-0000-4000-8000-0000000${suffix}`;

integration("PostgreSQL run list paging", () => {
  const repository = () => new PostgresMilestoneRepository(pool!);

  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
  });
  afterAll(async () => pool?.end());

  it("filters, counts and pages entirely in SQL", async () => {
    const statuses: Array<[string, string]> = [
      ["waiting", "10001"],
      ["retryable_failed", "10002"],
      ["blocked", "10003"],
      ["queued", "10004"],
      ["running", "10005"],
      ["succeeded", "10006"],
      ["cancelled", "10007"],
    ];
    for (const [index, [status, suffix]] of statuses.entries())
      await insertRun({
        id: uuid(suffix),
        ticket: `MOB-${suffix}`,
        keyword: `keyword ${status}`,
        status,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      });

    const expected: Record<RunListFilter, number> = {
      all: 7,
      needs_attention: 3,
      in_progress: 2,
      finished: 1,
      cancelled: 1,
    };
    for (const filter of RUN_LIST_FILTERS) {
      const result = await repository().listRunPage({ page: 1, limit: 10, filter });
      expect(result.filter, filter).toBe(filter);
      expect(result.pagination.total_items, filter).toBe(expected[filter]);
      expect(result.runs.length, filter).toBe(expected[filter]);
    }

    // The count is of matching rows, never of the whole table.
    const attention = await repository().listRunPage({
      page: 1,
      limit: 2,
      filter: "needs_attention",
    });
    expect(attention.runs).toHaveLength(2);
    expect(attention.pagination).toMatchObject({
      total_items: 3,
      total_pages: 2,
      has_previous: false,
      has_next: true,
    });
  });

  it("orders by creation time with an id tie-breaker so pages never overlap", async () => {
    // Same instant: without the id tie-breaker these could swap between pages
    // and silently hide a run.
    const sameInstant = "2026-02-01T00:00:00.000Z";
    for (const suffix of ["20001", "20002", "20003", "20004"])
      await insertRun({
        id: uuid(suffix),
        ticket: `MOB-${suffix}`,
        keyword: "tied keyword",
        status: "running",
        createdAt: sameInstant,
      });

    const first = await repository().listRunPage({ page: 1, limit: 2, filter: "all" });
    const second = await repository().listRunPage({ page: 2, limit: 2, filter: "all" });
    const ids = [...first.runs, ...second.runs].map((run) => run.run_id);
    expect(new Set(ids).size).toBe(4);
    // Descending id within the same creation time.
    expect(ids).toEqual([uuid("20004"), uuid("20003"), uuid("20002"), uuid("20001")]);

    // Repeating a page returns exactly the same rows.
    const repeated = await repository().listRunPage({ page: 1, limit: 2, filter: "all" });
    expect(repeated.runs.map((run) => run.run_id)).toEqual(first.runs.map((run) => run.run_id));
  });

  it("returns an empty page beyond the last one", async () => {
    await insertRun({
      id: uuid("30001"),
      ticket: "MOB-30001",
      keyword: "only run",
      status: "succeeded",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    const result = await repository().listRunPage({ page: 5, limit: 10, filter: "all" });
    expect(result.runs).toEqual([]);
    expect(result.pagination).toMatchObject({
      page: 5,
      total_items: 1,
      total_pages: 1,
      has_previous: true,
      has_next: false,
    });
  });

  it("returns only statuses the shared filter definition selects", async () => {
    const rows: Array<[string, string]> = [
      ["waiting", "40001"],
      ["retryable_failed", "40002"],
      ["blocked", "40003"],
      ["queued", "40004"],
      ["running", "40005"],
      ["succeeded", "40006"],
      ["cancelled", "40007"],
    ];
    for (const [index, [status, suffix]] of rows.entries())
      await insertRun({
        id: uuid(suffix),
        ticket: `MOB-${suffix}`,
        keyword: `keyword ${suffix}`,
        status,
        createdAt: new Date(Date.UTC(2026, 3, index + 1)).toISOString(),
      });

    // The API, the SQL and the table all read the same mapping, so the rows a
    // filter returns must be exactly the statuses it names — no more, no fewer.
    for (const filter of RUN_LIST_FILTERS) {
      const allowed = new Set<string>(RUN_LIST_FILTER_STATUSES[filter]);
      const result = await repository().listRunPage({ page: 1, limit: 50, filter });
      expect(new Set(result.runs.map((run) => run.status)), filter).toEqual(
        new Set(rows.map(([status]) => status).filter((status) => allowed.has(status))),
      );
      expect(result.pagination.total_items, filter).toBe(
        rows.filter(([status]) => allowed.has(status)).length,
      );
    }
  });
});

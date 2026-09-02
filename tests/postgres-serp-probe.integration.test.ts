import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import { SerpProbeWorker } from "../src/server/pipeline/serp-probe-worker.js";
import { buildRouteCommand } from "../src/server/routes/command-submission.js";
import { ConfiguredSerpProbe } from "../src/server/providers/serp-probe.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

integration("PostgreSQL auxiliary SERP probe", () => {
  const repository = pool ? new PostgresMilestoneRepository(pool) : null;
  beforeEach(async () => resetPostgresFixtures(pool!));
  afterAll(async () => pool?.end());

  async function createRun(key: string) {
    return repository!.submitCommand(
      buildRouteCommand({
        kind: "create_run",
        idempotency_key: key,
        body: { handoff, warnings: [] },
      }),
    );
  }

  it("persists immutable warning-only evidence and never re-probes", async () => {
    const run = await createRun("pg-serp-mismatch");
    const inspect = vi.fn(async () => ({ informational: 1, commercial: 4 }));
    const worker = new SerpProbeWorker(repository!, { provider: "test-serp", inspect });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(inspect).toHaveBeenCalledOnce();
    const detail = await repository!.getRunDetail(run.run_id);
    expect(detail.serp_probe).toMatchObject({
      status: "mismatch",
      warning: { code: "serp_composition_mismatch" },
      evidence: { handoff_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(detail.blocked_for_operator).toBe(false);
    expect((await pool!.query("select count(*)::int count from serp_evidence")).rows[0].count).toBe(
      1,
    );
  });

  it.each([
    ["oversized", "x".repeat(2048)],
    ["malformed", "{"],
  ])("persists %s response bodies as warning-only failures", async (_case, body) => {
    const run = await createRun(`pg-serp-${_case}`);
    const fetcher = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const probe = new ConfiguredSerpProbe(
      {
        enabled: "true",
        endpoint: "https://serp.test/probe",
        token: "test-token",
        provider: "test-serp",
        timeout_ms: 1000,
        max_response_bytes: 1024,
      },
      fetcher as typeof fetch,
    );
    await new SerpProbeWorker(repository!, probe).runOnce();
    expect((await repository!.getRunDetail(run.run_id)).serp_probe).toMatchObject({
      status: "failed",
      warning: { code: "serp_probe_failed" },
    });
  });

  it("rejects hash mismatch, conflicting replay and stale or unclaimed completion", async () => {
    const run = await createRun("pg-serp-completion-fencing");
    const work = (await repository!.claimNextSerpWork("test-worker", 1000))!;
    const evidence = {
      evidence_id: "serp-pg-test",
      handoff_hash: work.handoff_hash,
      provider: "test-serp",
      query: handoff.primary_keyword,
      retrieved_at: "2026-01-01T00:00:00.000Z",
      status: "matched" as const,
      composition: { informational: 1, commercial: 0 },
      failure_reason: null,
    };
    await expect(
      repository!.recordSerpEvidence(work, { ...evidence, handoff_hash: "f".repeat(64) }),
    ).rejects.toThrow(/handoff hash mismatch/);
    await expect(
      repository!.recordSerpEvidence({ ...work, command_id: "stale-command" }, evidence),
    ).rejects.toThrow(/command identity mismatch/);
    await expect(
      repository!.recordSerpEvidence(
        { ...work, lease_token: "00000000-0000-4000-8000-000000000099" },
        evidence,
      ),
    ).rejects.toThrow(/matching lease fence/);
    await expect(
      repository!.recordSerpEvidence(
        { ...work, run_id: "00000000-0000-4000-8000-000000000999" },
        evidence,
      ),
    ).rejects.toThrow(/command identity mismatch/);
    await repository!.recordSerpEvidence(work, evidence);
    await repository!.recordSerpEvidence(work, evidence);
    await expect(
      repository!.recordSerpEvidence(work, {
        ...evidence,
        composition: { informational: 2, commercial: 0 },
      }),
    ).rejects.toThrow(/Immutable SERP evidence conflict/);
    expect((await repository!.getRunDetail(run.run_id)).serp_probe.status).toBe("matched");

    const unclaimedRun = await createRun("pg-serp-unclaimed");
    const row = (
      await pool!.query<{ command_id: string; handoff_hash: string }>(
        `select command_id,payload->>'handoff_hash' handoff_hash from run_command_outbox
          where run_id=$1 and kind='probe_serp'`,
        [unclaimedRun.run_id],
      )
    ).rows[0]!;
    await expect(
      repository!.recordSerpEvidence(
        {
          run_id: unclaimedRun.run_id,
          handoff_hash: row.handoff_hash,
          command_id: row.command_id,
          mode: "dispatch",
          lease_owner: "unclaimed-worker",
          lease_token: "00000000-0000-4000-8000-000000000001",
          lease_expires_at: "2026-01-01T00:00:01.000Z",
        },
        { ...evidence, evidence_id: "serp-unclaimed", handoff_hash: row.handoff_hash },
      ),
    ).rejects.toThrow(/matching lease fence/);
    expect(
      (
        await pool!.query("select count(*)::int count from serp_evidence where run_id=$1", [
          unclaimedRun.run_id,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("atomically grants one concurrent claim and fences heartbeat takeover", async () => {
    await createRun("pg-serp-concurrent");
    const [a, b] = await Promise.all([
      repository!.claimNextSerpWork("worker-a", 1000),
      repository!.claimNextSerpWork("worker-b", 1000),
    ]);
    const first = a ?? b;
    expect(first).not.toBeNull();
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await repository!.heartbeatSerpWork(first!, 1000);
    expect(await repository!.claimNextSerpWork("worker-c", 1000)).toBeNull();
    await pool!.query(
      "update run_command_outbox set lease_expires_at=clock_timestamp()-interval '1 second' where command_id=$1",
      [first!.command_id],
    );
    const takeover = await repository!.claimNextSerpWork("worker-c", 1000);
    expect(takeover).toMatchObject({ mode: "recover_without_dispatch", lease_owner: "worker-c" });
    await expect(repository!.heartbeatSerpWork(first!, 1000)).rejects.toThrow(/fencing/);
  });

  it("waits for lease expiry, then fails closed without redispatch", async () => {
    const run = await createRun("pg-serp-restart");
    const reserved = await repository!.claimNextSerpWork("first-worker", 1000);
    expect(reserved?.mode).toBe("dispatch");
    expect(await repository!.claimNextSerpWork("second-worker", 1000)).toBeNull();
    await pool!.query(
      "update run_command_outbox set lease_expires_at=clock_timestamp()-interval '1 second' where command_id=$1",
      [reserved!.command_id],
    );
    const inspect = vi.fn(async () => ({ informational: 3, commercial: 0 }));
    const restarted = new SerpProbeWorker(
      repository!,
      { provider: "test-serp", inspect },
      "second-worker",
      1000,
    );
    expect(await restarted.runOnce()).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    expect((await repository!.getRunDetail(run.run_id)).serp_probe).toMatchObject({
      status: "failed",
      warning: { code: "serp_probe_failed" },
    });
  });
});

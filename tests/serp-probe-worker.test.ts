import { describe, expect, it, vi } from "vitest";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { SerpProbeWorker } from "../src/server/pipeline/serp-probe-worker.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { buildRouteCommand } from "../src/server/routes/command-submission.js";
import { ConfiguredSerpProbe } from "../src/server/providers/serp-probe.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: ["designer chairs"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

async function setup() {
  const repository = new InMemoryMilestoneRepository();
  const result = await repository.submitCommand(
    buildRouteCommand({
      kind: "create_run",
      idempotency_key: `serp-${Math.random()}`,
      body: { handoff, warnings: [] },
    }),
  );
  return { repository, runId: result.run_id };
}

describe("auxiliary SERP probe worker", () => {
  it("persists mismatch evidence once without blocking pipeline state", async () => {
    const { repository, runId } = await setup();
    const inspect = vi.fn(async () => ({ informational: 1, commercial: 3 }));
    const worker = new SerpProbeWorker(repository, { provider: "test-serp", inspect });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(inspect).toHaveBeenCalledOnce();
    const detail = await repository.getRunDetail(runId);
    expect(detail.serp_probe).toMatchObject({
      status: "mismatch",
      warning: { code: "serp_composition_mismatch" },
      evidence: { provider: "test-serp", composition: { informational: 1, commercial: 3 } },
    });
    expect(detail.blocked_for_operator).toBe(false);
  });

  it("records malformed/no-results failures as warnings and never retries", async () => {
    for (const outcome of ["malformed", "empty"] as const) {
      const { repository, runId } = await setup();
      const inspect = vi.fn(async () =>
        outcome === "empty" ? null : ({ informational: -1, commercial: 0 } as any),
      );
      const worker = new SerpProbeWorker(repository, { provider: "test-serp", inspect });
      await worker.runOnce();
      await worker.runOnce();
      expect(inspect).toHaveBeenCalledOnce();
      const probe = (await repository.getRunDetail(runId)).serp_probe;
      expect(probe.status).toBe(outcome === "empty" ? "no_results" : "failed");
      expect(probe.warning?.code).toBe("serp_probe_failed");
    }
  });

  it("fails closed after an expired restart claim without repeating an uncertain call", async () => {
    let now = 1_000;
    const repository = new InMemoryMilestoneRepository(300_000, () => now);
    const result = await repository.submitCommand(
      buildRouteCommand({
        kind: "create_run",
        idempotency_key: "serp-restart-expiry",
        body: { handoff, warnings: [] },
      }),
    );
    const work = await repository.claimNextSerpWork("first-worker", 1000);
    expect(work?.mode).toBe("dispatch");
    now += 1001;
    const inspect = vi.fn(async () => ({ informational: 2, commercial: 1 }));
    const restarted = new SerpProbeWorker(
      repository,
      { provider: "test-serp", inspect },
      "second-worker",
      1000,
    );
    expect(await restarted.runOnce()).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    expect((await repository.getRunDetail(result.run_id)).serp_probe).toMatchObject({
      status: "failed",
      warning: { code: "serp_probe_failed" },
    });
  });

  it("fences concurrent claims, heartbeats and stale tokens", async () => {
    let now = 1_000;
    const repository = new InMemoryMilestoneRepository(300_000, () => now);
    await repository.submitCommand(
      buildRouteCommand({
        kind: "create_run",
        idempotency_key: "serp-memory-fencing",
        body: { handoff, warnings: [] },
      }),
    );
    const first = (await repository.claimNextSerpWork("worker-a", 1000))!;
    expect(await repository.claimNextSerpWork("worker-b", 1000)).toBeNull();
    now += 500;
    await repository.heartbeatSerpWork(first, 1000);
    now += 600;
    expect(await repository.claimNextSerpWork("worker-b", 1000)).toBeNull();
    now += 401;
    const takeover = (await repository.claimNextSerpWork("worker-b", 1000))!;
    expect(takeover).toMatchObject({ mode: "recover_without_dispatch", lease_owner: "worker-b" });
    await expect(repository.heartbeatSerpWork(first, 1000)).rejects.toThrow(/fencing/);
  });

  it("persists oversized provider bodies as warning-only failures", async () => {
    const { repository, runId } = await setup();
    const fetcher = vi.fn(
      async () =>
        new Response("x".repeat(2048), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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
    await new SerpProbeWorker(repository, probe).runOnce();
    expect((await repository.getRunDetail(runId)).serp_probe).toMatchObject({
      status: "failed",
      warning: { code: "serp_probe_failed" },
    });
  });

  it("rejects mismatched evidence, conflicting replay and unclaimed completion", async () => {
    const { repository } = await setup();
    const work = (await repository.claimNextSerpWork("test-worker", 1000))!;
    const evidence = {
      evidence_id: "serp-test",
      handoff_hash: work.handoff_hash,
      provider: "test-serp",
      query: handoff.primary_keyword,
      retrieved_at: "2026-01-01T00:00:00.000Z",
      status: "matched" as const,
      composition: { informational: 1, commercial: 0 },
      failure_reason: null,
    };
    await expect(
      repository.recordSerpEvidence(work, { ...evidence, handoff_hash: "f".repeat(64) }),
    ).rejects.toThrow(/handoff hash mismatch/);
    await expect(
      repository.recordSerpEvidence({ ...work, command_id: "stale-command" }, evidence),
    ).rejects.toThrow(/command identity mismatch/);
    await expect(
      repository.recordSerpEvidence(
        { ...work, lease_token: "00000000-0000-4000-8000-000000000099" },
        evidence,
      ),
    ).rejects.toThrow(/matching lease fence/);
    await expect(
      repository.recordSerpEvidence({ ...work, run_id: "stale-run" }, evidence),
    ).rejects.toThrow(/command identity mismatch/);
    await repository.recordSerpEvidence(work, evidence);
    await repository.recordSerpEvidence(work, evidence);
    await expect(
      repository.recordSerpEvidence(work, {
        ...evidence,
        composition: { informational: 2, commercial: 0 },
      }),
    ).rejects.toThrow(/Immutable SERP evidence conflict/);

    const next = await setup();
    const unclaimed = next.repository.commands.find((command) => command.kind === "probe_serp")!;
    await expect(
      next.repository.recordSerpEvidence(
        {
          run_id: unclaimed.run_id,
          handoff_hash: unclaimed.handoff_hash,
          command_id: unclaimed.command_id,
          mode: "dispatch",
          lease_owner: "unclaimed-worker",
          lease_token: "00000000-0000-4000-8000-000000000001",
          lease_expires_at: "2026-01-01T00:00:01.000Z",
        },
        { ...evidence, handoff_hash: unclaimed.handoff_hash },
      ),
    ).rejects.toThrow(/matching lease fence/);
  });

  it("keeps ingest free of synchronous SERP calls", async () => {
    const repository = new InMemoryMilestoneRepository();
    const inspect = vi.fn();
    await ingestHandoff(handoff, "plain-ingest", repository);
    expect(inspect).not.toHaveBeenCalled();
  });
});

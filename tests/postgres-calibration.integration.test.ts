import fs from "node:fs";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CALIBRATION_POSTS } from "../src/shared/contracts/calibration.js";
import { parseCalibrationPage } from "../src/server/providers/public-page-retriever.js";
import { PostgresCalibrationRepository } from "../src/server/repositories/calibration-repository.js";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import { PostgresCalibrationPipelineRunner } from "../src/server/services/calibration-pipeline.js";
import { CalibrationService } from "../src/server/services/calibration-service.js";
import { resetPostgresFixtures } from "./helpers/postgres-reset.js";
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const pool = url ? new pg.Pool({ connectionString: url }) : null;
integration("PostgreSQL calibration fencing", () => {
  beforeEach(async () => {
    await resetPostgresFixtures(pool!);
  });
  afterAll(async () => pool?.end());
  it("claims once, reclaims expiry, and rejects stale writes", async () => {
    const repo = new PostgresCalibrationRepository(pool!, 25);
    const run = await repo.createOrReplay("lease-test", "a".repeat(64));
    const first = await repo.claim(run.id, "one");
    expect(first).not.toBeNull();
    await expect(repo.claim(run.id, "two")).rejects.toThrow("leased");
    await new Promise((r) => setTimeout(r, 35));
    const second = await repo.claim(run.id, "two");
    await expect(repo.setState(run.id, first!, "retrieving", "created")).rejects.toThrow("stale");
    await repo.setState(run.id, second!, "retrieving", "created");
  });
  it.each(["queued", "retryable_failed"])(
    "rejects reference proposals for a %s partial run",
    async (status) => {
      const repo = new PostgresCalibrationRepository(pool!);
      const run = await repo.createOrReplay(`partial-proposal-${status}`, "e".repeat(64));
      if (status === "retryable_failed")
        await pool!.query(
          "update calibration_runs set status='retryable_failed',error='CALIBRATION_OPERATION_FAILED' where id=$1",
          [run.id],
        );
      await expect(repo.createReferenceVersions(run.id)).rejects.toThrow("not complete enough");
      const proposals = await pool!.query(
        "select count(*)::int count from calibration_reference_proposals where calibration_run_id=$1",
        [run.id],
      );
      expect(proposals.rows[0].count).toBe(0);
    },
  );
  it("enforces exact run/snapshot/slot result binding", async () => {
    const repo = new PostgresCalibrationRepository(pool!);
    const run = await repo.createOrReplay("binding-test", "b".repeat(64));
    const snapshot = parseCalibrationPage(
      CALIBRATION_POSTS[0].url,
      fs.readFileSync("tests/fixtures/calibration/barcelona.html", "utf8"),
      new Date(),
    );
    const bad = await pool!.query(
      "insert into calibration_snapshots(slot,url,canonical_url,http_status,retrieved_at,title,meta_description,published_time,article_markdown,content_hash,safe_metadata) values(2,$1,$1,200,now(),'x','x',now(),'x',$2,'{}') returning id",
      [CALIBRATION_POSTS[1].url, "c".repeat(64)],
    );
    await expect(
      pool!.query(
        "insert into calibration_results(calibration_run_id,snapshot_id,slot,result_hash,report) values($1,$2,1,$3,'{}')",
        [run.id, bad.rows[0].id, "d".repeat(64)],
      ),
    ).rejects.toThrow();
    expect(snapshot.slot).toBe(1);
  });
  it("runs each calibration post through the real twelve-step pipeline or durable blocker gate", async () => {
    const repo = new PostgresCalibrationRepository(pool!);
    const pipelineRepo = new PostgresMilestoneRepository(pool!);
    const retriever = {
      retrieve: async (url: string) =>
        parseCalibrationPage(
          url,
          fs.readFileSync(
            url === CALIBRATION_POSTS[0].url
              ? "tests/fixtures/calibration/barcelona.html"
              : "tests/fixtures/calibration/e1027.html",
            "utf8",
          ),
          new Date("2026-07-06T00:00:00Z"),
        ),
    };
    const service = new CalibrationService(
      repo,
      retriever,
      new PostgresCalibrationPipelineRunner(pool!, pipelineRepo),
    );
    const run = await service.start(`real-pipeline-${Date.now()}`);
    expect(run.status).toBe("succeeded");
    const results = await repo.getResults(run.id);
    expect(results).toHaveLength(2);
    expect(results.every((r) => ["succeeded", "blocked"].includes(r.pipeline_outcome))).toBe(true);
    expect(results[0]!.handoff.primary_keyword).not.toContain("replica vs original");
    for (const result of results) {
      const count = (
        await pool!.query(
          "select count(distinct step)::int count from step_executions where run_id=$1",
          [result.pipeline_run_id],
        )
      ).rows[0].count;
      // A succeeded run executes all twelve steps. A run held at the durable
      // blocker gate stops at automated_checks_rerun and never enters step 1.12
      // (final_coherence_export), so it records exactly eleven. Pin both cases
      // rather than accepting either count for either outcome.
      expect(count).toBe(result.pipeline_outcome === "succeeded" ? 12 : 11);
      expect(result.observations).toHaveLength(14);
      expect(result.observations.some((o) => o.classification.startsWith("true_pipeline"))).toBe(
        false,
      );
    }
  });
});

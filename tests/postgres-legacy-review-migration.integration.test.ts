import fs from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new pg.Pool({ connectionString: url }) : null;
const databaseName = `legacy_review_migration_${process.pid}_${Date.now()}`;
const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
let migratedPool: pg.Pool | null = null;

async function applyMigration(pool: pg.Pool, path: string) {
  const sql = fs.readFileSync(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim())) {
    if (statement) await pool.query(statement);
  }
}

integration("legacy review queue corrective migration", () => {
  afterAll(async () => {
    await migratedPool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${quotedDatabase} with (force)`);
      await admin.end();
    }
  });

  it("classifies every pre-0044 active state, clears leases, and prevents recovery claims", async () => {
    await admin!.query(`create database ${quotedDatabase}`);
    const migratedUrl = new URL(url!);
    migratedUrl.pathname = `/${databaseName}`;
    migratedPool = new pg.Pool({ connectionString: migratedUrl.toString() });
    for (let index = 0; index <= 42; index += 1) {
      const prefix = `${String(index).padStart(4, "0")}_`;
      const migration = fs.readdirSync("drizzle").find((entry) => entry.startsWith(prefix));
      if (!migration) throw new Error(`Missing migration ${prefix}`);
      await applyMigration(migratedPool, `drizzle/${migration}`);
    }

    const states = ["ready", "leased", "retry_wait", "parked", "operator_action"] as const;
    for (const [index, state] of states.entries()) {
      const run = await migratedPool.query<{ id: string }>(
        `insert into runs(idempotency_key,input_hash,plane_ticket,handoff,status,current_step)
         values($1,repeat($2,64),'MM03-01','{"primary_keyword":"chair"}'::jsonb,'retryable_failed','review_writing_style') returning id`,
        [`legacy-review-${state}`, String(index + 1)],
      );
      await migratedPool.query("delete from pipeline_queue_jobs where run_id=$1", [
        run.rows[0]!.id,
      ]);
      await migratedPool.query(
        `insert into pipeline_queue_jobs(run_id,state,available_at,lease_token,lease_owner,lease_expires_at)
         values($1,$2::queue_job_state,clock_timestamp()-interval '1 hour',
           case when $2::text='leased' then gen_random_uuid() end,
           case when $2::text='leased' then 'historical-worker' end,
           case when $2::text='leased' then clock_timestamp()-interval '1 minute' end)`,
        [run.rows[0]!.id, state],
      );
    }

    await applyMigration(migratedPool, "drizzle/0043_blue_the_stranger.sql");
    await applyMigration(migratedPool, "drizzle/0044_legacy_review_queue_recovery.sql");
    await applyMigration(migratedPool, "drizzle/0045_odd_forgotten_one.sql");
    await applyMigration(migratedPool, "drizzle/0046_step_1_2_refresh_isolation.sql");
    await applyMigration(migratedPool, "drizzle/0047_refresh_only_queue_pass.sql");
    await applyMigration(migratedPool, "drizzle/0048_confused_mach_iv.sql");
    const populatedThrough0048 = (await migratedPool.query("select count(*)::int count from runs"))
      .rows[0]!.count;
    await applyMigration(migratedPool, "drizzle/0049_bumpy_steel_serpent.sql");
    expect(populatedThrough0048).toBe(states.length);
    expect(
      (
        await migratedPool.query(
          `select indexname from pg_indexes
           where schemaname='public' and tablename='review_operation_adoptions'
           order by indexname`,
        )
      ).rows.map((row) => row.indexname),
    ).toEqual(
      expect.arrayContaining([
        "review_operation_adoptions_source_unique",
        "review_operation_adoptions_target_unique",
      ]),
    );
    expect(
      (
        await migratedPool.query(
          `select count(*)::int count from pg_trigger
           where tgrelid='review_operation_adoptions'::regclass and not tgisinternal`,
        )
      ).rows[0]!.count,
    ).toBe(3);
    expect(
      (
        await migratedPool.query(
          `select state,last_error_code,lease_token,lease_owner,lease_expires_at
           from pipeline_queue_jobs order by created_at`,
        )
      ).rows,
    ).toEqual(
      states.map(() => ({
        state: "operator_action",
        last_error_code: "legacy_review_explicit_recovery",
        lease_token: null,
        lease_owner: null,
        lease_expires_at: null,
      })),
    );

    const repository = new PostgresMilestoneRepository(migratedPool);
    await repository.recoverQueueJobs();
    expect(await repository.claimQueueJob("migration-test", 30_000)).toBeNull();
    expect(
      (
        await migratedPool.query(
          "select count(*)::int count from pipeline_queue_jobs where state<>'operator_action'",
        )
      ).rows[0]!.count,
    ).toBe(0);
  });
});

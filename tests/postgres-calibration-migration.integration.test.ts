import fs from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new pg.Pool({ connectionString: url }) : null;
const databaseName = `calibration_migration_${process.pid}_${Date.now()}`;
const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
let migratedPool: pg.Pool | null = null;

async function applyMigration(pool: pg.Pool, path: string) {
  const sql = fs.readFileSync(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim())) {
    if (statement) await pool.query(statement);
  }
}

integration("calibration binding migration", () => {
  afterAll(async () => {
    await migratedPool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${quotedDatabase} with (force)`);
      await admin.end();
    }
  });

  it("purges pre-0012 unbound run data, preserves its global snapshot, and rejects new null bindings", async () => {
    await admin!.query(`create database ${quotedDatabase}`);
    const migratedUrl = new URL(url!);
    migratedUrl.pathname = `/${databaseName}`;
    migratedPool = new pg.Pool({ connectionString: migratedUrl.toString() });
    for (let index = 0; index <= 11; index += 1) {
      const path = fs
        .readdirSync("drizzle")
        .find((entry) => entry.startsWith(`${String(index).padStart(4, "0")}_`));
      await applyMigration(migratedPool, `drizzle/${path}`);
    }
    const legacy = await migratedPool.query<{ run_id: string; snapshot_id: string }>(
      `with r as (
        insert into calibration_runs(idempotency_key,input_hash) values('legacy',repeat('a',64)) returning id
      ), s as (
        insert into calibration_snapshots(slot,url,canonical_url,http_status,retrieved_at,title,meta_description,published_time,article_markdown,content_hash,safe_metadata)
        values(1,'https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences','https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences',200,now(),'Legacy','Description',now(),'Legacy body',repeat('b',64),'{}') returning id
      ), rs as (
        insert into calibration_run_snapshots(calibration_run_id,snapshot_id,slot) select r.id,s.id,1 from r,s
      ) select r.id run_id,s.id snapshot_id from r,s`,
    );
    await applyMigration(migratedPool, "drizzle/0012_cooing_dark_beast.sql");
    await applyMigration(migratedPool, "drizzle/0013_calibration_binding_completion.sql");

    expect(
      Number(
        (await migratedPool.query("select count(*) count from calibration_run_snapshots")).rows[0]
          .count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await migratedPool.query("select count(*) count from calibration_snapshots where id=$1", [
            legacy.rows[0]!.snapshot_id,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
    const replacement = await migratedPool.query<{ id: string }>(
      "insert into calibration_runs(idempotency_key,input_hash) values('replacement',repeat('c',64)) returning id",
    );
    await expect(
      migratedPool.query(
        "insert into calibration_run_snapshots(calibration_run_id,snapshot_id,slot,pipeline_run_id,final_document_version_id,pipeline_outcome) values($1,$2,1,null,null,null)",
        [replacement.rows[0]!.id, legacy.rows[0]!.snapshot_id],
      ),
    ).rejects.toThrow(/null|binding/i);
  });
});

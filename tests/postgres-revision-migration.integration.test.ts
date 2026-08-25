import fs from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new pg.Pool({ connectionString: url }) : null;
const databaseName = `revision_migration_${process.pid}_${Date.now()}`;
const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
let migratedPool: pg.Pool | null = null;

async function applyMigration(pool: pg.Pool, path: string) {
  const sql = fs.readFileSync(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim())) {
    if (statement) await pool.query(statement);
  }
}

integration("revision source migration", () => {
  afterAll(async () => {
    await migratedPool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${quotedDatabase} with (force)`);
      await admin.end();
    }
  });

  it("preserves a revision-1 baseline referenced by historical no-op completion", async () => {
    await admin!.query(`create database ${quotedDatabase}`);
    const migratedUrl = new URL(url!);
    migratedUrl.pathname = `/${databaseName}`;
    migratedPool = new pg.Pool({ connectionString: migratedUrl.toString() });
    for (let index = 0; index <= 31; index += 1) {
      const prefix = `${String(index).padStart(4, "0")}_`;
      const migration = fs.readdirSync("drizzle").find((entry) => entry.startsWith(prefix));
      if (!migration) throw new Error(`Missing migration ${prefix}`);
      await applyMigration(migratedPool, `drizzle/${migration}`);
    }

    const fixture = await migratedPool.query<{ run_id: string; step_id: string }>(
      `with r as (
         insert into runs(idempotency_key,input_hash,plane_ticket,handoff,status,current_step)
         values('historical-noop',repeat('a',64),'MM03-01','{"primary_keyword":"chair"}'::jsonb,'running','revision_pass') returning id
       ), e as (
         insert into step_executions(run_id,step,attempt,status,completed_at)
         select id,'revision_pass',1,'succeeded',now() from r returning id,run_id
       ) select run_id,id step_id from e`,
    );
    const { run_id: runId, step_id: stepId } = fixture.rows[0]!;
    const artifact = await migratedPool.query<{ id: string }>(
      `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
       values($1,$2,'draft','application/json','{}',repeat('b',64),2) returning id`,
      [runId, stepId],
    );
    const version = await migratedPool.query<{ id: string }>(
      `insert into document_versions(run_id,artifact_id,revision,content_hash)
       values($1,$2,1,repeat('b',64)) returning id`,
      [runId, artifact.rows[0]!.id],
    );
    await migratedPool.query(
      `insert into revision_noop_completions(operation_id,run_id,step_execution_id,document_version_id,revision_source)
       values('historical-baseline-noop',$1,$2,$3,'operator_findings')`,
      [runId, stepId, version.rows[0]!.id],
    );

    await applyMigration(migratedPool, "drizzle/0032_pale_nico_minoru.sql");
    expect(
      (
        await migratedPool.query(
          "select revision,revision_source from document_versions where id=$1",
          [version.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ revision: 1, revision_source: null });
  });
});

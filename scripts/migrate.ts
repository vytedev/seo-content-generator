import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { z } from "zod";

const CURRENT_APPLICATION_SCHEMA_VERSION = 55;
const MIGRATION_LOCK_KEY = 0x4d4d3033;
const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  const files = (await readdir("drizzle")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(`drizzle/${name}`, "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );

  await client.query("begin");
  // Transaction-scoped lock serialises migration and adoption across all runtime replicas.
  await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  await client.query(`create table if not exists application_migrations (
    name text primary key,
    checksum text,
    applied_at timestamptz not null default clock_timestamp()
  )`);
  await client.query("alter table application_migrations add column if not exists checksum text");

  const recorded = await client.query<{ name: string; checksum: string | null }>(
    "select name, checksum from application_migrations order by name",
  );
  const expected = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const row of recorded.rows) {
    const migration = expected.get(row.name);
    if (!migration) throw new Error(`Recorded migration is absent from this image: ${row.name}`);
    if (row.checksum && row.checksum !== migration.checksum)
      throw new Error(`Migration checksum drift detected: ${row.name}`);
  }

  const markerTable = await client.query<{ present: boolean }>(
    "select to_regclass('application_schema_version') is not null as present",
  );
  const markerVersion = markerTable.rows[0]?.present
    ? ((
        await client.query<{ version: number }>(
          "select version from application_schema_version where singleton=true",
        )
      ).rows[0]?.version ?? null)
    : null;
  if (
    markerVersion !== null &&
    (markerVersion < 54 || markerVersion > CURRENT_APPLICATION_SCHEMA_VERSION)
  )
    throw new Error(`Unsupported application schema marker: ${markerVersion}`);
  const schemaAlreadyCurrent = markerVersion === CURRENT_APPLICATION_SCHEMA_VERSION;
  if (markerVersion !== null) {
    // Marker-based databases predate this runner. Adopt only migrations through
    // their proven marker, then execute later files normally.
    for (const migration of migrations.filter(
      ({ name }) => Number.parseInt(name.slice(0, 4), 10) <= markerVersion,
    )) {
      const row = recorded.rows.find((candidate) => candidate.name === migration.name);
      if (!row)
        await client.query("insert into application_migrations(name, checksum) values($1,$2)", [
          migration.name,
          migration.checksum,
        ]);
      else if (!row.checksum)
        await client.query("update application_migrations set checksum=$2 where name=$1", [
          migration.name,
          migration.checksum,
        ]);
    }
  }
  if (!schemaAlreadyCurrent) {
    for (const migration of migrations) {
      const row = recorded.rows.find((candidate) => candidate.name === migration.name);
      if (row) {
        if (!row.checksum)
          await client.query("update application_migrations set checksum=$2 where name=$1", [
            migration.name,
            migration.checksum,
          ]);
        continue;
      }
      const adoptionVersion = markerVersion ?? -1;
      if (Number.parseInt(migration.name.slice(0, 4), 10) <= adoptionVersion) continue;
      for (const statement of migration.sql
        .split("--> statement-breakpoint")
        .map((part) => part.trim()))
        if (statement) await client.query(statement);
      await client.query("insert into application_migrations(name, checksum) values($1,$2)", [
        migration.name,
        migration.checksum,
      ]);
    }
  }
  await client.query("alter table application_migrations alter column checksum set not null");
  await client.query("commit");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

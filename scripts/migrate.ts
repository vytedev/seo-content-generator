import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";

const MIGRATION_LOCK_KEY = 0x4d4d3033;
const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const client = await pool.connect();

try {
  // Keep one session-level lock for the whole Drizzle migration run. Drizzle remains
  // the sole owner of ordering, hashes, and drizzle.__drizzle_migrations metadata.
  await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  const migrationConfig = {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  } as const;
  const expected = readMigrationFiles(migrationConfig);
  const ledgerPresent = (
    await client.query<{ present: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
    )
  ).rows[0]?.present;
  if (ledgerPresent) {
    const recorded = await client.query<{ hash: string; created_at: string }>(
      "select hash,created_at from drizzle.__drizzle_migrations order by created_at",
    );
    const expectedByTimestamp = new Map(
      expected.map((migration) => [String(migration.folderMillis), migration.hash]),
    );
    for (const row of recorded.rows) {
      if (expectedByTimestamp.get(String(row.created_at)) !== row.hash)
        throw new Error(`Drizzle migration checksum drift detected at ${row.created_at}`);
    }
  }
  await migrate(drizzle(client), migrationConfig);
} finally {
  await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
  client.release();
  await pool.end();
}

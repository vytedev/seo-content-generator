import dotenv from "dotenv";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";

dotenv.config({ quiet: true });

const MIGRATION_LOCK_KEY = 0x4d4d3033;
const migrationConfig = {
  migrationsFolder: "./drizzle",
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
} as const;

async function verifyMigrationHistory(client: pg.PoolClient) {
  const ledgerPresent = (
    await client.query<{ present: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
    )
  ).rows[0]?.present;
  if (!ledgerPresent) return;

  const expectedByTimestamp = new Map(
    readMigrationFiles(migrationConfig).map((migration) => [
      String(migration.folderMillis),
      migration.hash,
    ]),
  );
  const recorded = await client.query<{ hash: string; created_at: string }>(
    "select hash,created_at from drizzle.__drizzle_migrations order by created_at",
  );
  for (const migration of recorded.rows) {
    if (expectedByTimestamp.get(String(migration.created_at)) !== migration.hash)
      throw new Error(`Drizzle migration checksum drift detected at ${migration.created_at}`);
  }
}

async function runMigrations() {
  const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const db = drizzle(client);

  try {
    // Serialise migration runs across API/worker deployments that may start together.
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await verifyMigrationHistory(client);
    await migrate(db, migrationConfig);
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error("Migration script failed:", error);
  process.exitCode = 1;
});

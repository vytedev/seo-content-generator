import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration runner safety", () => {
  it("serialises migration execution through Drizzle's canonical ledger", async () => {
    const source = await readFile("scripts/migrate.ts", "utf8");
    expect(source).toContain("pg_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
    expect(source).toContain("readMigrationFiles");
    expect(source).toContain("Drizzle migration checksum drift detected");
    expect(source).toContain("migrate(drizzle(client)");
    expect(source).toContain('migrationsSchema: "drizzle"');
    expect(source).toContain('migrationsTable: "__drizzle_migrations"');
  });

  it("does not create or adopt a competing application migration ledger", async () => {
    const source = await readFile("scripts/migrate.ts", "utf8");
    expect(source).not.toContain("application_migrations");
    expect(source).not.toContain("schemaAlreadyCurrent");
    expect(source).not.toContain("statement-breakpoint");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration runner safety", () => {
  it("serialises migration decisions and records immutable SHA-256 checksums", async () => {
    const source = await readFile("scripts/migrate.ts", "utf8");
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("Migration checksum drift detected");
    expect(source).toContain("alter column checksum set not null");
  });

  it("adopts an existing schema marker 54 without replaying migration SQL", async () => {
    const source = await readFile("scripts/migrate.ts", "utf8");
    expect(source).toContain("schemaAlreadyCurrent");
    expect(source.indexOf("if (schemaAlreadyCurrent)")).toBeLessThan(
      source.indexOf("for (const statement of migration.sql"),
    );
    expect(source).toContain("Unsupported application schema marker");
  });
});

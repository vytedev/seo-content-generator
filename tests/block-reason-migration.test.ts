import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0030_curved_lady_ursula.sql", import.meta.url),
  "utf8",
);

describe("run block reason migration", () => {
  it("adds a backwards-compatible nullable typed state with status consistency checks", () => {
    expect(migration).toContain('ALTER TABLE "runs" ADD COLUMN "block_reason" text;');
    expect(migration).toContain("'deterministic_blockers','coherence_cycle_cap'");
    expect(migration).toContain('"runs"."block_reason" is null or "runs"."status" = \'blocked\'');
    expect(migration).not.toContain("NOT NULL");
  });
});

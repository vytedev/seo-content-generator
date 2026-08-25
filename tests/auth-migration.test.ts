import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("operator sessions migration", () => {
  it("stores only a keyed token hash with explicit expiry and revocation", () => {
    const sql = readFileSync("drizzle/0018_even_winter_soldier.sql", "utf8");
    expect(sql).toContain('CREATE TABLE "operator_sessions"');
    expect(sql).toContain('"token_hash" text NOT NULL');
    expect(sql).toContain('"expires_at" timestamp with time zone NOT NULL');
    expect(sql).toContain('"revoked_at" timestamp with time zone');
    expect(sql).not.toMatch(/password|session_token|\"token\"/i);
    expect(sql).toContain("operator_sessions_immutable");
  });
});

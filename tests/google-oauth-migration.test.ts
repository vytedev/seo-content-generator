import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Google OAuth token version migration", () => {
  it("uses an identity-backed monotonic version and indexes latest-version ordering", async () => {
    const sql = await readFile("drizzle/0016_flimsy_gladiator.sql", "utf8");
    expect(sql).toContain('"version" bigint NOT NULL GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('("provider","version")');
    expect(sql).toContain('"version" > 0');
    expect(sql).toContain("google_oauth_token_versions_version_unique");
  });
});

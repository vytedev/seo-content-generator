import { describe, expect, it } from "vitest";
import fs from "node:fs";

const setup = fs.readFileSync("scripts/setup-operator-auth.ts", "utf8");

describe("operator authentication setup wizard", () => {
  it("uses hidden password confirmation and writes only derived auth configuration", () => {
    expect(setup).toContain('askHidden("Operator password');
    expect(setup).toContain('askHidden("Confirm operator password');
    expect(setup).toContain("await encodePassword(password)");
    expect(setup).toContain('randomBytes(32).toString("base64url")');
    expect(setup).toContain("writeFileSync(ENV_PATH, environment, { mode: 0o600 })");
    expect(setup).not.toMatch(/upsert\(environment,\s*["']OPERATOR_PASSWORD["']/);
    expect(setup).not.toContain("process.argv[2]");
  });
});

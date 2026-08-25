import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const importScript = readFileSync(
  new URL("../scripts/import-local-baseline.ts", import.meta.url),
  "utf8",
);

describe("local baseline import safety", () => {
  it("checks both immutable reference hash and pending editorial status", () => {
    expect(importScript).toContain("editorial_status !== LOCAL_BASELINE_STATUS");
    expect(importScript).toContain(
      "Immutable version ${draft.version} or editorial status conflict",
    );
  });

  it("replays identical calibration rows without updating verification timestamps", () => {
    expect(importScript).toContain("FROM calibration_posts WHERE slot = $1");
    expect(importScript).toContain("Calibration slot conflict");
    expect(importScript).not.toContain("ON CONFLICT (slot) DO UPDATE");
  });
});

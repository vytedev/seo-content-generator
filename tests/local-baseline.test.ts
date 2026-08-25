import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LOCAL_BASELINE_STATUS,
  PROVISIONAL_CALIBRATION_POSTS,
  PROVISIONAL_KEYWORD_CONCENTRATION_RULE,
  TASK_DERIVED_REFERENCE_DRAFTS,
} from "../src/db/index.js";

describe("MM03-01 provisional local baseline", () => {
  it("keeps all six local references pending editorial approval", () => {
    expect(LOCAL_BASELINE_STATUS).toBe("pending_editorial_approval");
    expect(TASK_DERIVED_REFERENCE_DRAFTS).toHaveLength(6);
    expect(
      TASK_DERIVED_REFERENCE_DRAFTS.every(
        ({ mayActivateLocally, productionApproved }) =>
          mayActivateLocally && productionApproved === false,
      ),
    ).toBe(true);
  });

  it("uses the approved repeated-adjective warning threshold", () => {
    expect(PROVISIONAL_KEYWORD_CONCENTRATION_RULE).toContain("Use keywords naturally");
    expect(PROVISIONAL_KEYWORD_CONCENTRATION_RULE).toContain("calibrate numeric thresholds later");
    expect(PROVISIONAL_KEYWORD_CONCENTRATION_RULE).not.toMatch(/\b\d+(?:\.\d+)?%/);

    const keywordDraft = readFileSync(
      new URL("../references/drafts/keyword-placement-guidelines.md", import.meta.url),
      "utf8",
    );
    expect(keywordDraft).toContain("four or more uses per 1,000 prose words");
  });

  it("records the two exact provisional calibration posts", () => {
    expect(PROVISIONAL_CALIBRATION_POSTS).toEqual([
      expect.objectContaining({
        slot: 1,
        canonicalUrl:
          "https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences",
        title: "Barcelona Chair Replica vs Original: 2026 Guide",
        httpStatus: 200,
        status: "provisional_local",
      }),
      expect.objectContaining({
        slot: 2,
        canonicalUrl:
          "https://www.mobelaris.com/en/mobelarisblog/eileen-gray-e1027-table-replica-what-to-know",
        title: "Eileen Gray E1027 Table Replica: Buyer's Guide 2026",
        httpStatus: 200,
        status: "provisional_local",
      }),
    ]);
  });
});

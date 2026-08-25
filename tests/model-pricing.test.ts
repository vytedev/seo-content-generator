import { describe, expect, it } from "vitest";
import { computeCostMicros } from "../src/server/providers/model-pricing.js";

const TEST_MODEL = "provider/configured-model";

describe("computeCostMicros", () => {
  it("keeps cost at zero without complete configured rates", () => {
    expect(computeCostMicros(TEST_MODEL, 1000, 1000, {})).toBe(0);
    expect(
      computeCostMicros(TEST_MODEL, 1000, 1000, {
        OPENROUTER_INPUT_COST_PER_MTOK: "1",
      }),
    ).toBe(0);
  });

  it("derives cost from real token usage and configured rates", () => {
    expect(
      computeCostMicros(TEST_MODEL, 1000, 1000, {
        OPENROUTER_INPUT_COST_PER_MTOK: "1",
        OPENROUTER_OUTPUT_COST_PER_MTOK: "2",
      }),
    ).toBe(3000);
  });

  it("rounds to whole micro-USD", () => {
    expect(
      computeCostMicros(TEST_MODEL, 41, 97, {
        OPENROUTER_INPUT_COST_PER_MTOK: "0.1",
        OPENROUTER_OUTPUT_COST_PER_MTOK: "0.32",
      }),
    ).toBe(35);
  });

  it("keeps zero cost when no real tokens were used", () => {
    expect(
      computeCostMicros(TEST_MODEL, 0, 0, {
        OPENROUTER_INPUT_COST_PER_MTOK: "1",
        OPENROUTER_OUTPUT_COST_PER_MTOK: "2",
      }),
    ).toBe(0);
  });

  it("works for any configured model without a hardcoded price table", () => {
    expect(
      computeCostMicros("another-provider/another-model", 1000, 1000, {
        OPENROUTER_INPUT_COST_PER_MTOK: "1",
        OPENROUTER_OUTPUT_COST_PER_MTOK: "2",
      }),
    ).toBe(3000);
  });

  it("ignores malformed or negative rates", () => {
    expect(
      computeCostMicros(TEST_MODEL, 1000, 1000, {
        OPENROUTER_INPUT_COST_PER_MTOK: "not-a-number",
        OPENROUTER_OUTPUT_COST_PER_MTOK: "-1",
      }),
    ).toBe(0);
  });
});

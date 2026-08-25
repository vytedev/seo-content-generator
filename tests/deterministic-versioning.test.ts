import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_BUILD_ID,
  DETERMINISTIC_BUILD_ID_V2,
  DETERMINISTIC_CHECKER_VERSION,
  DETERMINISTIC_CHECKER_VERSION_V1,
  DETERMINISTIC_CHECKER_VERSION_V2,
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1,
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V2,
  DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1,
  DETERMINISTIC_RULE_DESCRIPTORS_HASH_V2,
  DETERMINISTIC_RULE_INVENTORY,
  DETERMINISTIC_RULE_INVENTORY_V1,
  DETERMINISTIC_RULE_INVENTORY_V2,
  DETERMINISTIC_SUPPORTED_CHECKER_VERSIONS,
  RUNNER_REGISTRY,
  assertDeterministicBuildId,
  deterministicHash,
} from "../src/shared/deterministic-run.js";
import { CHECKER_REGISTRY, CURRENT_CHECKER_VERSION } from "../src/shared/checker/registry.js";
import { runDeterministicChecksV1 } from "../src/shared/checker/v1/rules.js";
import { runDeterministicChecksV2 } from "../src/shared/checker/v2/rules.js";
import type { CheckerInput } from "../src/shared/checker/contracts.js";

const NEW_V2_RULES = ["on_page.title.complete", "structure.faq_pair_alignment"] as const;

/** A draft whose meta title dangles on "for" and whose FAQ answers are rotated. */
function input(overrides: Partial<CheckerInput["on_page"]> = {}): CheckerInput {
  return {
    primary_keyword: "wishbone chair",
    related_keywords: ["dining chair"],
    internal_origins: ["https://www.mobelaris.com"],
    verified_internal_links: [],
    body_markdown: "# Wishbone chair\n\nSome copy about the chair.\n",
    on_page: {
      meta_title: "The complete wishbone chair buying guide for".padEnd(55, "."),
      meta_description: "A practical guide to choosing a wishbone chair.".padEnd(150, "."),
      og_title: "Wishbone chair buying guide",
      og_description: "A practical guide.",
      slug: "wishbone-chair",
      images: [],
      faqs: [],
      ...overrides,
    },
  } as CheckerInput;
}

describe("deterministic checker versioning", () => {
  it("keeps v1 frozen at its historical fingerprints", () => {
    // The pins are the historical record: if a behavioural change is made to v1
    // instead of a new version, these stop matching.
    expect(deterministicHash(DETERMINISTIC_RULE_INVENTORY_V1)).toBe(
      DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1,
    );
    expect(deterministicHash(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1)).toBe(
      DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
    );
    expect(() => assertDeterministicBuildId()).not.toThrow();
  });

  it("excludes the new editorial blockers from v1 entirely", () => {
    const v1Ids: string[] = DETERMINISTIC_RULE_INVENTORY_V1.map((rule) => rule.id);
    for (const rule of NEW_V2_RULES) expect(v1Ids).not.toContain(rule);
    // v1 must not emit them at runtime either, whatever the input.
    const findings = runDeterministicChecksV1(input()).findings.map((finding) => finding.rule);
    for (const rule of NEW_V2_RULES) expect(findings).not.toContain(rule);
  });

  it("adds exactly the two new blockers in v2, keeping every v1 rule", () => {
    const v1Ids: string[] = DETERMINISTIC_RULE_INVENTORY_V1.map((rule) => rule.id);
    const v2Ids: string[] = DETERMINISTIC_RULE_INVENTORY_V2.map((rule) => rule.id);
    for (const id of v1Ids) expect(v2Ids).toContain(id);
    expect(v2Ids.filter((id) => !v1Ids.includes(id))).toEqual([...NEW_V2_RULES]);
    expect(v2Ids).toHaveLength(v1Ids.length + NEW_V2_RULES.length);
  });

  it("detects the dangling title only under v2", () => {
    const rulesOf = (run: { findings: Array<{ rule: string }> }) =>
      run.findings.map((finding) => finding.rule);
    expect(rulesOf(runDeterministicChecksV1(input()))).not.toContain("on_page.title.complete");
    expect(rulesOf(runDeterministicChecksV2(input()))).toContain("on_page.title.complete");
  });

  it("covers every v2 rule exactly once, with an explicit skip reason", () => {
    const run = runDeterministicChecksV2(input());
    expect(run.evaluations).toHaveLength(DETERMINISTIC_RULE_INVENTORY_V2.length);
    expect(new Set(run.evaluations.map((e) => e.rule_id)).size).toBe(run.evaluations.length);
    // No FAQs, so the pair rule is skipped rather than silently absent.
    expect(run.evaluations.find((e) => e.rule_id === "structure.faq_pair_alignment")).toEqual({
      rule_id: "structure.faq_pair_alignment",
      status: "skipped",
      reason: "faq_count_outside_two_to_six",
    });
  });

  it("registers both versions so frozen manifests keep validating", () => {
    expect(Object.keys(CHECKER_REGISTRY).sort()).toEqual([
      DETERMINISTIC_CHECKER_VERSION_V1,
      DETERMINISTIC_CHECKER_VERSION_V2,
    ]);
    expect(Object.keys(RUNNER_REGISTRY).sort()).toEqual([
      DETERMINISTIC_CHECKER_VERSION_V1,
      DETERMINISTIC_CHECKER_VERSION_V2,
    ]);
    expect(DETERMINISTIC_SUPPORTED_CHECKER_VERSIONS).toContain(DETERMINISTIC_CHECKER_VERSION_V1);
    // New runs are created at v2.
    expect(CURRENT_CHECKER_VERSION).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
    expect(DETERMINISTIC_CHECKER_VERSION).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
    expect(DETERMINISTIC_RULE_INVENTORY).toBe(DETERMINISTIC_RULE_INVENTORY_V2);
  });

  it("gives v2 its own distinct build identity", () => {
    expect(DETERMINISTIC_BUILD_ID_V2).not.toBe(DETERMINISTIC_BUILD_ID);
    expect(DETERMINISTIC_RULE_DESCRIPTORS_HASH_V2).not.toBe(DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1);
    expect(deterministicHash(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V2)).not.toBe(
      DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
    );
    expect(RUNNER_REGISTRY[DETERMINISTIC_CHECKER_VERSION_V1]!.build_id).toBe(
      DETERMINISTIC_BUILD_ID,
    );
    expect(RUNNER_REGISTRY[DETERMINISTIC_CHECKER_VERSION_V2]!.build_id).toBe(
      DETERMINISTIC_BUILD_ID_V2,
    );
  });
});

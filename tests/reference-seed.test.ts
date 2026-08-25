import { describe, expect, it } from "vitest";
import { PIPELINE_STEPS } from "../src/shared/pipeline.js";
import {
  CALIBRATION_URL_SLOT_MANIFEST,
  generateReferenceSeedSql,
  REFERENCE_DOCUMENT_KINDS,
  REFERENCE_DOCUMENT_SEED_MANIFEST,
} from "../src/db/reference-seed.js";

const mappingKeys = REFERENCE_DOCUMENT_SEED_MANIFEST.flatMap(({ kind, steps }) =>
  steps.map((step) => `${kind}:${step}`),
);

describe("MM03-01 reference seed manifest", () => {
  it("defines exactly the six required metadata-only slots", () => {
    expect(REFERENCE_DOCUMENT_SEED_MANIFEST).toHaveLength(6);
    expect(REFERENCE_DOCUMENT_SEED_MANIFEST.map(({ kind }) => kind)).toEqual(
      REFERENCE_DOCUMENT_KINDS,
    );
    expect(new Set(REFERENCE_DOCUMENT_KINDS).size).toBe(6);
    expect(REFERENCE_DOCUMENT_SEED_MANIFEST.every(({ title }) => title.trim().length > 0)).toBe(
      true,
    );
    expect(REFERENCE_DOCUMENT_SEED_MANIFEST.every((slot) => !("body" in slot))).toBe(true);
  });

  it("maps each slot only to the steps that need it", () => {
    expect(
      Object.fromEntries(REFERENCE_DOCUMENT_SEED_MANIFEST.map(({ kind, steps }) => [kind, steps])),
    ).toEqual({
      blog_writing_guide: ["draft", "review_writing_style"],
      writer_submission_sample: ["draft", "final_coherence_export"],
      keyword_placement_guidelines: ["draft", "automated_checks", "automated_checks_rerun"],
      internal_linking_guidelines: ["internal_link_discovery", "draft", "review_link_conversion"],
      fact_checking_rules: ["review_fact_checking", "final_coherence_export"],
      pipeline_workflow: ["ingest_handoff", "findings_review", "final_coherence_export"],
    });

    const validSteps = new Set(PIPELINE_STEPS.map(({ id }) => id));
    expect(
      mappingKeys.every((key) => validSteps.has(key.slice(key.indexOf(":") + 1) as never)),
    ).toBe(true);
  });

  it("contains no duplicate mappings", () => {
    expect(new Set(mappingKeys).size).toBe(mappingKeys.length);
  });

  it("generates idempotent SQL without versions, activations, or body content", () => {
    const sql = generateReferenceSeedSql();

    expect(generateReferenceSeedSql()).toBe(sql);
    expect(sql).toContain("ON CONFLICT (kind) DO UPDATE");
    expect(sql).toContain("ON CONFLICT (reference_document_id, step) DO NOTHING");
    expect(sql).toContain("DELETE FROM substep_reference_map mapping");
    expect(sql).toContain("AND NOT EXISTS");
    expect(sql).not.toMatch(/INSERT INTO reference_versions/i);
    expect(sql).not.toMatch(/INSERT INTO reference_activations/i);
    expect(sql).not.toMatch(/body_markdown/i);
  });

  it("provides two unset calibration URL slots without inventing URLs", () => {
    expect(CALIBRATION_URL_SLOT_MANIFEST).toEqual([
      { slot: "calibration_url_1", url: null },
      { slot: "calibration_url_2", url: null },
    ]);
  });
});

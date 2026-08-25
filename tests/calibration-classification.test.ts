import { describe, expect, it } from "vitest";
import { classifyCalibrationEvidence } from "../src/server/services/calibration-engine.js";

const evidence = {
  checkerRuleSet: ["structure.single_h1"],
  publishedRules: [] as string[],
  generatedRules: [] as string[],
  publishedMetric: { rule_findings: 0 },
  generatedMetric: { rule_findings: 0 },
  pipelineOutcome: "succeeded" as const,
  relevantMentions: 0,
};

describe("calibration evidence classification", () => {
  it("treats valid measured differences as editorial rather than an unsupported defect", () => {
    expect(
      classifyCalibrationEvidence("structure", {
        ...evidence,
        generatedMetric: { rule_findings: 1 },
        generatedRules: ["structure.single_h1"],
      }),
    ).toBe("expected_editorial_difference");
  });

  it("uses ambiguity only when relevant evidence exists without checker coverage", () => {
    expect(
      classifyCalibrationEvidence("factual_figures", {
        ...evidence,
        checkerRuleSet: [],
        relevantMentions: 2,
      }),
    ).toBe("missing_or_ambiguous_reference_guidance");
    expect(
      classifyCalibrationEvidence("factual_figures", {
        ...evidence,
        checkerRuleSet: [],
        relevantMentions: 0,
      }),
    ).toBe("expected_editorial_difference");
  });

  it("uses terminal mock limitations and never infers FP/FN or adjustment without evidence", () => {
    expect(
      classifyCalibrationEvidence("coherence", {
        ...evidence,
        checkerRuleSet: [],
        pipelineOutcome: "blocked",
      }),
    ).toBe("mock_provider_limitation");
    for (const dimension of ["structure", "attribution"] as const) {
      const classification = classifyCalibrationEvidence(dimension, evidence);
      expect(classification).not.toMatch(/false_positive|false_negative|recommended/);
    }
  });

  it("emits a true error only with explicit labelled actual-rule evidence", () => {
    expect(
      classifyCalibrationEvidence("structure", {
        ...evidence,
        labelledActualRuleEvidence: "false_positive",
      }),
    ).toBe("true_pipeline_false_positive");
  });
});

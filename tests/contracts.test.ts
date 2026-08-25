import { describe, expect, it } from "vitest";
import {
  HandoffSchema,
  PIPELINE_STEPS,
  PipelineRunSchema,
  PipelineStepExecutionSchema,
  PipelineStepIdSchema,
  RunStatusSchema,
  StepStatusSchema,
} from "../src/shared/index.js";

const validHandoff = {
  plane_ticket: "MOB-000",
  primary_keyword: "ergonomic office chairs",
  related_keywords: ["desk chair", "home office chair"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: ["sv-SE", "de-DE"],
};

describe("shared Zod contracts", () => {
  it("defines exactly the task's twelve steps in order", () => {
    expect(PIPELINE_STEPS).toHaveLength(12);
    expect(PIPELINE_STEPS.map(({ number, id, name }) => `${number}:${id}:${name}`)).toEqual([
      "1.1:ingest_handoff:Ingest handoff",
      "1.2:internal_link_discovery:Internal link discovery",
      "1.3:draft:Draft",
      "1.4:automated_checks:Automated checks",
      "1.5:review_writing_style:Review: writing format and style",
      "1.6:review_information_gain:Review: unique value and information gain",
      "1.7:review_fact_checking:Review: fact checking",
      "1.8:review_link_conversion:Review: internal linking and conversion alignment",
      "1.9:findings_review:Findings review",
      "1.10:revision_pass:Revision pass",
      "1.11:automated_checks_rerun:Automated checks re-run",
      "1.12:final_coherence_export:Final coherence review and export",
    ]);
    expect(PipelineStepIdSchema.options).toHaveLength(12);
  });

  it("accepts the exact handoff with optional notes and client insights", () => {
    const parsed = HandoffSchema.parse({
      ...validHandoff,
      notes: "Prioritise small home offices.",
      client_insights: "Customers often confuse ergonomic support with softness.",
    });
    expect(parsed.client_insights).toContain("Customers");
  });

  it("allows absent optional fields but rejects partial or unknown input atomically", () => {
    expect(HandoffSchema.parse(validHandoff)).toEqual(validHandoff);
    expect(HandoffSchema.safeParse({ ...validHandoff, related_keywords: [] }).success).toBe(false);
    expect(HandoffSchema.safeParse({ ...validHandoff, page_type: "product" }).success).toBe(false);
    expect(HandoffSchema.safeParse({ ...validHandoff, unknown: true }).success).toBe(false);
    const { plane_ticket: _removed, ...missingTicket } = validHandoff;
    expect(HandoffSchema.safeParse(missingTicket).success).toBe(false);
  });

  it("validates durable run and step statuses and coherence bounds", () => {
    for (const status of [
      "queued",
      "running",
      "waiting",
      "retryable_failed",
      "blocked",
      "succeeded",
      "cancelled",
    ]) {
      expect(RunStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of [
      "queued",
      "leased",
      "running",
      "waiting",
      "retryable_failed",
      "blocked",
      "succeeded",
      "cancelled",
    ]) {
      expect(StepStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(
      PipelineRunSchema.safeParse({
        id: "run-1",
        handoff: validHandoff,
        status: "queued",
        coherence_return_cycles: 2,
      }).success,
    ).toBe(true);
    expect(
      PipelineRunSchema.safeParse({
        id: "run-1",
        handoff: validHandoff,
        status: "queued",
        coherence_return_cycles: 3,
      }).success,
    ).toBe(false);
    expect(
      PipelineStepExecutionSchema.safeParse({
        id: "attempt-1",
        run_id: "run-1",
        step: "ingest_handoff",
        status: "leased",
        attempt_number: 1,
      }).success,
    ).toBe(true);
  });
});

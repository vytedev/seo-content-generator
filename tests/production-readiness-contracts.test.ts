import { describe, expect, it } from "vitest";
import {
  ExportClaimSchema,
  HardFlagReasonSchema,
  PaidOperationProjectionSchema,
  RunActivitySchema,
  RunCommandKindSchema,
  RunCommandSchema,
  RuntimeModeSchema,
  SerpEvidenceSchema,
  normalisePaidOperationStage,
  permitsTestDoubles,
  projectHardFlagReason,
  deriveFactHardFlagReason,
  PersistedReviewFindingSchema,
} from "../src/shared/index.js";

const hash = "a".repeat(64);
const requested_at = "2026-09-02T12:00:00Z";
const base = {
  command_id: "command-1",
  idempotency_key: "key-12345678",
  payload_hash: hash,
  requested_at,
};

describe("production-readiness contracts", () => {
  it("defines explicit local, test, and production modes", () => {
    expect(RuntimeModeSchema.options).toEqual(["local", "test", "production"]);
    expect(permitsTestDoubles("local")).toBe(true);
    expect(permitsTestDoubles("test")).toBe(true);
    expect(permitsTestDoubles("production")).toBe(false);
  });

  it("represents every current continuation plus warning and SERP commands", () => {
    expect(RunCommandKindSchema.options).toEqual([
      "create_run",
      "resume_run",
      "cancel_run",
      "submit_findings",
      "open_editorial_correction",
      "authorise_exceptional_correction",
      "retry_export",
      "acknowledge_warning",
      "probe_serp",
    ]);
    expect(
      RunCommandSchema.parse({
        ...base,
        kind: "create_run",
        warnings: [],
        handoff: {
          plane_ticket: "MOB-1",
          primary_keyword: "walnut dining tables",
          related_keywords: ["solid wood tables"],
          page_type: "blog",
          word_count_target: 900,
          locales_for_translation: [],
        },
      }).kind,
    ).toBe("create_run");
    expect(RunCommandSchema.safeParse({ ...base, kind: "create_run", handoff: {} }).success).toBe(
      false,
    );
    expect(
      RunCommandSchema.parse({
        ...base,
        kind: "resume_run",
        run_id: "run-1",
        options: { refresh_link_discovery: true },
      }).kind,
    ).toBe("resume_run");
    expect(
      RunCommandSchema.safeParse({
        ...base,
        kind: "authorise_exceptional_correction",
        run_id: "run-1",
      }).success,
    ).toBe(false);
    expect(
      RunCommandSchema.safeParse({
        ...base,
        kind: "resume_run",
        run_id: "run-1",
        options: {},
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("requires sequence-ordered, bounded activity records", () => {
    expect(
      RunActivitySchema.parse({
        activity_id: "activity-1",
        run_id: "run-1",
        sequence: 1,
        type: "step_started",
        occurred_at: requested_at,
        step: "draft",
        summary: "Draft started.",
      }).sequence,
    ).toBe(1);
    expect(
      RunActivitySchema.safeParse({
        activity_id: "activity-1",
        run_id: "run-1",
        sequence: 0,
        type: "step_started",
        occurred_at: requested_at,
        summary: "Draft started.",
      }).success,
    ).toBe(false);
    expect(
      RunActivitySchema.safeParse({
        activity_id: "activity-2",
        run_id: "run-1",
        sequence: 2,
        type: "command_accepted",
        occurred_at: requested_at,
        summary: "Command accepted.",
      }).success,
    ).toBe(false);
  });

  it("normalises the historical revision checkpoint name", () => {
    expect(normalisePaidOperationStage("response_validated")).toBe("checkpointed");
    expect(normalisePaidOperationStage("provider_in_flight")).toBe("provider_in_flight");
    expect(
      PaidOperationProjectionSchema.safeParse({
        operation_id: "operation-1",
        kind: "review",
        stage: "provider_in_flight",
        exposure: "possible_provider_spend",
        owner: "technical_review",
        ambiguity_reason: "provider_in_flight_without_checkpoint",
      }).success,
    ).toBe(true);
    expect(
      PaidOperationProjectionSchema.safeParse({
        operation_id: "operation-1",
        kind: "review",
        stage: "checkpointed",
        exposure: "possible_provider_spend",
        owner: "technical_review",
        ambiguity_reason: "provider_in_flight_without_checkpoint",
      }).success,
    ).toBe(false);
    expect(
      PaidOperationProjectionSchema.safeParse({
        operation_id: "operation-2",
        kind: "draft",
        stage: "started",
        exposure: "possible_provider_spend",
        owner: "worker",
      }).success,
    ).toBe(false);
  });

  it("validates durable SERP evidence including safe failure state", () => {
    expect(
      SerpEvidenceSchema.parse({
        evidence_id: "evidence-1",
        handoff_hash: hash,
        provider: "configured-serp-provider",
        query: "walnut dining tables",
        retrieved_at: requested_at,
        status: "mismatch",
        composition: { informational: 2, commercial: 8 },
        failure_reason: null,
      }).status,
    ).toBe("mismatch");
    expect(
      SerpEvidenceSchema.safeParse({
        evidence_id: "evidence-2",
        handoff_hash: hash,
        provider: "configured-serp-provider",
        query: "walnut dining tables",
        retrieved_at: requested_at,
        status: "failed",
        composition: null,
        failure_reason: null,
      }).success,
    ).toBe(false);
    expect(
      SerpEvidenceSchema.safeParse({
        evidence_id: "evidence-3",
        handoff_hash: hash,
        provider: "configured-serp-provider",
        query: "walnut dining tables",
        retrieved_at: requested_at,
        status: "matched",
        composition: null,
        failure_reason: null,
      }).success,
    ).toBe(false);
  });

  it("keeps hard_flag compatible while safely projecting historical rows", () => {
    expect(HardFlagReasonSchema.options).toContain("designer_attribution");
    expect(projectHardFlagReason({ hard_flag: true })).toBe("unknown_legacy");
    expect(projectHardFlagReason({ hard_flag: true, hard_flag_reason: "provenance" })).toBe(
      "provenance",
    );
    expect(projectHardFlagReason({ hard_flag: false })).toBeNull();
    expect(
      deriveFactHardFlagReason({
        text: "The chair was designed by Hans Wegner.",
        classification: "attribution_provenance",
        claim_type: "provenance",
      }),
    ).toBe("designer_attribution");
    expect(
      deriveFactHardFlagReason({
        text: "The collection has documented provenance.",
        classification: "attribution_provenance",
        claim_type: "provenance",
      }),
    ).toBe("provenance");

    const finding = {
      stable_key: "fact.provenance",
      category: "fact",
      rule_reference: "fact.provenance",
      severity: "blocker" as const,
      location: { field: "body_markdown", line_start: 2 },
      issue: "Attribution needs review.",
      suggested_fix: "Check the attribution.",
      hard_flag: true,
    };
    expect(PersistedReviewFindingSchema.parse(finding).hard_flag_reason).toBeUndefined();
    expect(
      PersistedReviewFindingSchema.safeParse({
        ...finding,
        hard_flag: false,
        hard_flag_reason: "provenance",
      }).success,
    ).toBe(false);

    const claim = {
      id: "claim-1",
      claim_text: "The chair was designed in 1956.",
      type: "provenance" as const,
      status: "unverified" as const,
      hard_flag: true,
      location: { field: "body_markdown", line_start: 4 },
      claim_hash: hash,
      sources: [],
    };
    expect(ExportClaimSchema.parse(claim).hard_flag_reason).toBeUndefined();
    expect(
      ExportClaimSchema.safeParse({
        ...claim,
        hard_flag: false,
        hard_flag_reason: "designer_attribution",
      }).success,
    ).toBe(false);
  });
});

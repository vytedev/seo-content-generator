import { z } from "zod";
import { PaidOperationProjectionSchema } from "../paid-operation.js";
import { IngestWarningSchema, SerpEvidenceSchema } from "../ingest-contracts.js";
import { InternalLinkSchema, LinkDiscoveryMetadataSchema } from "./link-discovery.js";
import { PipelineStepIdSchema } from "../pipeline.js";
import { EvidenceSourceProjectionSchema } from "../milestone-three.js";
import {
  ArtifactSchema,
  DocumentVersionSchema,
  LegacyDerivedFieldSchema,
  StructuredDraftSchema,
} from "./content.js";

const text = z.string().trim().min(1);

export const UsageTotalsSchema = z
  .object({
    input_units: z.number().int().nonnegative(),
    output_units: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
  })
  .strict();
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

const attempt = z
  .object({
    id: text,
    step: PipelineStepIdSchema,
    number: z.string(),
    name: text,
    attempt: z.number().int().positive(),
    status: z.enum([
      "queued",
      "leased",
      "running",
      "waiting",
      "retryable_failed",
      "blocked",
      "succeeded",
      "cancelled",
    ]),
    error: z.string().nullable(),
  })
  .strict();

export const RunSummarySchema = z
  .object({
    run_id: text,
    plane_ticket: text,
    primary_keyword: text,
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "retryable_failed",
      "blocked",
      "succeeded",
      "cancelled",
    ]),
    current_step: PipelineStepIdSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListSchema = z.object({ runs: z.array(RunSummarySchema) }).strict();
export type RunList = z.infer<typeof RunListSchema>;

export const RunBlockReasonSchema = z.enum(["deterministic_blockers", "coherence_cycle_cap"]);
export type RunBlockReason = z.infer<typeof RunBlockReasonSchema>;

export const RunDetailSchema = z
  .object({
    run_id: text,
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "retryable_failed",
      "blocked",
      "succeeded",
      "cancelled",
    ]),
    current_step: PipelineStepIdSchema.nullable(),
    /** When the run last transitioned status/current_step — the basis for an elapsed-time display. */
    updated_at: z.string(),
    coherence_return_cycles: z.number().int().min(0).max(2),
    deterministic_repair_cycles: z.number().int().min(0).max(2).default(0),
    steps: z.array(attempt),
    current_document: z
      .object({
        version: DocumentVersionSchema,
        artifact: ArtifactSchema,
        draft: StructuredDraftSchema,
        /** Present only when the stored version predates draft-owned on-page fields. */
        legacy_derived_fields: z.array(LegacyDerivedFieldSchema).optional(),
      })
      .strict()
      .nullable(),
    counts: z
      .object({
        warnings: z.number().int().nonnegative(),
        unverified: z.number().int().nonnegative(),
        hard_flags: z.number().int().nonnegative(),
        rejected_findings: z.number().int().nonnegative(),
      })
      .strict(),
    usage: UsageTotalsSchema,
    link_discovery: z
      .object({
        shortlist: z.array(InternalLinkSchema),
        metadata: LinkDiscoveryMetadataSchema.nullable(),
      })
      .strict()
      .default({ shortlist: [], metadata: null }),
    export: z
      .object({
        status: z.enum(["not_started", "pending", "failed", "succeeded"]),
        external_url: z.string().url().nullable(),
      })
      .strict(),
    can_retry: z.boolean(),
    draft_recovery: z
      .enum(["none", "legacy_confirmation_required", "ambiguous_technical_review"])
      .default("none"),
    blocked_for_operator: z.boolean(),
    paid_operation_ambiguities: z.array(PaidOperationProjectionSchema).default([]),
    serp_probe: z
      .object({
        status: z.enum(["pending", "matched", "mismatch", "no_results", "failed"]),
        evidence: SerpEvidenceSchema.nullable(),
        warning: IngestWarningSchema.nullable(),
      })
      .strict()
      .default({ status: "pending", evidence: null, warning: null }),
    /** Narrow recovery for legacy deterministic blocks with correction budget remaining. */
    can_recover_deterministic_block: z.boolean().default(false),
    /** One exceptional correction after the automatic cap, bound to the exact current rerun. */
    exceptional_correction: z
      .object({
        available: z.boolean(),
        authorised: z.boolean(),
        requires_ai: z.boolean().nullable(),
      })
      .strict()
      .default({ available: false, authorised: false, requires_ai: null }),
    /** Persisted block authority; unknown is reserved for legacy rows with no recorded reason. */
    block_reason: z.union([RunBlockReasonSchema, z.literal("unknown")]),
    block_counts: z
      .object({
        deterministic_blockers: z.number().int().nonnegative(),
        coherence_blockers: z.number().int().nonnegative(),
      })
      .strict(),
    fact_evidence_sources: z.array(EvidenceSourceProjectionSchema).default([]),
    deterministic_blocker_details: z
      .array(
        z
          .object({
            rule_reference: text,
            location: z.record(z.string(), z.unknown()),
            issue: text,
            suggested_fix: text,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type RunDetail = z.infer<typeof RunDetailSchema>;

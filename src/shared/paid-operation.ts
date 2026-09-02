import { z } from "zod";

const text = z.string().trim().min(1);

/** Canonical lifecycle names used when the four provider-operation stores are unified. */
export const PaidOperationStageSchema = z.enum(["started", "provider_in_flight", "checkpointed"]);
export type PaidOperationStage = z.infer<typeof PaidOperationStageSchema>;

/** Existing revision rows use response_validated for the canonical checkpointed stage. */
export const PersistedPaidOperationStageSchema = z.enum([
  "started",
  "provider_in_flight",
  "checkpointed",
  "response_validated",
]);
export type PersistedPaidOperationStage = z.infer<typeof PersistedPaidOperationStageSchema>;

export function normalisePaidOperationStage(
  stage: PersistedPaidOperationStage,
): PaidOperationStage {
  return stage === "response_validated" ? "checkpointed" : stage;
}

/** Only a failure proven to precede dispatch may release provider authority. */
export const PaidOperationReleaseReasonSchema = z.enum([
  "configuration_before_dispatch",
  "authentication_before_dispatch",
  "billing_before_dispatch",
  "validation_before_dispatch",
]);
export type PaidOperationReleaseReason = z.infer<typeof PaidOperationReleaseReasonSchema>;

export const PaidOperationAmbiguityReasonSchema = z.enum([
  "provider_in_flight_without_checkpoint",
  "external_side_effect_without_checkpoint",
  "legacy_dispatch_outcome_unknown",
]);
export type PaidOperationAmbiguityReason = z.infer<typeof PaidOperationAmbiguityReasonSchema>;

export const PaidOperationKindSchema = z.enum(["draft", "review", "revision", "coherence"]);
export type PaidOperationKind = z.infer<typeof PaidOperationKindSchema>;

export const PaidOperationExposureSchema = z.enum([
  "none",
  "possible_provider_spend",
  "external_side_effect",
]);

export const PaidOperationProjectionSchema = z
  .object({
    operation_id: text,
    kind: PaidOperationKindSchema,
    stage: PaidOperationStageSchema,
    exposure: PaidOperationExposureSchema,
    owner: text,
    release_reason: PaidOperationReleaseReasonSchema.nullable().optional(),
    ambiguity_reason: PaidOperationAmbiguityReasonSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.release_reason && value.stage !== "started")
      context.addIssue({
        code: "custom",
        path: ["release_reason"],
        message: "Only a pre-dispatch operation may carry a release reason.",
      });
    if (value.ambiguity_reason && value.stage !== "provider_in_flight")
      context.addIssue({
        code: "custom",
        path: ["ambiguity_reason"],
        message: "Only an in-flight operation may be ambiguous.",
      });
    if (value.release_reason && value.ambiguity_reason)
      context.addIssue({
        code: "custom",
        message: "Release and ambiguity are mutually exclusive.",
      });
    if (value.stage === "started" && value.exposure !== "none")
      context.addIssue({
        code: "custom",
        path: ["exposure"],
        message: "A pre-dispatch operation cannot report provider exposure.",
      });
    if (value.stage === "provider_in_flight" && value.exposure === "none")
      context.addIssue({
        code: "custom",
        path: ["exposure"],
        message: "An in-flight operation must report possible exposure.",
      });
  });
export type PaidOperationProjection = z.infer<typeof PaidOperationProjectionSchema>;

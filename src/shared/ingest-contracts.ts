import { z } from "zod";
import { HandoffSchema } from "./pipeline.js";

// Browser-safe ingest schemas. This module must never import node:* built-ins:
// client code (src/client/lib/ingest-api.ts) consumes these contracts directly.
const text = z.string().trim().min(1);

export const SerpCompositionSchema = z
  .object({
    informational: z.number().int().nonnegative(),
    commercial: z.number().int().nonnegative(),
  })
  .strict();
export type SerpComposition = z.infer<typeof SerpCompositionSchema>;

export const SerpEvidenceStatusSchema = z.enum(["matched", "mismatch", "no_results", "failed"]);
export const SerpEvidenceSchema = z
  .object({
    evidence_id: text,
    handoff_hash: z.string().regex(/^[a-f0-9]{64}$/),
    provider: text,
    query: text,
    retrieved_at: z.string().datetime({ offset: true }),
    status: SerpEvidenceStatusSchema,
    composition: SerpCompositionSchema.nullable(),
    failure_reason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && !value.failure_reason)
      context.addIssue({
        code: "custom",
        path: ["failure_reason"],
        message: "A failed probe needs a safe reason.",
      });
    if (value.status !== "failed" && value.failure_reason)
      context.addIssue({
        code: "custom",
        path: ["failure_reason"],
        message: "Only a failed probe may have a failure reason.",
      });
    if (["matched", "mismatch"].includes(value.status) && !value.composition)
      context.addIssue({
        code: "custom",
        path: ["composition"],
        message: "A classified result needs its bounded composition.",
      });
    if (["failed", "no_results"].includes(value.status) && value.composition)
      context.addIssue({
        code: "custom",
        path: ["composition"],
        message: "A failed or empty result cannot carry a composition.",
      });
  });
export type SerpEvidence = z.infer<typeof SerpEvidenceSchema>;

export const IngestWarningCodeSchema = z.enum(["serp_composition_mismatch", "serp_probe_failed"]);
export const IngestWarningSchema = z
  .object({
    code: IngestWarningCodeSchema,
    message: text,
  })
  .strict();
export type IngestWarning = z.infer<typeof IngestWarningSchema>;
export const IngestResultSchema = z
  .object({
    run_id: text,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    handoff: HandoffSchema,
    warnings: z.array(IngestWarningSchema),
  })
  .strict();
export type IngestResult = z.infer<typeof IngestResultSchema>;

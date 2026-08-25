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

export const IngestWarningSchema = z
  .object({
    code: z.enum(["serp_composition_mismatch", "serp_probe_failed"]),
    message: text,
  })
  .strict();
export const IngestResultSchema = z
  .object({
    run_id: text,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    handoff: HandoffSchema,
    warnings: z.array(IngestWarningSchema),
  })
  .strict();
export type IngestResult = z.infer<typeof IngestResultSchema>;

import { z } from "zod";

export const ModelDiagnosticRequestSchema = z
  .object({ explicit_confirmation: z.literal(true) })
  .strict();

export const ModelDiagnosticErrorCategorySchema = z.enum([
  "unavailable",
  "operation_in_progress",
  "ambiguous_previous_attempt",
  "request_rejected",
  "invalid_credentials",
  "billing_required",
  "access_denied",
  "model_not_found",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "network_error",
  "invalid_response",
]);
export type ModelDiagnosticErrorCategory = z.infer<typeof ModelDiagnosticErrorCategorySchema>;

export const ModelDiagnosticResultSchema = z
  .object({
    provider: z.literal("openrouter"),
    model: z.string().trim().min(1).nullable(),
    status: z.enum(["success", "failed"]),
    error_category: ModelDiagnosticErrorCategorySchema.nullable(),
    message: z.string().trim().min(1),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict();
export type ModelDiagnosticResult = z.infer<typeof ModelDiagnosticResultSchema>;

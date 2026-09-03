import { z } from "zod";

/** Append-only reasons. unknown_legacy is the safe projection for historical boolean-only rows. */
export const HardFlagReasonSchema = z.enum([
  "provenance",
  "designer_attribution",
  "unverified_figure",
  "contradicted",
  "policy",
  "unknown_legacy",
]);
export type HardFlagReason = z.infer<typeof HardFlagReasonSchema>;

export const HardFlagFieldsSchema = z
  .object({
    hard_flag: z.boolean(),
    hard_flag_reason: HardFlagReasonSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (!value.hard_flag && value.hard_flag_reason)
      context.addIssue({
        code: "custom",
        path: ["hard_flag_reason"],
        message: "A non-hard-flagged record cannot have a mandatory-review reason.",
      });
  });

const DESIGNER_ATTRIBUTION_PASSIVE =
  /\b(?:designed|created|made|crafted|founded|invented)(?:\s+in\s+\d{4})?\s+by\b|\bdesigner\s+is\b|\bdesigner\s*:/i;
const DESIGNER_ATTRIBUTION_NAME_LED =
  /\b(?!(?:The|We|Our|This|That|A|An)\b)[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,3}\s+(?:designed|created|made|crafted|founded|invented)\b/u;

/** Application-owned derivation; providers may never choose mandatory-review reasons. */
export function deriveFactHardFlagReason(input: {
  text: string;
  classification: "factual_claim" | "factual_figure" | "attribution_provenance";
  claim_type: string;
}): HardFlagReason | null {
  if (input.classification !== "attribution_provenance" && input.claim_type !== "provenance")
    return null;
  return DESIGNER_ATTRIBUTION_PASSIVE.test(input.text) ||
    DESIGNER_ATTRIBUTION_NAME_LED.test(input.text)
    ? "designer_attribution"
    : "provenance";
}

export function projectHardFlagReason(input: {
  hard_flag: boolean;
  hard_flag_reason?: HardFlagReason | null | undefined;
}): HardFlagReason | null {
  if (!input.hard_flag) return null;
  return input.hard_flag_reason ?? "unknown_legacy";
}

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

export function projectHardFlagReason(input: {
  hard_flag: boolean;
  hard_flag_reason?: HardFlagReason | null;
}): HardFlagReason | null {
  if (!input.hard_flag) return null;
  return input.hard_flag_reason ?? "unknown_legacy";
}

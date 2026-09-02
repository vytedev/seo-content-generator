import { z } from "zod";
import { IngestWarningSchema } from "./ingest-contracts.js";
import { BulkDispositionSchema } from "./milestone-three.js";
import { HandoffSchema, PipelineStepIdSchema } from "./pipeline.js";

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

const baseCommand = {
  command_id: text,
  idempotency_key: text,
  payload_hash: hash,
  requested_at: timestamp,
};

/** Complete operator intent set currently exposed by ingest, findings, and run routes. */
export const RunCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...baseCommand,
      kind: z.literal("create_run"),
      handoff: HandoffSchema,
      warnings: z.array(IngestWarningSchema),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      kind: z.literal("resume_run"),
      run_id: text,
      options: z
        .object({
          refresh_link_discovery: z.boolean().optional(),
          authorise_legacy_draft_recovery: z.literal(true).optional(),
          authorise_legacy_review_recovery: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...baseCommand, kind: z.literal("cancel_run"), run_id: text }).strict(),
  z
    .object({
      ...baseCommand,
      kind: z.literal("submit_findings"),
      run_id: text,
      dispositions: BulkDispositionSchema,
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      kind: z.literal("open_editorial_correction"),
      run_id: text,
      explicit_confirmation: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      kind: z.literal("authorise_exceptional_correction"),
      run_id: text,
      explicit_confirmation: z.literal(true),
    })
    .strict(),
  z.object({ ...baseCommand, kind: z.literal("retry_export"), run_id: text }).strict(),
  z
    .object({
      ...baseCommand,
      kind: z.literal("acknowledge_warning"),
      run_id: text,
      warning_id: text,
    })
    .strict(),
  z
    .object({ ...baseCommand, kind: z.literal("probe_serp"), run_id: text, handoff_hash: hash })
    .strict(),
]);
export type RunCommand = z.infer<typeof RunCommandSchema>;
export const RunCommandKindSchema = z.enum(
  RunCommandSchema.options.map((option) => option.shape.kind.value) as [
    RunCommand["kind"],
    ...RunCommand["kind"][],
  ],
);
export type RunCommandKind = z.infer<typeof RunCommandKindSchema>;

export const RunActivityTypeSchema = z.enum([
  "command_accepted",
  "command_rejected",
  "step_started",
  "step_waiting",
  "step_failed",
  "step_blocked",
  "step_succeeded",
  "run_cancelled",
  "warning_recorded",
  "warning_acknowledged",
  "export_succeeded",
]);

export const RunActivitySchema = z
  .object({
    activity_id: text,
    run_id: text,
    sequence: z.number().int().positive(),
    type: RunActivityTypeSchema,
    occurred_at: timestamp,
    command_id: text.optional(),
    step: PipelineStepIdSchema.optional(),
    summary: text,
  })
  .strict()
  .superRefine((activity, context) => {
    if (activity.type.startsWith("command_") && !activity.command_id)
      context.addIssue({
        code: "custom",
        path: ["command_id"],
        message: "Command activity needs a command id.",
      });
    if (activity.type.startsWith("command_") && activity.step)
      context.addIssue({
        code: "custom",
        path: ["step"],
        message: "Command activity cannot claim a pipeline step.",
      });
    if (activity.type.startsWith("step_") && activity.command_id)
      context.addIssue({
        code: "custom",
        path: ["command_id"],
        message: "Step activity cannot claim a command.",
      });
    if (activity.type.startsWith("step_") && !activity.step)
      context.addIssue({
        code: "custom",
        path: ["step"],
        message: "Step activity needs a step id.",
      });
  });
export type RunActivity = z.infer<typeof RunActivitySchema>;

import { z } from "zod";

/** The task-defined pipeline order. Array position is the canonical step number. */
export const PIPELINE_STEPS = [
  { id: "ingest_handoff", number: "1.1", name: "Ingest handoff", kind: "code" },
  {
    id: "internal_link_discovery",
    number: "1.2",
    name: "Internal link discovery",
    kind: "code_and_tools",
  },
  { id: "draft", number: "1.3", name: "Draft", kind: "model" },
  { id: "automated_checks", number: "1.4", name: "Automated checks", kind: "code" },
  {
    id: "review_writing_style",
    number: "1.5",
    name: "Review: writing format and style",
    kind: "model",
  },
  {
    id: "review_information_gain",
    number: "1.6",
    name: "Review: unique value and information gain",
    kind: "model",
  },
  {
    id: "review_fact_checking",
    number: "1.7",
    name: "Review: fact checking",
    kind: "model_and_tools",
  },
  {
    id: "review_link_conversion",
    number: "1.8",
    name: "Review: internal linking and conversion alignment",
    kind: "code_and_model",
  },
  { id: "findings_review", number: "1.9", name: "Findings review", kind: "operator" },
  { id: "revision_pass", number: "1.10", name: "Revision pass", kind: "model" },
  { id: "automated_checks_rerun", number: "1.11", name: "Automated checks re-run", kind: "code" },
  {
    id: "final_coherence_export",
    number: "1.12",
    name: "Final coherence review and export",
    kind: "model_and_code",
  },
] as const;

export const PipelineStepIdSchema = z.enum([
  "ingest_handoff",
  "internal_link_discovery",
  "draft",
  "automated_checks",
  "review_writing_style",
  "review_information_gain",
  "review_fact_checking",
  "review_link_conversion",
  "findings_review",
  "revision_pass",
  "automated_checks_rerun",
  "final_coherence_export",
]);
export type PipelineStepId = z.infer<typeof PipelineStepIdSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "retryable_failed",
  "blocked",
  "succeeded",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "waiting",
  "retryable_failed",
  "blocked",
  "succeeded",
  "cancelled",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

const requiredText = z.string().trim().min(1);

/** The strict handoff accepted by step 1.1. Unknown or partial input is rejected. */
export const HandoffSchema = z
  .object({
    plane_ticket: requiredText,
    primary_keyword: requiredText,
    related_keywords: z.array(requiredText).min(1),
    page_type: z.literal("blog"),
    word_count_target: z.number().int().positive(),
    locales_for_translation: z.array(requiredText),
    notes: requiredText.optional(),
    client_insights: requiredText.optional(),
  })
  .strict();
export type Handoff = z.infer<typeof HandoffSchema>;

export const PipelineRunSchema = z
  .object({
    id: requiredText,
    handoff: HandoffSchema,
    status: RunStatusSchema,
    current_step: PipelineStepIdSchema.optional(),
    coherence_return_cycles: z.number().int().min(0).max(2),
  })
  .strict();
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

export const PipelineStepExecutionSchema = z
  .object({
    id: requiredText,
    run_id: requiredText,
    step: PipelineStepIdSchema,
    status: StepStatusSchema,
    attempt_number: z.number().int().positive(),
  })
  .strict();
export type PipelineStepExecution = z.infer<typeof PipelineStepExecutionSchema>;

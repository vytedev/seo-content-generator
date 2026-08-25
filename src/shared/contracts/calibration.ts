import { z } from "zod";
import { FindingSchema } from "../checker/contracts.js";
import { HandoffSchema } from "../pipeline.js";

export const CALIBRATION_POSTS = [
  {
    slot: 1,
    url: "https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences",
    slug: "barcelona-chair-replica-vs-original-key-differences",
    primary_keyword: "barcelona chair buying comparison",
    related_keyword: "modernist lounge chair guide",
    generated_title: "How to Compare a Modernist Lounge Chair",
    word_count_target: 900,
  },
  {
    slot: 2,
    url: "https://www.mobelaris.com/en/mobelarisblog/eileen-gray-e1027-table-replica-what-to-know",
    slug: "eileen-gray-e1027-table-replica-what-to-know",
    primary_keyword: "adjustable side table buying guide",
    related_keyword: "modernist occasional table",
    generated_title: "How to Choose an Adjustable Side Table",
    word_count_target: 900,
  },
] as const;

export const CalibrationSlotSchema = z.union([z.literal(1), z.literal(2)]);
export const CalibrationUrlSchema = z.enum([CALIBRATION_POSTS[0].url, CALIBRATION_POSTS[1].url]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmpty = z.string().min(1);

export const CalibrationSnapshotSchema = z
  .object({
    slot: CalibrationSlotSchema,
    url: CalibrationUrlSchema,
    canonical_url: CalibrationUrlSchema,
    http_status: z.literal(200),
    retrieved_at: z.string().datetime({ offset: true }),
    title: nonEmpty,
    meta_description: nonEmpty,
    published_time: z.string().datetime({ offset: true }),
    article_markdown: nonEmpty,
    content_hash: hash,
    safe_metadata: z
      .object({
        author_name: nonEmpty.optional(),
        image_url: z.string().url().optional(),
        date_modified: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
  })
  .strict();
export type CalibrationSnapshot = z.infer<typeof CalibrationSnapshotSchema>;

export const CalibrationClassificationSchema = z.enum([
  "true_pipeline_false_positive",
  "true_pipeline_false_negative",
  "expected_editorial_difference",
  "missing_or_ambiguous_reference_guidance",
  "mock_provider_limitation",
  "recommended_rule_or_reference_adjustment",
]);
export type CalibrationClassification = z.infer<typeof CalibrationClassificationSchema>;

export const CalibrationDimensionSchema = z.enum([
  "structure",
  "direct_answer",
  "takeaways",
  "heading_hierarchy",
  "keyword_placement_non_numeric_concentration",
  "readability",
  "faq",
  "internal_links",
  "information_gain",
  "factual_figures",
  "product_claims",
  "attribution",
  "on_page_metadata",
  "coherence",
]);

export const CalibrationEvidenceSchema = z
  .object({
    source: z.enum(["published_snapshot", "generated_pipeline", "deterministic_checker"]),
    citation: nonEmpty,
    excerpt: nonEmpty.max(500),
  })
  .strict();

export const CalibrationObservationSchema = z
  .object({
    dimension: CalibrationDimensionSchema,
    classification: CalibrationClassificationSchema,
    summary: nonEmpty,
    metrics: z
      .object({
        published: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        generated: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        published_rule_ids: z.array(nonEmpty),
        generated_rule_ids: z.array(nonEmpty),
      })
      .strict(),
    evidence: z.array(CalibrationEvidenceSchema).min(2),
    recommendation: nonEmpty,
  })
  .strict();
export type CalibrationObservation = z.infer<typeof CalibrationObservationSchema>;

export const CalibrationPipelineOutcomeSchema = z.enum(["succeeded", "blocked"]);

export const CalibrationPostResultSchema = z
  .object({
    slot: CalibrationSlotSchema,
    snapshot_hash: hash,
    pipeline_run_id: z.string().uuid(),
    final_document_version_id: z.string().uuid(),
    export_id: z.string().uuid().nullable(),
    pipeline_outcome: CalibrationPipelineOutcomeSchema,
    pipeline_outcome_code: z.enum(["PIPELINE_EXPORTED", "DETERMINISTIC_BLOCKER"]),
    handoff: HandoffSchema,
    generated_content_hash: hash,
    generated_markdown: nonEmpty,
    generated_on_page: z
      .object({
        meta_title: z.string(),
        meta_description: z.string(),
        slug: nonEmpty,
        faqs: z.array(z.object({ question: z.string(), answer: z.string() }).strict()),
      })
      .strict(),
    published_findings: z.array(FindingSchema),
    generated_findings: z.array(FindingSchema),
    observations: z.array(CalibrationObservationSchema),
    proposed_reference_changes: z.array(
      z
        .object({
          reference_kind: z.enum([
            "blog_writing_guide",
            "writer_submission_sample",
            "keyword_placement_guidelines",
            "internal_linking_guidelines",
            "fact_checking_rules",
            "pipeline_workflow",
          ]),
          rationale: nonEmpty,
          proposed_markdown: nonEmpty,
        })
        .strict(),
    ),
  })
  .strict();
export type CalibrationPostResult = z.infer<typeof CalibrationPostResultSchema>;

export const CalibrationCombinedReportSchema = z
  .object({
    calibration_run_id: z.string().uuid(),
    snapshot_hashes: z.array(hash).length(2),
    result_hashes: z.array(hash).length(2),
    classification_counts: z.record(
      CalibrationClassificationSchema,
      z.number().int().nonnegative(),
    ),
    shared_recommendations: z.array(nonEmpty),
    rule_weakening_prohibited: z.literal(true),
    provenance_remains_hard_flagged: z.literal(true),
    unresolved_claims_remain_unverified: z.literal(true),
    generated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CalibrationCombinedReport = z.infer<typeof CalibrationCombinedReportSchema>;

export const CalibrationRunStatusSchema = z.enum([
  "queued",
  "retrieving",
  "comparing",
  "reporting",
  "retryable_failed",
  "succeeded",
]);
export const CalibrationRunDetailSchema = z
  .object({
    id: z.string().uuid(),
    idempotency_key: nonEmpty,
    input_hash: hash,
    status: CalibrationRunStatusSchema,
    checkpoint: z.enum(["created", "snapshots", "post_1", "post_2", "combined"]),
    error: z.enum(["CALIBRATION_OPERATION_FAILED"]).nullable(),
    lease_owner: z.string().nullable(),
    lease_expires_at: z.string().datetime({ offset: true }).nullable(),
    snapshot_count: z.number().int().min(0).max(2),
    result_count: z.number().int().min(0).max(2),
    has_combined_report: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CalibrationRunDetail = z.infer<typeof CalibrationRunDetailSchema>;

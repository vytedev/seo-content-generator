import { z } from "zod";
import {
  CheckerInputSchema,
  FindingLocationSchema,
  FindingSeveritySchema,
  InternalLinkHierarchySchema,
  type CheckerInput,
} from "./checker/index.js";
import {
  HandoffSchema,
  PipelineStepIdSchema,
  type Handoff,
  type PipelineStepId,
} from "./pipeline.js";
import { LinkReviewContextSchema } from "./link-conversion-review.js";
import { HardFlagReasonSchema } from "./hard-flags.js";
import type { DeterministicManifest, DeterministicRunResult } from "./deterministic-run.js";
import {
  InternalLinkSchema,
  StructuredDraftSchema,
  type DocumentVersionRecord,
  type InternalLink,
  type StructuredDraft,
} from "./milestone-two.js";

const text = z.string().trim().min(1);
export const REVIEW_STEPS = [
  "review_writing_style",
  "review_information_gain",
  "review_fact_checking",
  "review_link_conversion",
] as const satisfies readonly PipelineStepId[];
export const ReviewStepSchema = z.enum(REVIEW_STEPS);
export type ReviewStep = z.infer<typeof ReviewStepSchema>;

/** Explicit local fixture for true deterministic context not owned by the draft. */
export const DeterministicFixtureSchema = z
  .object({
    internal_origins: z.array(z.string().url()).min(1),
    link_verification: z.array(
      z
        .object({
          url: z.string().url(),
          status: z.number().int().min(100).max(599),
          hierarchy: InternalLinkHierarchySchema,
          hierarchy_rank: z.number().int().min(1).max(6),
        })
        .strict(),
    ),
  })
  .strict();
export type DeterministicFixture = z.infer<typeof DeterministicFixtureSchema>;

export const DeterministicInputContractSchema = z
  .object({
    run_id: text,
    document_version_id: text,
    handoff: HandoffSchema,
    draft: StructuredDraftSchema,
    persisted_links: z.array(InternalLinkSchema),
    fixture: DeterministicFixtureSchema,
  })
  .strict();
export type DeterministicInputContract = z.infer<typeof DeterministicInputContractSchema>;

export function mapDeterministicInput(raw: DeterministicInputContract): CheckerInput {
  const input = DeterministicInputContractSchema.parse(raw);
  const persisted = new Set(input.persisted_links.map((link) => link.url));
  for (const mapping of input.fixture.link_verification) {
    if (!persisted.has(mapping.url))
      throw new Error(`Fixture maps an unpersisted link: ${mapping.url}`);
  }
  const discoveredVerification = input.persisted_links.flatMap((link) =>
    link.status && link.hierarchy && link.hierarchy_rank
      ? [
          {
            url: link.url,
            status: link.status,
            hierarchy: link.hierarchy,
            hierarchy_rank: link.hierarchy_rank,
          },
        ]
      : [],
  );
  return CheckerInputSchema.parse({
    primary_keyword: input.handoff.primary_keyword,
    related_keywords: input.handoff.related_keywords,
    body_markdown: input.draft.markdown,
    on_page: {
      meta_title: input.draft.meta_title ?? input.draft.title,
      meta_description: input.draft.meta_description,
      slug: input.draft.slug,
      og_title: input.draft.og_title,
      og_description: input.draft.og_description,
      images: input.draft.images.map(({ alt, filename }) => ({ alt, filename })),
      faqs: input.draft.faqs,
    },
    internal_origins: input.fixture.internal_origins,
    verified_internal_links:
      discoveredVerification.length > 0 ? discoveredVerification : input.fixture.link_verification,
  });
}

export const ReviewFindingSchema = z
  .object({
    stable_key: text.regex(/^[a-z0-9][a-z0-9._:-]*$/),
    category: text,
    rule_reference: text,
    severity: FindingSeveritySchema,
    location: FindingLocationSchema,
    issue: text,
    evidence: text.optional(),
    suggested_fix: text,
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
const PersistedReviewFindingObjectSchema = ReviewFindingSchema.extend({
  /** Required application-owned classification; provider payloads cannot supply it. */
  hard_flag: z.boolean(),
  /** Persisted additively from S2; absent on historical rows. */
  hard_flag_reason: HardFlagReasonSchema.nullable().optional(),
}).strict();
export const PersistedReviewFindingSchema = PersistedReviewFindingObjectSchema.superRefine(
  (finding, context) => {
    if (!finding.hard_flag && finding.hard_flag_reason)
      context.addIssue({
        code: "custom",
        path: ["hard_flag_reason"],
        message: "A non-hard-flagged finding cannot have a mandatory-review reason.",
      });
  },
);
export type PersistedReviewFinding = z.infer<typeof PersistedReviewFindingSchema>;

export const FactInventoryItemSchema = z
  .object({
    stable_key: text,
    text,
    classification: z.enum(["factual_claim", "factual_figure", "attribution_provenance"]),
    claim_type: z.enum([
      "dimension",
      "material",
      "price",
      "delivery",
      "statistic",
      "provenance",
      "general",
    ]),
    location: FindingLocationSchema,
    /** Copied only from structured draft claim metadata; adapters must not infer it from prose. */
    product_identifier: text.optional(),
  })
  .strict();
export type FactInventoryItem = z.infer<typeof FactInventoryItemSchema>;

export const ReferenceSnapshotSchema = z
  .object({
    kind: text,
    version_id: text,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    immutable_pointer: text,
    content: text,
  })
  .strict();

export const ReviewRequestSchema = z
  .object({
    run_id: text,
    step: ReviewStepSchema,
    document_version_id: text,
    handoff: HandoffSchema,
    draft: StructuredDraftSchema,
    internal_links: z.array(InternalLinkSchema),
    reference_snapshots: z.array(ReferenceSnapshotSchema),
    fact_inventory: z.array(FactInventoryItemSchema),
    link_review_context: LinkReviewContextSchema.optional(),
    prompt: z.object({ template_id: text, template_version: text }).strict(),
    temperature: z.number().min(0).max(2),
    model: text,
  })
  .strict();
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

const usage = z
  .object({
    input_units: z.number().int().nonnegative(),
    output_units: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative().optional(),
  })
  .strict();
export const ReviewSourceSchema = z
  .object({
    stable_key: text,
    /** Local mocks use mock:// URIs; real evidence providers use https:// URIs. */
    uri: z
      .string()
      .refine(
        (value) => value.startsWith("mock://") || value.startsWith("https://"),
        "Source URIs must be mock:// (local fixtures) or https:// (real evidence)",
      ),
    title: text,
    source_type: z.enum(["unresolved", "medusa_store", "public_storefront", "approved_gateway"]),
    /** App-owned observation time. Upstream timestamps are never accepted as retrieval time. */
    retrieved_at: z.string().datetime({ offset: true }),
    snapshot: z.record(z.string(), z.unknown()),
    evidence: text,
  })
  .strict();
/** @deprecated Prefer ReviewSourceSchema; retained while mocks migrate. */
export const MockSourceSchema = ReviewSourceSchema;
export const ReviewedClaimSchema = z
  .object({
    stable_key: text,
    claim_text: text,
    type: z.enum([
      "dimension",
      "material",
      "price",
      "delivery",
      "statistic",
      "provenance",
      "general",
    ]),
    status: z.enum(["verified", "unverified", "contradicted"]),
    location: FindingLocationSchema,
    hard_flag: z.boolean(),
    /** Persisted additively from S2; absent on historical rows. */
    hard_flag_reason: HardFlagReasonSchema.nullable().optional(),
    source_key: text,
    inventory_key: text.optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.type === "provenance" && !claim.hard_flag)
      context.addIssue({
        code: "custom",
        path: ["hard_flag"],
        message: "Provenance claims are always hard flagged.",
      });
    if (!claim.hard_flag && claim.hard_flag_reason)
      context.addIssue({
        code: "custom",
        path: ["hard_flag_reason"],
        message: "A non-hard-flagged claim cannot have a mandatory-review reason.",
      });
  });
export const ReviewResponseSchema = z
  .object({
    request_id: text,
    findings: z.array(ReviewFindingSchema),
    sources: z.array(ReviewSourceSchema).default([]),
    claims: z.array(ReviewedClaimSchema).default([]),
    usage,
  })
  .strict();
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
export const PersistedReviewResponseSchema = ReviewResponseSchema.extend({
  findings: z.array(PersistedReviewFindingSchema),
}).strict();
export type PersistedReviewResponse = z.infer<typeof PersistedReviewResponseSchema>;

export const EvidenceSourceProjectionSchema = z
  .object({
    url: z.string().max(2_048),
    extraction_method: z.string().max(120),
    retrieved_at: z.string().datetime({ offset: true }),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
    excerpt: z.string().max(2_000),
    selection_reason: z.string().max(500),
  })
  .strict();
export type EvidenceSourceProjection = z.infer<typeof EvidenceSourceProjectionSchema>;

export const FindingRecordSchema = PersistedReviewFindingObjectSchema.extend({
  id: text,
  run_id: text,
  document_version_id: text,
  step_execution_id: text,
  step: PipelineStepIdSchema,
  disposition: z.enum(["accepted", "rejected"]).nullable(),
  rationale: z.string().nullable(),
  /** Optional for historical/non-fact findings; never contains raw HTML. */
  evidence_sources: z.array(EvidenceSourceProjectionSchema).optional(),
})
  .strict()
  .superRefine((finding, context) => {
    if (!finding.hard_flag && finding.hard_flag_reason)
      context.addIssue({
        code: "custom",
        path: ["hard_flag_reason"],
        message: "A non-hard-flagged finding cannot have a mandatory-review reason.",
      });
  });
export type FindingRecord = z.infer<typeof FindingRecordSchema>;

export const FindingFiltersSchema = z
  .object({
    step: PipelineStepIdSchema.optional(),
    severity: FindingSeveritySchema.optional(),
    category: text.optional(),
    disposition: z.enum(["accepted", "rejected", "pending"]).optional(),
  })
  .strict();
export const BulkDispositionSchema = z
  .object({
    document_version_id: text,
    idempotency_key: text.regex(/^[A-Za-z0-9._:-]{8,128}$/),
    dispositions: z
      .array(
        z
          .object({
            finding_id: text,
            decision: z.enum(["accepted", "rejected"]),
            rationale: text.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.dispositions.map((item) => item.finding_id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["dispositions"],
        message: "Finding IDs must be unique.",
      });
  });
export type BulkDisposition = z.infer<typeof BulkDispositionSchema>;

export type ReferenceSnapshot = z.infer<typeof ReferenceSnapshotSchema>;

export interface MilestoneThreeRepository {
  stepSucceeded(runId: string, step: PipelineStepId): Promise<boolean>;
  stepWaiting(runId: string, step: PipelineStepId): Promise<boolean>;
  claimStep(
    runId: string,
    step: PipelineStepId,
    owner: string,
  ): Promise<{ execution_id: string; token: string }>;
  /** Extends a live lease by the configured duration; false when no longer held. */
  heartbeatStep(executionId: string, token: string): Promise<boolean>;
  /** Operator stop: cancels a running run and revokes its in-flight leases. */
  cancelRun(runId: string): Promise<void>;
  completeStep(executionId: string, token: string): Promise<void>;
  failStep(executionId: string, token: string, error: string): Promise<void>;
  getHandoff(runId: string): Promise<Handoff>;
  getLinks(runId: string): Promise<InternalLink[] | null>;
  getLinksArtifact(
    runId: string,
  ): Promise<import("./milestone-two.js").InternalLinksArtifactSnapshot | null>;
  getDraft(
    runId: string,
  ): Promise<{ draft: StructuredDraft; version: DocumentVersionRecord } | null>;
  snapshotReferences(
    runId: string,
    executionId: string,
    token: string,
  ): Promise<ReferenceSnapshot[]>;
  hasStepOutput(runId: string, documentVersionId: string, step: PipelineStepId): Promise<boolean>;
  /** Atomically persists Step 1.4 manifest, result, findings, output and success. */
  saveDeterministicBaseline(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    manifest: DeterministicManifest;
    result: DeterministicRunResult;
    findings: PersistedReviewFinding[];
  }): Promise<void>;
  getDeterministicManifest(
    runId: string,
  ): Promise<{ manifest: DeterministicManifest; result: DeterministicRunResult }>;
  /** Atomically persists the immutable output and succeeds its producing attempt. */
  saveFindings(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    findings: PersistedReviewFinding[],
    /** When false the producing attempt stays open, so the same lease may park the wait. */
    complete?: boolean,
  ): Promise<void>;
  beginReviewOperation(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    step: ReviewStep;
    request: ReviewRequest;
    provider: string;
    model: string;
  }): Promise<{ operation_id: string; response: PersistedReviewResponse | null }>;
  markReviewProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void>;
  releaseReviewProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("./paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void>;
  checkpointReviewResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: PersistedReviewResponse;
  }): Promise<void>;
  saveReview(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    step: ReviewStep,
    request: ReviewRequest,
    response: PersistedReviewResponse,
    provider: string,
    model: string,
    /** Provider-owned checkpoint when the final response also includes application-owned findings. */
    checkpointResponse?: PersistedReviewResponse,
  ): Promise<void>;
  waitForFindings(runId: string, executionId: string, token: string): Promise<void>;
  /**
   * Opens a controlled editorial-correction review round for the same immutable
   * document version. Atomic, fenced and idempotent; prior rounds are preserved.
   */
  openEditorialCorrectionRound(input: {
    run_id: string;
    document_version_id: string;
    expected_content_hash: string;
    checker_version: string;
    findings: PersistedReviewFinding[];
  }): Promise<{ status: "opened" | "replayed"; review_set_id: string; round: number }>;
  listFindings(
    runId: string,
    filters: z.infer<typeof FindingFiltersSchema>,
  ): Promise<FindingRecord[]>;
  submitDispositions(
    runId: string,
    input: BulkDisposition,
  ): Promise<{ completed: boolean; submitted: number; continuation_required: boolean }>;
}

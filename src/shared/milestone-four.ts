import { z } from "zod";
import { FindingLocationSchema, FindingSeveritySchema } from "./checker/index.js";
import {
  ArtifactSchema,
  DocumentVersionSchema,
  StructuredDraftSchema,
  type ArtifactRecord,
  type DocumentVersionRecord,
  type StructuredDraft,
} from "./contracts/content.js";
import {
  RunDetailSchema,
  UsageTotalsSchema,
  type RunDetail,
  type RunSummary,
  type UsageTotals,
} from "./contracts/run-detail.js";
import type { RunListPage, RunListQuery } from "./contracts/run-list.js";
import {
  ExportClaimSchema,
  ExportRenderInputSchema,
  ExportRenderResultSchema,
  ExportRejectedFindingSchema,
  GoogleDocsExportSchema,
} from "./export.js";
import { ReferenceSnapshotSchema, ReviewFindingSchema } from "./milestone-three.js";
import { InternalLinkSchema } from "./milestone-two.js";
import { HandoffSchema, PIPELINE_STEPS, PipelineStepIdSchema } from "./pipeline.js";
import type { DeterministicManifest, DeterministicRunResult } from "./deterministic-run.js";
import {
  FindingResultSchema,
  RevisionHunkSchema,
  type FindingResult,
  type RevisionAudit,
} from "./revision-application.js";

export {
  RunDetailSchema,
  UsageTotalsSchema,
  type RunDetail,
  type UsageTotals,
} from "./contracts/run-detail.js";

const text = z.string().trim().min(1);
const usage = z
  .object({
    input_units: z.number().int().nonnegative(),
    output_units: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export const RevisionFindingSchema = ReviewFindingSchema.extend({
  id: text,
  disposition: z.literal("accepted"),
  origin_document_version_id: text,
}).strict();
export type RevisionFinding = z.infer<typeof RevisionFindingSchema>;

export const RevisionRequestSchema = z
  .object({
    operation_id: text,
    run_id: text,
    document_version_id: text,
    revision: z.number().int().positive(),
    handoff: HandoffSchema,
    current_document: StructuredDraftSchema,
    internal_links: z.array(InternalLinkSchema).optional(),
    accepted_findings: z.array(RevisionFindingSchema),
    revision_source: z
      .enum([
        "operator_findings",
        "deterministic_repair",
        "coherence_repair",
        "operator_authorised_repair",
      ])
      .optional(),
    reference_snapshots: z.array(ReferenceSnapshotSchema),
    prompt: z
      .object({ template_id: z.literal("mobelaris.revision_pass"), template_version: text })
      .strict(),
    model: text,
    temperature: z.number().min(0).max(2),
  })
  .strict();
export type RevisionRequest = z.infer<typeof RevisionRequestSchema>;
export const RevisionResponseSchema = z
  .object({ document: StructuredDraftSchema, finding_results: z.array(FindingResultSchema), usage })
  .strict();
export type RevisionResponse = z.infer<typeof RevisionResponseSchema>;
export type { FindingResult, RevisionAudit };

export const REVISION_SAFE_FAILURE_CATEGORIES = [
  "configuration",
  "malformed_response",
  "transient_exhausted",
  "timeout",
  "guard_rejected",
] as const;
export const RevisionSafeFailureCategorySchema = z.enum(REVISION_SAFE_FAILURE_CATEGORIES);
export type RevisionSafeFailureCategory = z.infer<typeof RevisionSafeFailureCategorySchema>;
export interface RevisionFailureIdentity {
  provider: string;
  model: string;
  prompt_version: string;
  planning_version: string;
}

export const COHERENCE_CATEGORIES = [
  "grammar",
  "broken_messaging",
  "inconsistency",
  "redundancy",
] as const;
export const CoherenceFindingSchema = ReviewFindingSchema.extend({
  category: z.enum(COHERENCE_CATEGORIES),
  rule_reference: z.enum([
    "coherence.grammar",
    "coherence.broken_messaging",
    "coherence.inconsistency",
    "coherence.redundancy",
  ]),
})
  .strict()
  .superRefine((finding, context) => {
    if (finding.rule_reference !== `coherence.${finding.category}`)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rule_reference"],
        message: "Coherence rule must match its category",
      });
  });
export type CoherenceFinding = z.infer<typeof CoherenceFindingSchema>;

export const CoherenceRequestSchema = z
  .object({
    operation_id: text,
    run_id: text,
    parent_document_version_id: text,
    document_version_id: text,
    revision_reason: z.enum([
      "operator_findings",
      "deterministic_repair",
      "coherence_repair",
      "operator_authorised_repair",
    ]),
    coherence_cycle: z.number().int().min(0).max(2),
    handoff: HandoffSchema,
    parent_document: StructuredDraftSchema,
    current_document: StructuredDraftSchema,
    revision_audits: z.array(
      z
        .object({
          finding_id: text,
          status: z.enum(["applied", "unable"]),
          reason: text,
          location: FindingLocationSchema,
          hunks: z.array(RevisionHunkSchema),
          changed: z.boolean(),
          before_hash: z.string().length(64),
          after_hash: z.string().length(64),
        })
        .strict(),
    ),
    deterministic_result_hash: z.string().length(64),
    reference_snapshots: z.array(ReferenceSnapshotSchema),
    prompt: z
      .object({ template_id: z.literal("mobelaris.final_coherence"), template_version: text })
      .strict(),
    model: text,
    temperature: z.number().min(0).max(2),
  })
  .strict();
export type CoherenceRequest = z.infer<typeof CoherenceRequestSchema>;
export const CoherenceResponseSchema = z
  .object({ findings: z.array(CoherenceFindingSchema), usage })
  .strict();
export type CoherenceResponse = z.infer<typeof CoherenceResponseSchema>;

export function assertCoherenceBlockerEligibility(
  request: CoherenceRequest,
  response: CoherenceResponse,
): void {
  const allowed = new Set([
    "body_markdown",
    "markdown",
    "title",
    "meta_description",
    "og_title",
    "og_description",
    "slug",
    "images",
    "faqs",
    // Canonical structured draft paths are persisted below the on_page root
    // (for example on_page.faqs.3.answer). Exact audit matching below still
    // limits eligibility to fields the controlled revision actually changed.
    "on_page",
  ]);
  const lines = request.current_document.markdown.split("\n");
  const sectionRange = (name: string) => {
    const matches = lines.flatMap((line, index) =>
      /^#{1,6}\s+(.+)$/.exec(line)?.[1]?.trim().toLocaleLowerCase("en-GB") ===
      name.trim().toLocaleLowerCase("en-GB")
        ? [index + 1]
        : [],
    );
    if (matches.length !== 1) return null;
    const start = matches[0]!,
      next = lines.findIndex((line, index) => index + 1 > start && /^#{1,6}\s+/.test(line));
    return { start, end: next < 0 ? lines.length : next };
  };
  for (const finding of response.findings) {
    const fieldRoot = finding.location.field.split(".")[0]!;
    if (!allowed.has(finding.location.field) && !allowed.has(fieldRoot))
      throw new Error("Coherence finding uses a disallowed field");
    const isMarkdown =
      finding.location.field === "body_markdown" || finding.location.field === "markdown";
    const hasLineRange = finding.location.line_start !== undefined;
    const hasSection = finding.location.section !== undefined;
    if (isMarkdown && hasLineRange === hasSection)
      throw new Error("Coherence finding requires exactly one precise locator");
    if (!isMarkdown && (hasLineRange || hasSection))
      throw new Error("Structured coherence finding requires an exact field locator");
    const range =
      finding.location.line_start !== undefined
        ? {
            start: finding.location.line_start,
            end: finding.location.line_end ?? finding.location.line_start,
          }
        : finding.location.section
          ? sectionRange(finding.location.section)
          : null;
    if (range && (range.start < 1 || range.end < range.start || range.end > lines.length))
      throw new Error("Coherence finding location is outside the current document");
    const eligible = request.revision_audits.some((audit) => {
      if (!audit.changed || audit.location.field !== finding.location.field) return false;
      if (!isMarkdown) return JSON.stringify(audit.location) === JSON.stringify(finding.location);
      return Boolean(
        range &&
        audit.hunks.some(
          (hunk) => hunk.proposed_start <= range.end && hunk.proposed_end >= range.start,
        ),
      );
    });
    if (!eligible)
      throw new Error("Coherence finding does not intersect an exact persisted changed hunk");
  }
}

export const FinalGateSchema = z
  .object({
    deterministic_blockers: z.number().int().nonnegative(),
    coherence_blockers: z.number().int().nonnegative(),
    outcome: z.enum(["revise", "blocked", "export"]),
  })
  .strict();
export type FinalGate = z.infer<typeof FinalGateSchema>;

export const PersistedCoherenceSchema = z
  .object({
    operation_id: text,
    response: CoherenceResponseSchema,
    gate: FinalGateSchema,
    producing_step_execution_id: text,
  })
  .strict();
export type PersistedCoherence = z.infer<typeof PersistedCoherenceSchema>;

export interface FinalExportService {
  export(input: {
    run_id: string;
    step_execution_id: string;
    fencing_token: string;
    document_version_id: string;
    idempotency_key: string;
    render_input: z.infer<typeof ExportRenderInputSchema>;
    rendered: z.infer<typeof ExportRenderResultSchema>;
  }): Promise<z.infer<typeof GoogleDocsExportSchema>>;
}

export interface MilestoneFourRepository {
  stepSucceeded(runId: string, step: z.infer<typeof PipelineStepIdSchema>): Promise<boolean>;
  claimStep(
    runId: string,
    step: z.infer<typeof PipelineStepIdSchema>,
    owner: string,
  ): Promise<{ execution_id: string; token: string }>;
  /** Extends a live lease by the configured duration; false when no longer held. */
  heartbeatStep(executionId: string, token: string): Promise<boolean>;
  /** Operator stop: cancels a running run and revokes its in-flight leases. */
  cancelRun(runId: string): Promise<void>;
  failStep(executionId: string, token: string, error: string): Promise<void>;
  getHandoff(runId: string): Promise<z.infer<typeof HandoffSchema>>;
  getLinks(runId: string): Promise<Array<{ url: string; title: string; relevance: number }> | null>;
  getLinksArtifact(
    runId: string,
  ): Promise<import("./milestone-two.js").InternalLinksArtifactSnapshot | null>;
  getDraft(runId: string): Promise<{
    draft: StructuredDraft;
    artifact: ArtifactRecord;
    version: DocumentVersionRecord;
    legacy_derived_fields?: import("./contracts/content.js").LegacyDerivedField[];
  } | null>;
  snapshotReferences(
    runId: string,
    executionId: string,
    token: string,
  ): Promise<z.infer<typeof ReferenceSnapshotSchema>[]>;
  getRevisionFindings(
    runId: string,
    documentVersionId: string,
  ): Promise<{
    source:
      | "operator_findings"
      | "deterministic_repair"
      | "coherence_repair"
      | "operator_authorised_repair";
    findings: RevisionFinding[];
    rejected_locations: z.infer<typeof FindingLocationSchema>[];
    verified_fact_locations: z.infer<typeof FindingLocationSchema>[];
    /**
     * Complete readability authority frozen by an exceptional authorisation,
     * keyed by finding id. Present only for `operator_authorised_repair`.
     */
    authorised_readability?: Record<
      string,
      {
        blocks: Array<{ line_start: number; line_end: number }>;
        selector_version?: string;
        target_set_identity?: string;
      }
    >;
  }>;
  beginRevisionOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    document_version_id: string;
    request: RevisionRequest;
  }): Promise<RevisionResponse | null>;
  markRevisionProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void>;
  /** Durable pre-dispatch marker for the single paid coherence call. */
  markCoherenceProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void>;
  /** Narrowly proven non-dispatch release only; never clears a checkpointed response. */
  releaseCoherenceProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void>;
  releaseRevisionProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void>;
  checkpointRevisionResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: RevisionResponse;
  }): Promise<void>;
  getRevisionFailureLock(
    runId: string,
    identity: RevisionFailureIdentity,
  ): Promise<{ category: RevisionSafeFailureCategory; failures: number } | null>;
  recordRevisionFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    identity: RevisionFailureIdentity;
    category: RevisionSafeFailureCategory;
  }): Promise<void>;
  /** Fact-check claims for the export artefact (1.12), read back from 1.7 output. */
  getExportClaims(
    runId: string,
    documentVersionId: string,
  ): Promise<z.infer<typeof ExportClaimSchema>[]>;
  /** Findings rejected from the frozen Step 1.9 review set, surfaced as outstanding in the export. */
  getRejectedFindings(
    runId: string,
    finalDocumentVersionId: string,
  ): Promise<z.infer<typeof ExportRejectedFindingSchema>[]>;
  /** Selects and freezes the explicit persisted template rows authorised for this export. */
  getContentTemplates(): Promise<{
    writer_template: import("./export.js").WriterTemplate;
    schema_template: import("./export.js").BlogSchemaTemplate;
  }>;
  saveRevision(input: {
    run_id: string;
    execution_id: string;
    token: string;
    request: RevisionRequest;
    response: RevisionResponse;
    provider: string;
    model: string;
    audits: RevisionAudit[];
  }): Promise<{ draft: StructuredDraft; artifact: ArtifactRecord; version: DocumentVersionRecord }>;
  completeRevisionNoop(input: {
    run_id: string;
    execution_id: string;
    token: string;
    document_version_id: string;
    operation_id: string;
    source:
      | "operator_findings"
      | "deterministic_repair"
      | "coherence_repair"
      | "operator_authorised_repair";
  }): Promise<void>;
  getDeterministicManifest(
    runId: string,
  ): Promise<{ manifest: DeterministicManifest; result: DeterministicRunResult }>;
  saveRerun(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    result: DeterministicRunResult;
    findings: z.infer<typeof ReviewFindingSchema>[];
  }): Promise<"continue" | "repair" | "blocked">;
  getDeterministicGate(
    runId: string,
    documentVersionId: string,
  ): Promise<{
    retained_blockers: number;
    introduced_blockers: number;
    exact_document_match: boolean;
    result_hash: string;
  }>;
  getCoherenceRevisionContext(
    runId: string,
    documentVersionId: string,
  ): Promise<{
    parent_document_version_id: string;
    parent_document: StructuredDraft;
    revision_reason:
      | "operator_findings"
      | "deterministic_repair"
      | "coherence_repair"
      | "operator_authorised_repair";
    coherence_cycle: number;
    revision_audits: Array<{
      finding_id: string;
      status: "applied" | "unable";
      reason: string;
      location: z.infer<typeof FindingLocationSchema>;
      hunks: z.infer<typeof RevisionHunkSchema>[];
      changed: boolean;
      before_hash: string;
      after_hash: string;
    }>;
  }>;
  blockFinalForDeterministic(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void>;
  beginCoherenceOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    document_version_id: string;
    request: CoherenceRequest;
  }): Promise<CoherenceResponse | null>;
  checkpointCoherenceResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: CoherenceResponse;
  }): Promise<void>;
  recoverCoherence(
    runId: string,
    documentVersionId: string,
    operationId: string,
    recoveryExecutionId: string,
    token: string,
  ): Promise<PersistedCoherence | null>;
  saveCoherence(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    request: CoherenceRequest;
    response: CoherenceResponse;
    provider: string;
    model: string;
  }): Promise<"revise" | "blocked" | "export">;
  completeFinal(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void>;
  /** Reopens only a legacy deterministic block with repair budget remaining. */
  recoverDeterministicBlock(runId: string): Promise<boolean>;
  /** Atomically records the single exceptional operator authorisation and reopens its exact block. */
  authoriseExceptionalCorrection(input: {
    run_id: string;
    idempotency_key: string;
    explicit_confirmation: true;
  }): Promise<"authorised" | "replay">;
  getRunDetail(runId: string): Promise<RunDetail>;
  getUsageTotals(runId: string): Promise<UsageTotals>;
  listRuns(limit: number): Promise<RunSummary[]>;
  listRunPage(query: RunListQuery): Promise<RunListPage>;
}

export const PIPELINE_PRESENTATION = new Map(PIPELINE_STEPS.map((step) => [step.id, step]));

/** Maps a checker finding location (bare or on_page-prefixed, optionally indexed) to the guarded draft field it authorises. */
type RevisionGuardedField = "og_title" | "og_description" | "images" | "faqs";

function guardedFieldForFinding(field: string): RevisionGuardedField | null {
  const root = findingRoot(field);
  return root === "og_title" || root === "og_description" || root === "images" || root === "faqs"
    ? root
    : null;
}

/** The first meaningful location segment, stripping a leading on_page and array indices. */
function findingRoot(field: string): string {
  const segments = field.split(".");
  const root = (segments[0] === "on_page" ? segments[1] : segments[0]) ?? "";
  return root === "meta_title" ? "title" : root;
}

/**
 * An accepted finding against the meta counterpart also authorises the
 * mirroring Open Graph field. The deterministic checks (1.4/1.11) have no
 * OG-specific rules, so no finding can ever name og_title/og_description
 * directly — while a compliant meta fix conventionally mirrors into the OG
 * fields. Without this mapping any meta fix that mirrors would be rejected
 * forever (the guard would deadlock the revision pass).
 */
const MIRROR_AUTHORITY: Partial<Record<string, "og_title" | "og_description">> = {
  title: "og_title",
  meta_description: "og_description",
};

export type RevisionGuardReason =
  "primary_keyword_removed" | "claims_changed" | "duplicate_finding" | "unguarded_field_changed";

/** Safe, structured diagnostics contain identifiers and enums only, never draft or claim text. */
export class RevisionGuardError extends Error {
  override readonly name = "RevisionGuardError";
  readonly code = "REVISION_GUARD_REJECTED";

  constructor(
    message: string,
    readonly diagnostics: {
      reason: RevisionGuardReason;
      run_id: string;
      document_version_id: string;
      field?: RevisionGuardedField;
    },
  ) {
    super(message);
  }
}

/** Rejects model changes which introduce intent or factual claims not present in the handoff/current version. */
export function assertSafeRevision(request: RevisionRequest, revised: StructuredDraft): void {
  const reject = (
    reason: RevisionGuardReason,
    message: string,
    field?: RevisionGuardedField,
  ): never => {
    throw new RevisionGuardError(message, {
      reason,
      run_id: request.run_id,
      document_version_id: request.document_version_id,
      ...(field ? { field } : {}),
    });
  };
  const keyword = request.handoff.primary_keyword.toLocaleLowerCase("en-GB");
  const searchable = `${revised.title}\n${revised.markdown}`.toLocaleLowerCase("en-GB");
  if (!searchable.includes(keyword))
    reject("primary_keyword_removed", "Revision removed the handoff primary keyword intent");
  if (JSON.stringify(request.current_document.claims) !== JSON.stringify(revised.claims))
    reject(
      "claims_changed",
      "Revision introduced, removed or altered an unsupported factual claim",
    );
  const allowed = new Set(request.accepted_findings.map((finding) => finding.id));
  if (allowed.size !== request.accepted_findings.length)
    reject("duplicate_finding", "Duplicate accepted finding");

  const acceptedFields = new Set<string>();
  for (const finding of request.accepted_findings) {
    const guarded = guardedFieldForFinding(finding.location.field);
    if (guarded) acceptedFields.add(guarded);
    const root = findingRoot(finding.location.field);
    const mirrored = MIRROR_AUTHORITY[root];
    if (mirrored) {
      const source = root === "title" ? "title" : "meta_description";
      if (
        request.current_document[mirrored] === request.current_document[source] &&
        revised[mirrored] === revised[source]
      )
        acceptedFields.add(mirrored);
    }
  }
  for (const field of ["og_title", "og_description", "images", "faqs"] as const) {
    if (
      JSON.stringify(request.current_document[field]) !== JSON.stringify(revised[field]) &&
      !acceptedFields.has(field)
    )
      reject(
        "unguarded_field_changed",
        `Revision altered ${field} without an accepted finding`,
        field,
      );
  }
}

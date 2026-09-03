import { randomUUID } from "node:crypto";
import { REFERENCE_DOCUMENT_SEED_MANIFEST } from "../../db/reference-seed.js";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  ExportClaimSchema,
  ExportRejectedFindingSchema,
  type ExportClaim,
  type ExportRejectedFinding,
} from "../../shared/export.js";
import {
  ConflictError,
  NotFoundError,
  RepositoryConflictError,
  UnprocessableError,
} from "../../shared/errors.js";
import { QueueOptionsSchema, type QueueLease, type QueueOptions } from "../../shared/queue.js";
import { PaidOperationProjectionSchema } from "../../shared/paid-operation.js";
import { projectHardFlagReason } from "../../shared/hard-flags.js";
import { paidOperationAmbiguity } from "../providers/paid-operation-lifecycle.js";
import { SerpEvidenceSchema, type SerpEvidence } from "../../shared/ingest-contracts.js";
import { SerpProbeWorkSchema, type SerpProbeWork } from "../../shared/serp-evidence.js";
import { serpWarning } from "../pipeline/serp-probe-worker.js";
import {
  CommandSubmissionResultSchema,
  commandPayloadHash,
  parseCommandActivity,
  parseRunCommand,
  type CommandSubmissionResult,
  type RunCommandRepository,
} from "../../shared/command-repository.js";
import { PIPELINE_STEPS, type Handoff, type PipelineStepId } from "../../shared/pipeline.js";
import { FindingLocationSchema } from "../../shared/checker/index.js";
import { revisionBindingExclusions } from "../../shared/revision-planning.js";
import {
  bindExceptionalBlockers,
  previewExceptionalCorrection,
  type ExceptionalCorrectionFinding,
} from "../../shared/exceptional-recovery.js";
import {
  DeterministicManifestSchema,
  DeterministicRunResultSchema,
  type DeterministicManifest,
  type DeterministicRunResult,
} from "../../shared/deterministic-run.js";
import {
  CoherenceRequestSchema,
  CoherenceResponseSchema,
  RevisionRequestSchema,
  RevisionResponseSchema,
  type CoherenceRequest,
  type CoherenceResponse,
  type PersistedCoherence,
  type MilestoneFourRepository,
  type RevisionFinding,
  type RevisionRequest,
  type RevisionResponse,
  type RevisionFailureIdentity,
  type RevisionSafeFailureCategory,
} from "../../shared/milestone-four.js";
import {
  RunDetailSchema,
  RunSummarySchema,
  UsageTotalsSchema,
  type RunBlockReason,
} from "../../shared/contracts/run-detail.js";
import {
  StructuredDraftSchema,
  readStoredStructuredDraft,
  type ArtifactRecord,
  type DocumentVersionRecord,
  type StructuredDraft,
} from "../../shared/contracts/content.js";
import { GoogleDocsExportSchema, type ExportRenderResult } from "../../shared/export.js";
import {
  RUN_LIST_FILTER_STATUSES,
  RunListPageSchema,
  runListOffset,
  runListPagination,
  type RunListPage,
  type RunListQuery,
} from "../../shared/contracts/run-list.js";
import {
  BulkDispositionSchema,
  FindingFiltersSchema,
  PersistedReviewFindingSchema,
  PersistedReviewResponseSchema,
  ReviewRequestSchema,
  type PersistedReviewResponse,
  type BulkDisposition,
  type FindingRecord,
  type MilestoneThreeRepository,
  type ReferenceSnapshot,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewResponse,
  type ReviewStep,
} from "../../shared/milestone-three.js";
import {
  canonicalHash,
  contentHash,
  LinkDiscoveryMetadataSchema,
  stableId,
  deriveDraftOperationIdentity,
  DraftProviderRequestSchema,
  DraftProviderResponseSchema,
  type DraftOperationCommand,
  type DraftOperationIdentity,
  type DraftProviderResponse,
  type IngestResult,
  type InternalLink,
  type MilestoneRepository,
  type ProviderUsageRecord,
} from "../../shared/milestone-two.js";

interface StepState {
  id: string;
  step: PipelineStepId;
  status:
    "queued" | "running" | "waiting" | "retryable_failed" | "blocked" | "cancelled" | "succeeded";
  attempt: number;
  token: string | null;
  expiresAt: number | null;
  error?: string;
}
interface RunState {
  handoff: Handoff;
  ingest: { key: string; input_hash: string; result: IngestResult };
  status: "running" | "waiting" | "retryable_failed" | "blocked" | "cancelled" | "succeeded";
  currentStep: PipelineStepId;
  coherenceReturnCycles: number;
  deterministicRepairCycles: number;
  exceptionalCorrectionAuthorised: boolean;
  exceptionalCorrectionDocumentId: string | null;
  blockReason: RunBlockReason | null;
  steps: StepState[];
  links: InternalLink[] | null;
  linkDiscoveryMetadata: import("../../shared/milestone-two.js").LinkDiscoveryMetadata | null;
  draft: {
    draft: StructuredDraft;
    canonicalHash: string;
    artifact: ArtifactRecord;
    version: DocumentVersionRecord;
  } | null;
  createdAt: number;
  updatedAt: number;
}

/** Contract-equivalent memory repository used by fast tests. Every retry is a new attempt. */
export class InMemoryMilestoneRepository
  implements
    MilestoneRepository,
    MilestoneThreeRepository,
    MilestoneFourRepository,
    RunCommandRepository
{
  private readonly runs = new Map<string, RunState>();
  private readonly keys = new Map<string, string>();
  readonly commands: import("../../shared/commands.js").RunCommand[] = [];
  readonly commandActivity: import("../../shared/commands.js").RunActivity[] = [];
  private readonly commandResults = new Map<string, CommandSubmissionResult>();
  readonly serpEvidence = new Map<string, SerpEvidence>();
  private readonly serpLeases = new Map<
    string,
    { owner: string; token: string; expiresAt: number }
  >();
  private editorialCorrectionHandler: ((runId: string) => Promise<unknown>) | undefined;
  readonly queueJobs: Array<{
    id: string;
    run_id: string;
    state:
      "ready" | "leased" | "retry_wait" | "parked" | "operator_action" | "completed" | "cancelled";
    attempt: number;
    phase: "pre_downstream" | "downstream_started";
    availableAt: number;
    token: string | null;
    expiresAt: number | null;
    options: QueueOptions;
    pendingRefresh: boolean;
    resumeAfterRefresh: boolean;
    pendingOptions: QueueOptions;
    error?: string;
  }> = [];
  readonly providerUsage: ProviderUsageRecord[] = [];
  readonly artifacts: ArtifactRecord[] = [];
  readonly documentVersions: DocumentVersionRecord[] = [];
  readonly findings: FindingRecord[] = [];
  readonly reviewOperationAdoptions: Array<{
    operation_id: string;
    run_id: string;
    from_step_execution_id: string;
    to_step_execution_id: string;
  }> = [];
  readonly dispositions: Array<{
    finding_id: string;
    decision: "accepted" | "rejected";
    rationale?: string;
  }> = [];
  readonly findingReviewSets: Array<{
    id: string;
    run_id: string;
    document_version_id: string;
    findings_step_execution_id: string;
    membership_hash: string;
    finding_ids: string[];
    /** Review round for the document version; the highest round is active. */
    round: number;
  }> = [];
  readonly findingReviewSubmissions: Array<{
    run_id: string;
    review_set_id: string;
    idempotency_key: string;
    payload_hash: string;
    finding_count: number;
  }> = [];
  readonly referenceSnapshots: Array<ReferenceSnapshot & { step_execution_id: string }> = [];
  readonly activeReferences = new Map(
    REFERENCE_DOCUMENT_SEED_MANIFEST.map((item) => {
      const content = `# ${item.title}\n\nActive in-memory reference fixture.`;
      return [
        item.kind,
        {
          version_id: stableId("reference-version", item.kind, "1"),
          content_hash: contentHash(content),
          immutable_pointer: `memory://reference/${item.kind}/1`,
          content,
        },
      ] as const;
    }),
  );
  readonly claims: Array<Record<string, unknown>> = [];
  readonly sources: Array<Record<string, unknown>> = [];
  private readonly outputKeys = new Map<string, string>();
  readonly deterministicBaselines = new Map<
    string,
    { manifest: DeterministicManifest; result: DeterministicRunResult }
  >();
  readonly deterministicReruns = new Map<string, DeterministicRunResult>();
  private readonly deterministicRerunExecutions = new Map<string, string>();
  readonly revisionRequests: RevisionRequest[] = [];
  readonly revisionFailures: Array<{
    run_id: string;
    execution_id: string;
    operation_id: string;
    identity: RevisionFailureIdentity;
    category: RevisionSafeFailureCategory;
  }> = [];
  readonly coherenceRequests: CoherenceRequest[] = [];
  private readonly coherenceOperations = new Map<string, PersistedCoherence>();
  readonly exports: Array<{
    run_id: string;
    document_version_id: string;
    external_url: string;
    external_document_id?: string;
    status?: "succeeded" | "failed" | "pending";
  }> = [];
  readonly exceptionalCorrectionAuthorisations: Array<{
    run_id: string;
    document_version_id: string;
    deterministic_rerun_step_execution_id: string;
    idempotency_key: string;
    blocker_set_hash: string;
    bindings: ReturnType<typeof bindExceptionalBlockers>;
  }> = [];

  constructor(
    // See PostgresRepository: covers a worst-case model operation plus heartbeat headroom.
    private readonly leaseMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async findIngest(key: string) {
    const run = this.keys.get(key);
    return run ? this.requireRun(run).ingest : null;
  }

  async createIngest(
    key: string,
    inputHash: string,
    handoff: Handoff,
    warnings: IngestResult["warnings"],
  ): Promise<IngestResult> {
    const existing = await this.findIngest(key);
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error("Ingest idempotency conflict");
      return existing.result;
    }
    const runId = stableId("run", key);
    const executionId = stableId("execution", runId, "ingest_handoff", "1");
    const result: IngestResult = { run_id: runId, input_hash: inputHash, handoff, warnings };
    const warningBody = JSON.stringify({ handoff, warnings });
    this.artifacts.push({
      id: stableId("artifact", runId, "ingest"),
      run_id: runId,
      step_execution_id: executionId,
      parent_id: null,
      kind: "ingest_result",
      media_type: "application/json",
      body_text: warningBody,
      content_hash: contentHash(warningBody),
    });
    this.runs.set(runId, {
      handoff,
      ingest: { key, input_hash: inputHash, result },
      status: "running",
      currentStep: "internal_link_discovery",
      coherenceReturnCycles: 0,
      deterministicRepairCycles: 0,
      exceptionalCorrectionAuthorised: false,
      exceptionalCorrectionDocumentId: null,
      blockReason: null,
      steps: [
        {
          id: executionId,
          step: "ingest_handoff",
          status: "succeeded",
          attempt: 1,
          token: null,
          expiresAt: null,
        },
      ],
      links: null,
      linkDiscoveryMetadata: null,
      draft: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    this.keys.set(key, runId);
    await this.enqueueRun(runId);
    return result;
  }

  async ensureStep(runId: string, step: PipelineStepId): Promise<void> {
    const run = this.requireRun(runId);
    if (!run.steps.some((candidate) => candidate.step === step)) {
      run.steps.push({
        id: stableId("execution", runId, step, "1"),
        step,
        status: "queued",
        attempt: 1,
        token: null,
        expiresAt: null,
      });
    }
  }
  async stepSucceeded(runId: string, step: PipelineStepId): Promise<boolean> {
    return this.requireRun(runId).steps.some(
      (candidate) => candidate.step === step && candidate.status === "succeeded",
    );
  }
  async stepWaiting(runId: string, step: PipelineStepId): Promise<boolean> {
    return this.requireRun(runId).steps.some(
      (candidate) => candidate.step === step && candidate.status === "waiting",
    );
  }
  async claimStep(runId: string, step: PipelineStepId, _owner: string, replaySucceeded = false) {
    await this.ensureStep(runId, step);
    const run = this.requireRun(runId);
    const attempts = run.steps
      .filter((candidate) => candidate.step === step)
      .sort((a, b) => b.attempt - a.attempt);
    let state = attempts[0]!;
    if (state.status === "succeeded") {
      if (!replaySucceeded && run.currentStep !== step) throw new Error("Step already succeeded");
      state = {
        id: stableId("execution", runId, step, String(state.attempt + 1)),
        step,
        status: "queued",
        attempt: state.attempt + 1,
        token: null,
        expiresAt: null,
      };
      run.steps.push(state);
    }
    if (state.status === "running" && state.expiresAt! > this.now())
      throw new Error("Step is already leased");
    if (state.status === "running") {
      state.status = "retryable_failed";
      state.token = null;
      state.expiresAt = null;
      state.error = "lease expired";
    }
    if (state.status === "retryable_failed") {
      state = {
        id: stableId("execution", runId, step, String(state.attempt + 1)),
        step,
        status: "queued",
        attempt: state.attempt + 1,
        token: null,
        expiresAt: null,
      };
      run.steps.push(state);
    }
    state.token = randomUUID();
    state.status = "running";
    state.expiresAt = this.now() + this.leaseMs;
    if (!replaySucceeded) {
      run.status = "running";
      run.currentStep = step;
      run.blockReason = null;
      run.updatedAt = this.now();
    }
    return { execution_id: state.id, token: state.token };
  }
  /** Fenced lease renewal: extends the lease only while the token still holds it. */
  async heartbeatStep(executionId: string, token: string): Promise<boolean> {
    const { state } = this.findExecution(executionId);
    if (
      state.status !== "running" ||
      state.token !== token ||
      state.expiresAt === null ||
      state.expiresAt <= this.now()
    )
      return false;
    state.expiresAt = this.now() + this.leaseMs;
    return true;
  }
  async completeStep(
    executionId: string,
    token: string,
    preserveRunProgress = false,
  ): Promise<void> {
    const { run, state } = this.findExecution(executionId);
    this.assertFenceState(state, token);
    state.status = "succeeded";
    state.token = null;
    state.expiresAt = null;
    const order: PipelineStepId[] = [
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
    ];
    const index = order.indexOf(state.step);
    if (!preserveRunProgress) run.currentStep = order[Math.min(index + 1, order.length - 1)]!;
  }
  /** Operator stop: revokes in-flight leases; fenced writes then bounce. */
  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (!["queued", "running", "retryable_failed", "waiting", "blocked"].includes(run.status))
      throw new ConflictError("Only an active or operator-paused blog post can be stopped.");
    for (const step of run.steps) {
      if (step.status === "running") {
        step.status = "cancelled";
        step.token = null;
        step.expiresAt = null;
      }
    }
    const job = this.queueJobs.find(
      (candidate) =>
        candidate.run_id === runId && !["completed", "cancelled"].includes(candidate.state),
    );
    if (job) {
      job.state = "cancelled";
      job.token = null;
      job.expiresAt = null;
    }
    run.status = "cancelled";
    run.blockReason = null;
    run.updatedAt = this.now();
  }
  async failStep(
    executionId: string,
    token: string,
    error: string,
    preserveRunProgress = false,
  ): Promise<void> {
    const { run, state } = this.findExecution(executionId);
    // A cancelled run keeps its operator-decided state; the unwinding
    // orchestrator's failure write must no-op instead of un-cancelling it.
    if (state.status === "cancelled") return;
    this.assertFenceState(state, token);
    state.status = "retryable_failed";
    state.token = null;
    state.expiresAt = null;
    state.error = this.safeFailureMessage(error);
    if (!preserveRunProgress) {
      run.status = "retryable_failed";
      run.currentStep = state.step;
      run.blockReason = null;
    }
  }
  async saveLinkDiscoveryEvidence(
    runId: string,
    executionId: string,
    token: string,
    metadata: import("../../shared/milestone-two.js").LinkDiscoveryMetadata,
  ): Promise<void> {
    this.assertFence(runId, executionId, token);
    const run = this.requireRun(runId);
    run.linkDiscoveryMetadata = LinkDiscoveryMetadataSchema.parse(metadata);
  }
  async getHandoff(runId: string) {
    return this.requireRun(runId).handoff;
  }
  async getLinks(runId: string) {
    return this.requireRun(runId).links;
  }
  async getLinksArtifact(runId: string) {
    const body = this.requireRun(runId).links;
    if (!body) return null;
    const bodyText = JSON.stringify(body);
    return {
      artifact_id: stableId("internal-links-artifact", runId),
      content_hash: contentHash(bodyText),
      body_text: bodyText,
      body: structuredClone(body),
      metadata_artifact_id: null,
      metadata_content_hash: null,
      metadata_body_text: null,
      metadata: null,
    };
  }
  async saveLinks(
    runId: string,
    executionId: string,
    token: string,
    links: InternalLink[],
    metadata?: import("../../shared/milestone-two.js").LinkDiscoveryMetadata,
  ): Promise<void> {
    this.assertFence(runId, executionId, token);
    const run = this.requireRun(runId);
    if (run.links && canonicalHash(run.links) !== canonicalHash(links))
      throw new Error("Immutable link discovery conflict");
    if (!run.links) {
      const body = JSON.stringify(links);
      this.artifacts.push({
        id: stableId("artifact", runId, "internal_links", canonicalHash(links)),
        run_id: runId,
        step_execution_id: executionId,
        parent_id: null,
        kind: "internal_links",
        media_type: "application/json",
        body_text: body,
        content_hash: contentHash(body),
      });
      if (metadata) {
        const metadataBody = JSON.stringify(metadata);
        this.artifacts.push({
          id: stableId(
            "artifact",
            runId,
            "internal_link_discovery_metadata",
            canonicalHash(metadata),
          ),
          run_id: runId,
          step_execution_id: executionId,
          parent_id: null,
          kind: "internal_link_discovery_metadata",
          media_type: "application/json",
          body_text: metadataBody,
          content_hash: contentHash(metadataBody),
        });
      }
      run.links = structuredClone(links);
      run.linkDiscoveryMetadata = metadata ? LinkDiscoveryMetadataSchema.parse(metadata) : null;
    }
  }
  async getDraft(runId: string) {
    const value = this.requireRun(runId).draft;
    return value ? { draft: value.draft, artifact: value.artifact, version: value.version } : null;
  }
  async beginDraftOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    request: import("../../shared/milestone-two.js").DraftProviderRequest;
    provider: string;
    model: string;
    contract_identity: string;
    purpose: DraftOperationIdentity["purpose"];
    operator_authorised: boolean;
  }): Promise<{ identity: DraftOperationIdentity; response: DraftProviderResponse | null }> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    if (input.purpose === "legacy_operator_recovery" && !input.operator_authorised)
      throw new Error("Legacy draft recovery requires explicit operator authorisation");
    if (input.purpose === "initial" && input.operator_authorised)
      throw new Error("Initial draft operation cannot carry recovery authorisation");
    const run = this.requireRun(input.run_id);
    const priorDraftFailure = run.steps.some(
      (step) => step.step === "draft" && step.status === "retryable_failed",
    );
    const runDraftOperations = [...this.outputKeys.entries()].filter(
      ([key, value]) =>
        key.startsWith("draft-state:") && value.includes(`\"run_id\":\"${input.run_id}\"`),
    );
    const hasDraftOperation = runDraftOperations.length > 0;
    if (
      runDraftOperations.some(
        ([key]) =>
          this.outputKeys.get(`${key}:status`) === "provider_in_flight" &&
          !this.outputKeys.has(`${key}:response`),
      )
    )
      throw new Error(
        "Draft provider outcome is ambiguous; no duplicate call was made. A technical owner must authorise a new recovery operation.",
      );
    if (input.purpose === "legacy_operator_recovery" && (!priorDraftFailure || hasDraftOperation))
      throw new Error("Legacy draft recovery is not eligible for this run");
    if (input.purpose === "initial" && priorDraftFailure && !hasDraftOperation)
      throw new Error("A pre-checkpoint draft failure requires explicit operator authorisation");
    const identity = deriveDraftOperationIdentity(input);
    const key = `draft-state:${identity.operation_id}`;
    const existing = this.outputKeys.get(key);
    const serialisedIdentity = JSON.stringify(identity);
    if (existing && existing !== serialisedIdentity)
      throw new Error("Immutable draft operation conflict");
    this.outputKeys.set(key, serialisedIdentity);
    this.outputKeys.set(`${key}:run-id`, input.run_id);
    if (!this.outputKeys.has(`${key}:producer`))
      this.outputKeys.set(`${key}:producer`, input.execution_id);
    const responseText = this.outputKeys.get(`${key}:response`);
    if (!responseText && this.outputKeys.get(`${key}:status`) === "provider_in_flight")
      throw new Error(
        "Draft provider outcome is ambiguous; no duplicate call was made. A technical owner must authorise a new recovery operation.",
      );
    if (!this.outputKeys.has(`${key}:status`)) this.outputKeys.set(`${key}:status`, "started");
    const response = responseText
      ? DraftProviderResponseSchema.parse(JSON.parse(responseText))
      : null;
    if (response && this.outputKeys.get(`${key}:response-hash`) !== canonicalHash(response))
      throw new Error("Draft checkpoint hash mismatch");
    return { identity, response };
  }
  private assertDraftCommand(input: DraftOperationCommand): string {
    this.assertFence(input.run_id, input.execution_id, input.token);
    if (input.run_id !== input.identity.run_id)
      throw new Error("Draft operation cannot cross runs");
    const key = `draft-state:${input.identity.operation_id}`;
    if (this.outputKeys.get(key) !== JSON.stringify(input.identity))
      throw new Error("Draft operation identity mismatch");
    return key;
  }
  async markDraftProviderInFlight(input: DraftOperationCommand): Promise<void> {
    const key = this.assertDraftCommand(input);
    if (this.outputKeys.get(`${key}:status`) !== "started")
      throw new Error("Draft operation is not ready for provider dispatch");
    this.outputKeys.set(`${key}:status`, "provider_in_flight");
    this.outputKeys.set(`${key}:owner`, `step_execution:${input.execution_id}`);
  }
  async releaseDraftProviderFailure(
    input: DraftOperationCommand & {
      reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
    },
  ): Promise<void> {
    const key = this.assertDraftCommand(input);
    if (this.outputKeys.get(`${key}:status`) !== "provider_in_flight")
      throw new Error("Draft operation has no releasable provider reservation");
    this.outputKeys.set(`${key}:status`, "started");
    this.outputKeys.set(`${key}:release-reason`, input.reason);
  }
  async checkpointDraftResponse(
    input: DraftOperationCommand & { response: DraftProviderResponse },
  ): Promise<void> {
    const key = this.assertDraftCommand(input);
    if (this.outputKeys.get(`${key}:status`) !== "provider_in_flight")
      throw new Error("Draft operation has no active provider reservation");
    const response = DraftProviderResponseSchema.parse(input.response);
    const value = JSON.stringify(response);
    const existing = this.outputKeys.get(`${key}:response`);
    if (existing && existing !== value) throw new Error("Immutable draft checkpoint conflict");
    this.outputKeys.set(`${key}:response`, value);
    this.outputKeys.set(`${key}:response-hash`, canonicalHash(response));
    this.outputKeys.set(`${key}:status`, "checkpointed");
  }
  async saveDraft(
    runId: string,
    executionId: string,
    token: string,
    response: DraftProviderResponse,
    operation: DraftOperationIdentity,
  ) {
    const parsed = DraftProviderResponseSchema.parse(response);
    this.assertFence(runId, executionId, token);
    if (operation.run_id !== runId) throw new Error("Draft operation cannot cross runs");
    const operationKey = `draft-state:${operation.operation_id}`;
    if (
      this.outputKeys.get(operationKey) !== JSON.stringify(operation) ||
      this.outputKeys.get(`${operationKey}:status`) !== "checkpointed" ||
      this.outputKeys.get(`${operationKey}:response-hash`) !== canonicalHash(parsed)
    )
      throw new Error("Draft persistence requires its exact validated provider checkpoint");
    const run = this.requireRun(runId);
    const parsedProvider = operation.provider;
    const parsedModel = operation.model;
    const identityHash = canonicalHash(parsed.draft);
    if (run.draft) {
      if (run.draft.canonicalHash !== identityHash) throw new Error("Immutable draft conflict");
      return { draft: run.draft.draft, artifact: run.draft.artifact, version: run.draft.version };
    }
    if (
      this.providerUsage.some(
        (usage) =>
          usage.run_id === runId &&
          usage.provider === parsedProvider &&
          usage.request_id === parsed.request_id,
      )
    )
      throw new Error("Provider request conflict");
    const body = JSON.stringify(parsed.draft);
    const hash = contentHash(body);
    const artifact: ArtifactRecord = {
      id: stableId("artifact", runId, hash),
      run_id: runId,
      step_execution_id: executionId,
      parent_id: null,
      kind: "draft",
      media_type: "application/json",
      body_text: body,
      content_hash: hash,
    };
    const version: DocumentVersionRecord = {
      id: stableId("document", runId, "1", hash),
      run_id: runId,
      artifact_id: artifact.id,
      parent_id: null,
      revision: 1,
      content_hash: hash,
    };
    const usage: ProviderUsageRecord = {
      id: stableId("usage", runId, parsedProvider, parsed.request_id),
      run_id: runId,
      step_execution_id: executionId,
      provider: parsedProvider,
      model: parsedModel,
      operation: "draft",
      request_id: parsed.request_id,
      ...parsed.usage,
    };
    this.artifacts.push(artifact);
    // The request bytes were already validated and hashed into the immutable operation.
    // Persist only the approved operation identity here; prompts remain provider-owned.
    const requestBody = JSON.stringify(operation);
    this.artifacts.push({
      id: stableId("artifact", runId, "draft_request", contentHash(requestBody)),
      run_id: runId,
      step_execution_id: executionId,
      parent_id: null,
      kind: "draft_request",
      media_type: "application/json",
      body_text: requestBody,
      content_hash: contentHash(requestBody),
    });
    this.documentVersions.push(version);
    this.providerUsage.push(usage);
    run.draft = {
      draft: structuredClone(parsed.draft),
      canonicalHash: identityHash,
      artifact,
      version,
    };
    return { draft: run.draft.draft, artifact, version };
  }

  async snapshotReferences(
    runId: string,
    executionId: string,
    token: string,
  ): Promise<ReferenceSnapshot[]> {
    this.assertFence(runId, executionId, token);
    const step = this.findExecution(executionId).state.step;
    const mapped = REFERENCE_DOCUMENT_SEED_MANIFEST.filter((item) =>
      (item.steps as readonly PipelineStepId[]).includes(step),
    );
    const existing = this.referenceSnapshots.filter(
      (item) => item.step_execution_id === executionId,
    );
    if (existing.length) return existing.map(({ step_execution_id: _, ...snapshot }) => snapshot);
    const snapshots = mapped.map(({ kind }) => {
      const active = this.activeReferences.get(kind);
      if (!active) throw new Error(`Mapped reference has no active version: ${kind}`);
      return { kind, ...active };
    });
    this.referenceSnapshots.push(
      ...snapshots.map((snapshot) => ({ ...snapshot, step_execution_id: executionId })),
    );
    return snapshots;
  }

  async hasStepOutput(
    runId: string,
    documentVersionId: string,
    step: PipelineStepId,
  ): Promise<boolean> {
    return this.outputKeys.has(`${runId}:${documentVersionId}:${step}`);
  }

  async saveDeterministicBaseline(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    manifest: DeterministicManifest;
    result: DeterministicRunResult;
    findings: Array<ReviewFinding & { hard_flag: boolean }>;
  }): Promise<void> {
    const manifest = DeterministicManifestSchema.parse(input.manifest),
      result = DeterministicRunResultSchema.parse(input.result);
    this.assertFence(input.run_id, input.execution_id, input.token);
    const existing = this.deterministicBaselines.get(input.run_id);
    if (existing) {
      if (existing.manifest.manifest_hash !== manifest.manifest_hash)
        throw new Error("Immutable deterministic baseline conflict");
      return;
    }
    const findingsBefore = this.findings.length;
    try {
      await this.saveFindings(
        input.run_id,
        input.document_version_id,
        input.execution_id,
        input.token,
        input.findings,
        false,
      );
      this.deterministicBaselines.set(input.run_id, structuredClone({ manifest, result }));
      this.completeValidatedStep(
        this.requireRun(input.run_id),
        this.findExecution(input.execution_id).state,
      );
    } catch (error) {
      this.findings.splice(findingsBefore);
      this.outputKeys.delete(`${input.run_id}:${input.document_version_id}:automated_checks`);
      this.deterministicBaselines.delete(input.run_id);
      throw error;
    }
  }

  async getDeterministicManifest(runId: string) {
    const baseline = this.deterministicBaselines.get(runId);
    if (!baseline) throw new Error("Step 1.4 deterministic manifest is missing");
    return structuredClone(baseline);
  }

  async saveFindings(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    raw: Array<ReviewFinding & { hard_flag: boolean }>,
    complete = true,
  ): Promise<void> {
    const fenced = this.assertFence(runId, executionId, token);
    const step = fenced.state.step;
    const findings = raw.map((item) => PersistedReviewFindingSchema.parse(item));
    const key = `${runId}:${documentVersionId}:${step}`;
    const identity = canonicalHash(findings);
    const existing = this.outputKeys.get(key);
    if (existing && existing !== identity) throw new Error("Immutable findings conflict");
    if (existing) return;
    const stableKeys = new Set(
      this.findings
        .filter((item) => item.run_id === runId && item.document_version_id === documentVersionId)
        .map((item) => item.stable_key),
    );
    const pending = findings.map((finding) => {
      if (stableKeys.has(finding.stable_key)) throw new Error("Finding stable key conflict");
      stableKeys.add(finding.stable_key);
      return {
        ...finding,
        hard_flag: finding.hard_flag,
        id: stableId("finding", runId, documentVersionId, finding.stable_key),
        run_id: runId,
        document_version_id: documentVersionId,
        step_execution_id: executionId,
        step,
        disposition: null,
        rationale: null,
      };
    });
    this.findings.push(...pending);
    this.outputKeys.set(key, identity);
    if (complete) this.completeValidatedStep(fenced.run, fenced.state);
  }

  async beginReviewOperation(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    step: ReviewStep;
    request: ReviewRequest;
    provider: string;
    model: string;
  }): Promise<{ operation_id: string; response: PersistedReviewResponse | null }> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const request = ReviewRequestSchema.parse(input.request);
    const operationId = stableId(
      "review-operation",
      input.run_id,
      input.document_version_id,
      input.step,
      canonicalHash(request),
      input.provider,
      input.model,
    );
    const key = `review-operation:${operationId}`;
    const identity = canonicalHash({
      run_id: input.run_id,
      document_version_id: input.document_version_id,
      step: input.step,
      request_hash: canonicalHash(request),
      provider: input.provider,
      model: input.model,
    });
    const existing = this.outputKeys.get(key);
    if (existing && existing !== identity) throw new Error("Immutable review operation conflict");
    this.outputKeys.set(key, identity);
    this.outputKeys.set(`${key}:run-id`, input.run_id);
    const status = this.outputKeys.get(`${key}:status`) ?? "started";
    if (status === "provider_in_flight")
      throw new Error("Review provider outcome is ambiguous; operator action is required");
    const producerKey = `${key}:producer`;
    const producer = this.outputKeys.get(producerKey);
    if (!producer) this.outputKeys.set(producerKey, input.execution_id);
    else if (producer !== input.execution_id && status === "started") {
      const previous = this.findExecution(producer);
      const current = this.findExecution(input.execution_id);
      if (
        previous.run !== current.run ||
        previous.state.step !== input.step ||
        current.state.step !== input.step ||
        previous.state.status !== "retryable_failed" ||
        previous.state.token !== null ||
        previous.state.expiresAt !== null ||
        current.state.status !== "running" ||
        previous.state.attempt >= current.state.attempt
      )
        throw new Error("Started review operation cannot be adopted by this attempt");
      this.reviewOperationAdoptions.push({
        operation_id: operationId,
        run_id: input.run_id,
        from_step_execution_id: producer,
        to_step_execution_id: input.execution_id,
      });
      this.outputKeys.set(producerKey, input.execution_id);
    }
    const raw = this.outputKeys.get(`${key}:response`);
    const response = raw ? PersistedReviewResponseSchema.parse(JSON.parse(raw)) : null;
    if (response && this.outputKeys.get(`${key}:response-hash`) !== canonicalHash(response))
      throw new Error("Review checkpoint hash mismatch");
    return { operation_id: operationId, response };
  }

  async markReviewProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `review-operation:${input.operation_id}`;
    if (
      !this.outputKeys.has(key) ||
      (this.outputKeys.get(`${key}:status`) ?? "started") !== "started" ||
      this.outputKeys.get(`${key}:producer`) !== input.execution_id
    )
      throw new Error("Review operation is not ready for dispatch");
    this.outputKeys.set(`${key}:status`, "provider_in_flight");
    this.outputKeys.set(`${key}:owner`, `step_execution:${input.execution_id}`);
  }

  async releaseReviewProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `review-operation:${input.operation_id}`;
    if (
      this.outputKeys.get(`${key}:status`) !== "provider_in_flight" ||
      this.outputKeys.has(`${key}:response`)
    )
      throw new Error("Review operation has no releasable provider reservation");
    this.outputKeys.set(`${key}:status`, "started");
    this.outputKeys.set(`${key}:release-reason`, input.reason);
  }

  async checkpointReviewResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: PersistedReviewResponse;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `review-operation:${input.operation_id}`;
    const response = PersistedReviewResponseSchema.parse(input.response);
    const hash = canonicalHash(response);
    if (this.outputKeys.get(`${key}:status`) === "checkpointed") {
      if (
        this.outputKeys.get(`${key}:response-hash`) !== hash ||
        this.outputKeys.get(`${key}:producer`) !== input.execution_id
      )
        throw new Error("Immutable review checkpoint conflict");
      return;
    }
    if (
      this.outputKeys.get(`${key}:status`) !== "provider_in_flight" ||
      this.outputKeys.get(`${key}:producer`) !== input.execution_id
    )
      throw new Error("Review operation has no active provider reservation");
    this.outputKeys.set(`${key}:response`, JSON.stringify(response));
    this.outputKeys.set(`${key}:response-hash`, hash);
    this.outputKeys.set(`${key}:status`, "checkpointed");
  }

  async saveReview(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    step: ReviewStep,
    rawRequest: ReviewRequest,
    rawResponse: ReviewResponse & { findings: Array<ReviewFinding & { hard_flag: boolean }> },
    provider: string,
    model: string,
    rawCheckpointResponse?: PersistedReviewResponse,
  ): Promise<void> {
    const request = ReviewRequestSchema.parse(rawRequest);
    const response = PersistedReviewResponseSchema.parse(rawResponse);
    const checkpointResponse = rawCheckpointResponse
      ? PersistedReviewResponseSchema.parse(rawCheckpointResponse)
      : response;
    const fenced = this.assertFence(runId, executionId, token);
    const parsedProvider = this.requireNonEmpty(provider, "provider");
    const parsedModel = this.requireNonEmpty(model, "model");
    const sourceKeys = new Set(response.sources.map((source) => source.stable_key));
    for (const claim of response.claims) {
      if (!sourceKeys.has(claim.source_key)) throw new Error("Claim source is missing");
    }
    const pendingSources: Array<Record<string, unknown>> = [];
    for (const source of response.sources) {
      const snapshot = JSON.stringify(source.snapshot),
        hash = contentHash(snapshot),
        existingSource =
          this.sources.find(
            (item) =>
              item.run_id === runId && item.uri === source.uri && item.content_hash === hash,
          ) ?? pendingSources.find((item) => item.uri === source.uri && item.content_hash === hash);
      if (
        existingSource &&
        (existingSource.source_type !== source.source_type ||
          existingSource.title !== source.title ||
          existingSource.retrieved_at !== source.retrieved_at ||
          existingSource.content_hash !== hash ||
          JSON.stringify(existingSource.snapshot) !== snapshot ||
          existingSource.evidence !== source.evidence)
      )
        throw new Error("Immutable source conflict");
      pendingSources.push({ ...source, run_id: runId, content_hash: hash });
    }
    const operationId = stableId(
      "review-operation",
      runId,
      documentVersionId,
      step,
      canonicalHash(request),
      parsedProvider,
      parsedModel,
    );
    const operationKey = `review-operation:${operationId}`;
    const identity = canonicalHash(response);
    if (
      this.outputKeys.get(`${operationKey}:status`) !== "checkpointed" ||
      this.outputKeys.get(`${operationKey}:response-hash`) !== canonicalHash(checkpointResponse)
    )
      throw new Error("Review persistence requires its exact validated provider checkpoint");
    const key = `${runId}:${documentVersionId}:${step}`;
    const existing = this.outputKeys.get(key);
    if (existing && existing !== identity) throw new Error("Immutable review conflict");
    if (existing) return;
    await this.saveFindings(
      runId,
      documentVersionId,
      executionId,
      token,
      response.findings.map((finding) => ({
        ...finding,
        stable_key: `${step}:${finding.stable_key}`,
      })),
      false,
    );
    // saveFindings set the output identity to findings; replace it with the complete response identity.
    this.outputKeys.set(key, identity);
    const requestBody = JSON.stringify(request),
      responseBody = JSON.stringify(response);
    for (const [kind, body] of [
      ["review_request", requestBody],
      ["review_response", responseBody],
    ] as const) {
      this.artifacts.push({
        id: stableId("artifact", runId, step, kind),
        run_id: runId,
        step_execution_id: executionId,
        parent_id: null,
        kind,
        media_type: "application/json",
        body_text: body,
        content_hash: contentHash(body),
      });
    }
    this.providerUsage.push({
      id: stableId("usage", runId, parsedProvider, response.request_id),
      run_id: runId,
      step_execution_id: executionId,
      provider: parsedProvider,
      model: parsedModel,
      operation: step,
      request_id: response.request_id,
      ...response.usage,
    });
    for (const source of response.sources) {
      const hash = contentHash(JSON.stringify(source.snapshot));
      const existing = this.sources.find(
        (item) => item.run_id === runId && item.uri === source.uri && item.content_hash === hash,
      );
      if (!existing) this.sources.push({ ...source, run_id: runId, content_hash: hash });
    }
    for (const claim of response.claims) {
      const source = response.sources.find((item) => item.stable_key === claim.source_key)!;
      this.claims.push({
        ...claim,
        run_id: runId,
        document_version_id: documentVersionId,
        evidence: source.evidence,
      });
    }
    this.completeValidatedStep(fenced.run, fenced.state);
  }

  async waitForFindings(runId: string, executionId: string, token: string): Promise<void> {
    const { run, state } = this.findExecution(executionId);
    if (run !== this.requireRun(runId)) throw new Error("Stale fencing token");
    this.assertFenceState(state, token);
    const currentFindings = this.sortReviewSet(this.reviewSet(runId, run.draft?.version.id ?? ""));
    const reviewSetId = stableId("finding-review-set", runId, executionId);
    this.findingReviewSets.push({
      round:
        Math.max(
          0,
          ...this.findingReviewSets.filter((set) => set.run_id === runId).map((set) => set.round),
        ) + 1,
      id: reviewSetId,
      run_id: runId,
      document_version_id: run.draft!.version.id,
      findings_step_execution_id: executionId,
      membership_hash: canonicalHash(currentFindings.map((finding) => finding.id)),
      finding_ids: currentFindings.map((finding) => finding.id),
    });
    state.token = null;
    state.expiresAt = null;
    if (currentFindings.length === 0) {
      state.status = "succeeded";
      this.findingReviewSubmissions.push({
        run_id: runId,
        review_set_id: reviewSetId,
        idempotency_key: `automatic:${executionId}`,
        payload_hash: canonicalHash({
          document_version_id: run.draft!.version.id,
          dispositions: [],
        }),
        finding_count: 0,
      });
      run.status = "running";
      run.currentStep = "revision_pass";
      run.blockReason = null;
      return;
    }
    state.status = "waiting";
    run.status = "waiting";
    run.currentStep = "findings_review";
    run.blockReason = null;
  }

  /**
   * Opens a controlled editorial-correction round for the same immutable
   * document version. Mirrors the PostgreSQL implementation exactly: every
   * fence is checked before any mutation, prior rounds are untouched, and an
   * identical repeat replays the existing round.
   */
  async openEditorialCorrectionRound(input: {
    run_id: string;
    document_version_id: string;
    expected_content_hash: string;
    checker_version: string;
    findings: Array<ReviewFinding & { hard_flag: boolean }>;
  }): Promise<{ status: "opened" | "replayed"; review_set_id: string; round: number }> {
    const findings = input.findings.map((item) => PersistedReviewFindingSchema.parse(item));
    if (findings.length === 0)
      throw new UnprocessableError("A correction round requires findings.");
    const membershipKeys = canonicalHash(findings.map((finding) => finding.stable_key));
    const run = this.requireRun(input.run_id);
    if (run.status === "cancelled" || run.status === "succeeded")
      throw new ConflictError("A finished run cannot open an editorial correction.");
    if (!run.draft) throw new UnprocessableError("The current document version is unavailable.");
    if (run.draft.version.id !== input.document_version_id)
      throw new ConflictError("The correction source is no longer the current document version.");
    if (run.draft.version.content_hash !== input.expected_content_hash)
      throw new ConflictError("The correction source content hash changed.");

    const active = this.activeReviewSet(input.run_id);
    if (!active)
      throw new ConflictError("The first findings review round has not been frozen yet.");
    // Replay before the waiting-round guard: an already-open correction round is
    // itself waiting, so guarding first would reject its own idempotent re-open.
    if (active.round > 1 && active.membership_hash === membershipKeys)
      return { status: "replayed", review_set_id: active.id, round: active.round };

    // Two waiting rounds would leave two open operator queues. Fail closed.
    const waiting = run.steps.filter(
      (state) => state.step === "findings_review" && state.status === "waiting",
    ).length;
    if (waiting > 0)
      throw new ConflictError(
        "A findings review round is already awaiting decisions; decide it before opening an editorial correction.",
      );

    const round = active.round + 1;
    const attempt =
      Math.max(
        0,
        ...run.steps.filter((state) => state.step === "findings_review").map((s) => s.attempt),
      ) + 1;
    const executionId = stableId("execution", input.run_id, "findings_review", String(attempt));
    run.steps.push({
      id: executionId,
      step: "findings_review",
      status: "waiting",
      attempt,
      token: null,
      expiresAt: null,
    });
    const pending = findings.map((finding) => ({
      ...finding,
      hard_flag: finding.hard_flag,
      id: stableId("finding", input.run_id, input.document_version_id, finding.stable_key),
      run_id: input.run_id,
      document_version_id: input.document_version_id,
      step_execution_id: executionId,
      step: "findings_review" as const,
      disposition: null,
      rationale: null,
    }));
    this.findings.push(...pending);
    const reviewSetId = stableId("finding-review-set", input.run_id, executionId);
    this.findingReviewSets.push({
      id: reviewSetId,
      run_id: input.run_id,
      document_version_id: input.document_version_id,
      findings_step_execution_id: executionId,
      membership_hash: membershipKeys,
      finding_ids: pending.map((finding) => finding.id),
      round,
    });
    run.status = "waiting";
    run.currentStep = "findings_review";
    run.updatedAt = this.now();
    return { status: "opened", review_set_id: reviewSetId, round };
  }

  /** The active round is the highest for the run — never "the first row". */
  private activeReviewSet(runId: string) {
    return this.findingReviewSets
      .filter((set) => set.run_id === runId)
      .reduce<(typeof this.findingReviewSets)[number] | undefined>(
        (best, set) => (best === undefined || set.round > best.round ? set : best),
        undefined,
      );
  }

  async listFindings(runId: string, rawFilters: unknown): Promise<FindingRecord[]> {
    const filters = FindingFiltersSchema.parse(rawFilters);
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError("The findings run was not found.");
    const currentDocumentId = run.draft?.version.id;
    if (!currentDocumentId)
      throw new UnprocessableError("The current document version is unavailable.");
    const frozen = this.activeReviewSet(runId);
    if (!frozen) throw new ConflictError("Findings review set has not been frozen.");
    if (frozen.document_version_id !== currentDocumentId)
      throw new ConflictError("The frozen findings document is no longer current.");
    return frozen.finding_ids
      .map((id) => this.findings.find((finding) => finding.id === id)!)
      .map((finding) => {
        const disposition = this.dispositions.find((item) => item.finding_id === finding.id);
        const claim = this.claims.find(
          (item) =>
            item.run_id === runId &&
            item.document_version_id === finding.document_version_id &&
            JSON.stringify(item.location) === JSON.stringify(finding.location),
        );
        const source = claim
          ? this.sources.find(
              (item) => item.run_id === runId && item.stable_key === claim.source_key,
            )
          : undefined;
        const snapshot = source?.snapshot as Record<string, unknown> | undefined;
        const selection = snapshot?.selection_evidence as Record<string, unknown> | undefined;
        return {
          ...finding,
          hard_flag_reason: projectHardFlagReason(finding),
          disposition: disposition?.decision ?? null,
          rationale: disposition?.rationale ?? null,
          evidence_sources:
            source &&
            snapshot &&
            typeof snapshot.extraction_method === "string" &&
            typeof snapshot.evidence_hash === "string" &&
            typeof snapshot.evidence_excerpt === "string"
              ? [
                  {
                    url: String(source.uri).slice(0, 2_048),
                    ...(source.title ? { title: String(source.title).slice(0, 300) } : {}),
                    ...(source.source_type === "public_storefront"
                      ? { publisher: "Mobelaris" }
                      : source.publisher
                        ? { publisher: String(source.publisher).slice(0, 200) }
                        : {}),
                    evidence_location: snapshot.extraction_method.slice(0, 500),
                    extraction_method: snapshot.extraction_method.slice(0, 120),
                    retrieved_at: String(source.retrieved_at),
                    content_hash: String(snapshot.content_hash ?? source.content_hash),
                    evidence_hash: snapshot.evidence_hash,
                    excerpt: snapshot.evidence_excerpt.slice(0, 2_000),
                    selection_reason: String(
                      snapshot.selection_reason ??
                        selection?.selection_reason ??
                        selection?.strategy ??
                        "Stored historical source evidence.",
                    ).slice(0, 500),
                  },
                ]
              : [],
        };
      })
      .filter(
        (finding) =>
          (!filters.step || finding.step === filters.step) &&
          (!filters.severity || finding.severity === filters.severity) &&
          (!filters.category || finding.category === filters.category) &&
          (!filters.disposition ||
            (filters.disposition === "pending"
              ? finding.disposition === null
              : finding.disposition === filters.disposition)),
      );
  }

  async submitDispositions(
    runId: string,
    input: BulkDisposition,
  ): Promise<{ completed: boolean; submitted: number; continuation_required: boolean }> {
    const parsed = BulkDispositionSchema.parse(input);
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError("The findings run was not found.");
    const frozen = this.activeReviewSet(runId);
    const waiting = run.steps.find(
      (item) => item.id === frozen?.findings_step_execution_id && item.status === "waiting",
    );
    const normalized = {
      document_version_id: parsed.document_version_id,
      dispositions: parsed.dispositions.map((item) => ({
        finding_id: item.finding_id,
        decision: item.decision,
        rationale: item.rationale?.trim() || null,
      })),
    };
    const payloadHash = canonicalHash(normalized);
    const replay = this.findingReviewSubmissions.find(
      (item) => item.idempotency_key === parsed.idempotency_key,
    );
    if (replay) {
      if (replay.run_id !== runId || replay.payload_hash !== payloadHash)
        throw new ConflictError("The idempotency key is bound to a different review submission.");
      const frozenReplay = this.findingReviewSets.find((item) => item.id === replay.review_set_id);
      const reviewExecution = run.steps.find(
        (item) => item.id === frozenReplay?.findings_step_execution_id,
      );
      const findingsIndex = PIPELINE_STEPS.findIndex((item) => item.id === "findings_review");
      const currentIndex = PIPELINE_STEPS.findIndex((item) => item.id === run.currentStep);
      if (
        run.status === "cancelled" ||
        run.status === "blocked" ||
        currentIndex <= findingsIndex ||
        reviewExecution?.status !== "succeeded"
      )
        throw new ConflictError("The completed findings review is not in a replayable run state.");
      if (
        !run.draft ||
        run.draft.version.id !== parsed.document_version_id ||
        frozenReplay?.run_id !== runId ||
        frozenReplay.document_version_id !== parsed.document_version_id
      )
        throw new ConflictError("The completed findings review document is no longer current.");
      return { completed: true, submitted: replay.finding_count, continuation_required: false };
    }
    if (!waiting || run.status !== "waiting" || run.currentStep !== "findings_review")
      throw new ConflictError("Findings review is not waiting for dispositions.");
    if (!run.draft) throw new UnprocessableError("The current document version is unavailable.");
    if (parsed.document_version_id !== run.draft.version.id)
      throw new ConflictError("Dispositions must target the current document version.");
    if (!frozen)
      throw new ConflictError("The waiting findings execution has no matching frozen review set.");
    const reviewSet = frozen.finding_ids.map((id) =>
      this.findings.find((finding) => finding.id === id)!,
    );
    if (parsed.dispositions.length !== reviewSet.length)
      throw new UnprocessableError(
        "Every pending finding in the frozen review set needs a decision.",
      );
    const selected = parsed.dispositions.map((item) => {
      const finding = this.findings.find((candidate) => candidate.id === item.finding_id);
      if (
        !finding ||
        finding.run_id !== runId ||
        finding.document_version_id !== parsed.document_version_id ||
        !reviewSet.includes(finding)
      )
        throw new UnprocessableError("A finding does not belong to the current document.");
      if (this.dispositions.some((disposition) => disposition.finding_id === finding.id))
        throw new ConflictError("A finding already has a disposition.");
      return { finding, item };
    });
    const appendedDispositions: (typeof this.dispositions)[number][] = [];
    let appendedSubmission: (typeof this.findingReviewSubmissions)[number] | null = null;
    const waitingStatus = waiting.status;
    const runSnapshot = {
      status: run.status,
      currentStep: run.currentStep,
      blockReason: run.blockReason,
    };
    const targetQueueSnapshots = new Map(
      this.queueJobs
        .filter((job) => job.run_id === runId)
        .map((job) => [job, structuredClone(job)] as const),
    );
    try {
      for (const { finding, item } of selected) {
        const disposition = {
          finding_id: finding.id,
          decision: item.decision,
          ...(item.rationale?.trim() ? { rationale: item.rationale.trim() } : {}),
        };
        appendedDispositions.push(disposition);
        this.dispositions.push(disposition);
      }
      const pending = reviewSet.some(
        (item) => !this.dispositions.some((disposition) => disposition.finding_id === item.id),
      );
      if (!pending) {
        appendedSubmission = {
          run_id: runId,
          review_set_id: frozen.id,
          idempotency_key: parsed.idempotency_key,
          payload_hash: payloadHash,
          finding_count: selected.length,
        };
        this.findingReviewSubmissions.push(appendedSubmission);
        waiting.status = "succeeded";
        // Findings review has concluded — the run moves on to the next
        // (externally-triggered, model-owned) step rather than staying
        // parked at the step that just succeeded.
        run.status = "running";
        run.currentStep = "revision_pass";
        run.blockReason = null;
        await this.enqueueRun(runId);
      }
      return { completed: !pending, submitted: selected.length, continuation_required: !pending };
    } catch (error) {
      for (const disposition of appendedDispositions) {
        const index = this.dispositions.indexOf(disposition);
        if (index !== -1) this.dispositions.splice(index, 1);
      }
      if (appendedSubmission) {
        const index = this.findingReviewSubmissions.indexOf(appendedSubmission);
        if (index !== -1) this.findingReviewSubmissions.splice(index, 1);
      }
      waiting.status = waitingStatus;
      run.status = runSnapshot.status;
      run.currentStep = runSnapshot.currentStep;
      run.blockReason = runSnapshot.blockReason;

      for (let index = this.queueJobs.length - 1; index >= 0; index -= 1) {
        const job = this.queueJobs[index]!;
        if (job.run_id === runId && !targetQueueSnapshots.has(job)) this.queueJobs.splice(index, 1);
      }
      for (const [job, snapshot] of targetQueueSnapshots) {
        const mutableJob = job as unknown as Record<string, unknown>;
        for (const key of Object.keys(mutableJob)) {
          if (!(key in snapshot)) delete mutableJob[key];
        }
        Object.assign(job, snapshot);
      }
      throw error;
    }
  }

  private reviewSet(runId: string, documentVersionId: string): FindingRecord[] {
    const allowed = new Set<PipelineStepId>([
      "automated_checks",
      "review_writing_style",
      "review_information_gain",
      "review_fact_checking",
      "review_link_conversion",
    ]);
    return this.findings.filter(
      (finding) =>
        finding.run_id === runId &&
        finding.document_version_id === documentVersionId &&
        allowed.has(finding.step),
    );
  }

  private sortReviewSet(findings: FindingRecord[]): FindingRecord[] {
    const severity = { blocker: 0, warning: 1, info: 2 } as const;
    const step = new Map(PIPELINE_STEPS.map((item, index) => [item.id, index]));
    return [...findings].sort(
      (a, b) =>
        severity[a.severity] - severity[b.severity] ||
        step.get(a.step)! - step.get(b.step)! ||
        a.stable_key.localeCompare(b.stable_key, "en-GB"),
    );
  }

  attempts(runId: string, step: PipelineStepId): ReadonlyArray<StepState> {
    return this.requireRun(runId).steps.filter((value) => value.step === step);
  }
  async getRevisionFindings(runId: string, documentVersionId: string) {
    const run = this.requireRun(runId);
    const rerunKey = `${runId}:${documentVersionId}`;
    const currentRerun = this.deterministicReruns.get(rerunKey);
    const rerunExecutionId = this.deterministicRerunExecutions.get(rerunKey);
    const exceptional = this.exceptionalCorrectionAuthorisations.find(
      (item) => item.run_id === runId,
    );
    if (exceptional && exceptional.document_version_id !== documentVersionId)
      throw new Error("Exceptional correction is not bound to the current document.");
    const authoritativeExecutionId =
      exceptional?.deterministic_rerun_step_execution_id ?? rerunExecutionId;
    const exactRerunBlockers = this.findings.filter(
      (finding) =>
        finding.run_id === runId &&
        finding.document_version_id === documentVersionId &&
        finding.step_execution_id === authoritativeExecutionId &&
        finding.step === "automated_checks_rerun" &&
        finding.severity === "blocker",
    );
    const hasCurrentDeterministicBlockers = Boolean(
      currentRerun?.comparison &&
      authoritativeExecutionId &&
      exactRerunBlockers.length > 0 &&
      exactRerunBlockers.length ===
        currentRerun.comparison.retained_blockers.length +
          currentRerun.comparison.introduced_blockers.length,
    );
    if (
      exceptional &&
      (!hasCurrentDeterministicBlockers ||
        exceptional.blocker_set_hash !== canonicalHash(exactRerunBlockers.map((item) => item.id)))
    )
      throw new Error("Exceptional correction blocker binding no longer matches Step 1.11.");
    const source = hasCurrentDeterministicBlockers
      ? exceptional
        ? ("operator_authorised_repair" as const)
        : ("deterministic_repair" as const)
      : run.coherenceReturnCycles > 0
        ? ("coherence_repair" as const)
        : run.deterministicRepairCycles > 0 || run.blockReason === "deterministic_blockers"
          ? (() => {
              throw new Error(
                "Deterministic recovery evidence is missing for the current document; operator action is required.",
              );
            })()
          : ("operator_findings" as const);
    const frozen = this.activeReviewSet(runId);
    const orderedIds = source === "operator_findings" ? (frozen?.finding_ids ?? []) : [];
    const selected =
      source === "operator_findings"
        ? orderedIds.flatMap((id) => {
            const finding = this.findings.find((item) => item.id === id);
            const disposition = this.dispositions.find((item) => item.finding_id === id);
            return finding &&
              disposition?.decision === "accepted" &&
              frozen?.document_version_id === documentVersionId
              ? [finding]
              : [];
          })
        : source === "deterministic_repair" || source === "operator_authorised_repair"
          ? exactRerunBlockers
          : this.findings.filter(
              (finding) =>
                finding.document_version_id === documentVersionId &&
                finding.step === "final_coherence_export" &&
                finding.severity === "blocker",
            );
    const exceptionalBindings = exceptional?.bindings;
    const findings = selected.map((finding) => ({
      id: finding.id,
      stable_key: finding.stable_key,
      category: finding.category,
      rule_reference: finding.rule_reference,
      severity: finding.severity,
      location:
        exceptionalBindings?.find((binding) => binding.finding_id === finding.id)?.location ??
        finding.location,
      issue: finding.issue,
      ...(finding.evidence ? { evidence: finding.evidence } : {}),
      suggested_fix: finding.suggested_fix,
      disposition: "accepted" as const,
      origin_document_version_id: finding.document_version_id,
    }));
    const rejected_locations = this.findings.flatMap((finding) => {
      const disposition = this.dispositions.find((item) => item.finding_id === finding.id);
      return finding.run_id === runId &&
        finding.document_version_id === documentVersionId &&
        disposition?.decision === "rejected"
        ? [finding.location]
        : [];
    });
    const verified_fact_locations = this.claims.flatMap((claim) => {
      if (
        claim.run_id !== runId ||
        claim.document_version_id !== documentVersionId ||
        claim.status !== "verified"
      )
        return [];
      const parsed = FindingLocationSchema.safeParse(claim.location);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      source,
      findings,
      rejected_locations,
      verified_fact_locations,
      authorised_readability: Object.fromEntries(
        (exceptionalBindings ?? [])
          .filter((binding) => binding.readability_blocks?.length)
          .map((binding) => [
            binding.finding_id,
            {
              blocks: binding.readability_blocks!,
              ...(binding.selector_version ? { selector_version: binding.selector_version } : {}),
              ...(binding.target_set_identity
                ? { target_set_identity: binding.target_set_identity }
                : {}),
            },
          ]),
      ),
    };
  }

  async beginRevisionOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    document_version_id: string;
    request: RevisionRequest;
  }): Promise<RevisionResponse | null> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `revision-state:${input.operation_id}`,
      identity = canonicalHash(input.request);
    const existing = this.outputKeys.get(key);
    if (existing && existing !== identity) throw new Error("Immutable revision operation conflict");
    this.outputKeys.set(key, identity);
    this.outputKeys.set(`${key}:run-id`, input.run_id);
    if (!this.outputKeys.has(`${key}:producer`))
      this.outputKeys.set(`${key}:producer`, input.execution_id);
    const response = this.outputKeys.get(`${key}:response`);
    if (!response && this.outputKeys.get(`${key}:status`) === "provider_in_flight")
      throw new Error(
        "Revision provider outcome is ambiguous; no duplicate call was made. Change provider/model or contract version to start a new operation.",
      );
    this.outputKeys.set(`${key}:status`, response ? "response_validated" : "started");
    return response ? RevisionResponseSchema.parse(JSON.parse(response)) : null;
  }

  async markRevisionProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `revision-state:${input.operation_id}`;
    if (!this.outputKeys.has(key)) throw new Error("Revision operation is missing");
    this.outputKeys.set(`${key}:status`, "provider_in_flight");
    this.outputKeys.set(`${key}:owner`, `step_execution:${input.execution_id}`);
  }

  async releaseRevisionProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `revision-state:${input.operation_id}:status`;
    if (this.outputKeys.get(key) === "provider_in_flight") {
      this.outputKeys.set(key, "started");
      this.outputKeys.set(`revision-state:${input.operation_id}:release-reason`, input.reason);
    }
  }

  async checkpointRevisionResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: RevisionResponse;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `revision-state:${input.operation_id}:response`,
      value = JSON.stringify(RevisionResponseSchema.parse(input.response));
    const existing = this.outputKeys.get(key);
    if (existing && existing !== value) throw new Error("Immutable revision checkpoint conflict");
    this.outputKeys.set(key, value);
    this.outputKeys.set(`revision-state:${input.operation_id}:status`, "response_validated");
  }

  async getRevisionFailureLock(runId: string, identity: RevisionFailureIdentity) {
    const matches = this.revisionFailures.filter(
      (row) => row.run_id === runId && canonicalHash(row.identity) === canonicalHash(identity),
    );
    const counts = new Map<RevisionSafeFailureCategory, number>();
    for (const match of matches) counts.set(match.category, (counts.get(match.category) ?? 0) + 1);
    const category = [...matches]
      .reverse()
      .find((match) => (counts.get(match.category) ?? 0) >= 2)?.category;
    return category ? { category, failures: counts.get(category)! } : null;
  }

  async recordRevisionFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    identity: RevisionFailureIdentity;
    category: RevisionSafeFailureCategory;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    if (!this.revisionFailures.some((row) => row.execution_id === input.execution_id)) {
      const { token: _, ...failure } = input;
      this.revisionFailures.push(structuredClone(failure));
    }
  }

  async getExportClaims(runId: string, documentVersionId: string): Promise<ExportClaim[]> {
    this.requireRun(runId);
    return this.claims
      .filter((claim) => claim.run_id === runId && claim.document_version_id === documentVersionId)
      .map((claim) => {
        const source = this.sources.find(
          (item) => item.run_id === runId && item.stable_key === claim.source_key,
        );
        return ExportClaimSchema.parse({
          id: stableId(
            "claim",
            runId,
            documentVersionId,
            String(claim.claim_text),
            JSON.stringify(claim.location),
          ),
          claim_text: claim.claim_text,
          type: claim.type,
          status: claim.status,
          hard_flag: claim.hard_flag,
          hard_flag_reason: projectHardFlagReason({
            hard_flag: Boolean(claim.hard_flag),
            hard_flag_reason: claim.hard_flag_reason as never,
          }),
          location: claim.location,
          claim_hash: canonicalHash({ text: claim.claim_text, location: claim.location }),
          sources: source
            ? [
                {
                  id: String(source.stable_key),
                  uri: String(source.uri),
                  ...(source.title ? { title: String(source.title).slice(0, 300) } : {}),
                  ...(source.source_type === "public_storefront" ? { publisher: "Mobelaris" } : {}),
                  retrieved_at: String(source.retrieved_at),
                  content_hash: String(source.content_hash),
                  ...(typeof (source.snapshot as Record<string, unknown>).extraction_method ===
                  "string"
                    ? {
                        evidence_location: String(
                          (source.snapshot as Record<string, unknown>).extraction_method,
                        ).slice(0, 500),
                      }
                    : {}),
                  evidence: String(claim.evidence ?? source.evidence ?? "").slice(0, 2_000),
                  evidence_hash: claim.evidence ? contentHash(String(claim.evidence)) : null,
                },
              ]
            : [],
        });
      });
  }

  async getRejectedFindings(
    runId: string,
    _finalDocumentVersionId: string,
  ): Promise<ExportRejectedFinding[]> {
    this.requireRun(runId);
    return this.findings
      .filter((finding) => {
        const disposition = this.dispositions.find((item) => item.finding_id === finding.id);
        return (
          disposition?.decision === "rejected" &&
          finding.run_id === runId &&
          this.findingReviewSets.some(
            (set) => set.run_id === runId && set.finding_ids.includes(finding.id),
          )
        );
      })
      .map((finding) => {
        const disposition = this.dispositions.find((item) => item.finding_id === finding.id)!;
        const reviewSet = this.findingReviewSets.find(
          (set) => set.run_id === runId && set.finding_ids.includes(finding.id),
        )!;
        return ExportRejectedFindingSchema.parse({
          finding_id: finding.id,
          disposition_id: stableId("disposition", runId, finding.id),
          review_set_id: reviewSet.id,
          review_set_membership_hash: reviewSet.membership_hash,
          stable_key: finding.stable_key,
          category: finding.category,
          rule_reference: finding.rule_reference,
          severity: finding.severity,
          location: finding.location,
          issue: finding.issue,
          ...(finding.evidence ? { evidence: finding.evidence } : {}),
          suggested_fix: finding.suggested_fix,
          rationale: disposition.rationale ?? null,
          finding_hash: canonicalHash({
            id: finding.id,
            stable_key: finding.stable_key,
            location: finding.location,
          }),
          disposition_hash: canonicalHash({
            decision: disposition.decision,
            rationale: disposition.rationale ?? null,
          }),
        });
      });
  }

  async getContentTemplates() {
    return {
      writer_template: DEFAULT_WRITER_TEMPLATE,
      schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
    };
  }

  async saveRevision(input: {
    run_id: string;
    execution_id: string;
    token: string;
    request: RevisionRequest;
    response: RevisionResponse;
    provider: string;
    model: string;
    audits: import("../../shared/milestone-four.js").RevisionAudit[];
  }) {
    const request = RevisionRequestSchema.parse(input.request),
      response = RevisionResponseSchema.parse(input.response);
    const fenced = this.assertFence(input.run_id, input.execution_id, input.token);
    const run = fenced.run,
      current = run.draft;
    if (!current || current.version.id !== request.document_version_id)
      throw new Error("Revision must target the current document");
    const operationKey = `revision:${request.operation_id}`;
    const existing = this.outputKeys.get(operationKey);
    if (existing) {
      if (existing !== canonicalHash(response)) throw new Error("Immutable revision conflict");
      return { draft: current.draft, artifact: current.artifact, version: current.version };
    }
    const body = JSON.stringify(response.document),
      hash = contentHash(body);
    const artifact: ArtifactRecord = {
      id: stableId("artifact", input.run_id, String(current.version.revision + 1), hash),
      run_id: input.run_id,
      step_execution_id: input.execution_id,
      parent_id: current.artifact.id,
      kind: "draft_revision",
      media_type: "application/json",
      body_text: body,
      content_hash: hash,
    };
    const version: DocumentVersionRecord = {
      id: stableId("document", input.run_id, String(current.version.revision + 1), hash),
      run_id: input.run_id,
      artifact_id: artifact.id,
      parent_id: current.version.id,
      revision: current.version.revision + 1,
      content_hash: hash,
    };
    const requestBody = JSON.stringify(request),
      responseBody = JSON.stringify(response);
    this.artifacts.push(
      artifact,
      {
        id: stableId("artifact", input.run_id, request.operation_id, "request"),
        run_id: input.run_id,
        step_execution_id: input.execution_id,
        parent_id: current.artifact.id,
        kind: "revision_request",
        media_type: "application/json",
        body_text: requestBody,
        content_hash: contentHash(requestBody),
      },
      {
        id: stableId("artifact", input.run_id, request.operation_id, "response"),
        run_id: input.run_id,
        step_execution_id: input.execution_id,
        parent_id: artifact.id,
        kind: "revision_response",
        media_type: "application/json",
        body_text: responseBody,
        content_hash: contentHash(responseBody),
      },
    );
    this.documentVersions.push(version);
    const inheritedClaims = this.claims
      .filter(
        (claim) =>
          claim.run_id === input.run_id && claim.document_version_id === current.version.id,
      )
      .map((claim) => ({
        ...structuredClone(claim),
        document_version_id: version.id,
      }));
    this.claims.push(...inheritedClaims);
    this.providerUsage.push({
      id: stableId("usage", input.run_id, input.provider, request.operation_id),
      run_id: input.run_id,
      step_execution_id: input.execution_id,
      provider: input.provider,
      model: input.model,
      operation: "revision_pass",
      request_id: request.operation_id,
      ...response.usage,
    });
    this.revisionRequests.push(structuredClone(request));
    if (!request.revision_source) throw new Error("Authoritative revision source is missing");
    this.outputKeys.set(`revision-source:${version.id}`, request.revision_source);
    this.outputKeys.set(`revision-audits:${version.id}`, JSON.stringify(input.audits));
    run.draft = {
      draft: structuredClone(response.document),
      canonicalHash: canonicalHash(response.document),
      artifact,
      version,
    };
    this.outputKeys.set(operationKey, canonicalHash(response));
    this.completeValidatedStep(run, fenced.state);
    return { draft: run.draft.draft, artifact, version };
  }

  async completeRevisionNoop(input: {
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
  }): Promise<void> {
    const fenced = this.assertFence(input.run_id, input.execution_id, input.token);
    if (fenced.run.draft?.version.id !== input.document_version_id)
      throw new Error("Revision must target the current document");
    this.outputKeys.set(`revision-noop:${input.operation_id}`, input.document_version_id);
    this.outputKeys.set(`revision-source:${input.document_version_id}`, input.source);
    this.completeValidatedStep(fenced.run, fenced.state);
  }

  async saveRerun(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    result: DeterministicRunResult;
    findings: ReviewFinding[];
  }): Promise<"continue" | "repair" | "blocked"> {
    const result = DeterministicRunResultSchema.parse(input.result);
    if (result.document_id !== input.document_version_id)
      throw new Error("Step 1.11 document mismatch");
    const key = `${input.run_id}:${input.document_version_id}`;
    this.assertFence(input.run_id, input.execution_id, input.token);
    const existing = this.deterministicReruns.get(key);
    if (existing) {
      if (canonicalHash(existing) === canonicalHash(result)) {
        const run = this.requireRun(input.run_id);
        const blockers =
          result.comparison!.retained_blockers.length +
          result.comparison!.introduced_blockers.length;
        return blockers === 0
          ? "continue"
          : run.deterministicRepairCycles >= 2
            ? "blocked"
            : "repair";
      }
      throw new ConflictError("Step 1.11 rerun already exists with different content");
    }
    await this.saveFindings(
      input.run_id,
      input.document_version_id,
      input.execution_id,
      input.token,
      input.findings.map((finding) => ({ ...finding, hard_flag: false })),
      false,
    );
    this.deterministicReruns.set(key, structuredClone(result));
    this.deterministicRerunExecutions.set(key, input.execution_id);
    const run = this.requireRun(input.run_id);
    const state = this.findExecution(input.execution_id).state;
    const blockerCount =
      result.comparison!.retained_blockers.length + result.comparison!.introduced_blockers.length;
    if (blockerCount === 0) {
      this.completeValidatedStep(run, state);
      return "continue";
    }
    state.status = "succeeded";
    state.token = null;
    state.expiresAt = null;
    if (run.deterministicRepairCycles >= 2) {
      run.status = "blocked";
      run.currentStep = "automated_checks_rerun";
      run.blockReason = "deterministic_blockers";
      return "blocked";
    }
    run.deterministicRepairCycles += 1;
    run.status = "running";
    run.currentStep = "revision_pass";
    run.blockReason = null;
    return "repair";
  }

  async getDeterministicGate(runId: string, documentVersionId: string) {
    const result = this.deterministicReruns.get(`${runId}:${documentVersionId}`);
    const current = this.requireRun(runId).draft?.version;
    if (!result || !result.comparison) throw new Error("Step 1.11 result is missing");
    return {
      retained_blockers: result.comparison.retained_blockers.length,
      introduced_blockers: result.comparison.introduced_blockers.length,
      exact_document_match:
        current?.id === result.document_id &&
        current.content_hash === result.document_hash &&
        documentVersionId === result.document_id,
      result_hash: result.result_hash,
    };
  }

  async getCoherenceRevisionContext(runId: string, documentVersionId: string) {
    const run = this.requireRun(runId);
    const current = run.draft?.version;
    if (!current || current.id !== documentVersionId || !current.parent_id)
      throw new Error("Coherence requires an exact revised parent/current pair");
    const parent = this.documentVersions.find((version) => version.id === current.parent_id);
    const artifact = parent && this.artifacts.find((item) => item.id === parent.artifact_id);
    if (!parent || !artifact) throw new Error("Coherence parent document is missing");
    const parsed = readStoredStructuredDraft(JSON.parse(artifact.body_text)).draft;
    const storedSource = this.outputKeys.get(`revision-source:${current.id}`);
    const storedAudits = this.outputKeys.get(`revision-audits:${current.id}`);
    const audits = storedAudits
      ? (
          JSON.parse(storedAudits) as import("../../shared/revision-application.js").RevisionAudit[]
        ).map(
          ({ finding_id, status, reason, location, hunks, changed, before_hash, after_hash }) => ({
            finding_id,
            status,
            reason,
            location,
            hunks,
            changed,
            before_hash,
            after_hash,
          }),
        )
      : [];
    return {
      parent_document_version_id: parent.id,
      parent_document: parsed,
      revision_reason:
        (storedSource as "operator_findings" | "deterministic_repair" | "coherence_repair") ??
        (run.coherenceReturnCycles
          ? ("coherence_repair" as const)
          : ("operator_findings" as const)),
      coherence_cycle: run.coherenceReturnCycles,
      revision_audits: audits,
    };
  }

  async blockFinalForDeterministic(
    runId: string,
    _documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void> {
    const { run, state } = this.assertFence(runId, executionId, token);
    state.status = "blocked";
    state.token = null;
    state.expiresAt = null;
    run.status = "blocked";
    run.currentStep = "final_coherence_export";
    run.blockReason = "deterministic_blockers";
  }

  async beginCoherenceOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    document_version_id: string;
    request: CoherenceRequest;
  }) {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `coherence-state:${input.operation_id}`,
      identity = canonicalHash(input.request),
      existing = this.outputKeys.get(key);
    if (existing && existing !== identity)
      throw new Error("Immutable coherence operation conflict");
    this.outputKeys.set(key, identity);
    this.outputKeys.set(`${key}:run-id`, input.run_id);
    if (!this.outputKeys.has(`${key}:producer`))
      this.outputKeys.set(`${key}:producer`, input.execution_id);
    const statusKey = `${key}:status`;
    // A newly inserted checkpoint starts in the pre-dispatch state. Keep an
    // existing state untouched so retries observe the durable transition.
    if (!this.outputKeys.has(statusKey)) this.outputKeys.set(statusKey, "started");
    const response = this.outputKeys.get(`${key}:response`);
    if (response) return CoherenceResponseSchema.parse(JSON.parse(response));
    // Parity with PostgreSQL: a durable pre-dispatch marker without a
    // checkpoint means the paid call may already have been processed upstream.
    if (this.outputKeys.get(`${key}:status`) === "provider_in_flight")
      throw new Error(
        "Coherence provider outcome is ambiguous; no duplicate call was made. Operator action is required before this document can continue.",
      );
    return null;
  }
  async markCoherenceProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `coherence-state:${input.operation_id}`;
    if (!this.outputKeys.has(key) || this.outputKeys.has(`${key}:response`))
      throw new Error("Coherence operation cannot start a provider call");
    const status = this.outputKeys.get(`${key}:status`);
    if (status !== "started")
      throw new Error("Coherence operation is not ready for provider dispatch");
    this.outputKeys.set(`${key}:status`, "provider_in_flight");
    this.outputKeys.set(`${key}:owner`, `step_execution:${input.execution_id}`);
  }
  async releaseCoherenceProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `coherence-state:${input.operation_id}`;
    if (this.outputKeys.has(`${key}:response`))
      throw new Error("Checkpointed coherence response cannot be released");
    if (this.outputKeys.get(`${key}:status`) !== "provider_in_flight")
      throw new Error("Coherence release requires an in-flight provider operation");
    this.outputKeys.set(`${key}:status`, "started");
    this.outputKeys.set(`${key}:release-reason`, input.reason);
  }
  async checkpointCoherenceResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: CoherenceResponse;
  }) {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const parsed = CoherenceResponseSchema.parse(input.response),
      key = `coherence-state:${input.operation_id}:response`,
      value = JSON.stringify(parsed),
      responseHash = canonicalHash(parsed),
      existing = this.outputKeys.get(key),
      statusKey = `coherence-state:${input.operation_id}:status`,
      status = this.outputKeys.get(statusKey);
    if (existing) {
      if (canonicalHash(CoherenceResponseSchema.parse(JSON.parse(existing))) !== responseHash)
        throw new Error("Immutable coherence checkpoint conflict");
      if (status !== "checkpointed")
        throw new Error("Checkpointed coherence response has invalid status");
      return;
    }
    if (status !== "provider_in_flight")
      throw new Error("Coherence checkpoint requires an in-flight provider operation");
    this.outputKeys.set(key, value);
    this.outputKeys.set(statusKey, "checkpointed");
  }

  async recoverCoherence(
    runId: string,
    documentVersionId: string,
    operationId: string,
    recoveryExecutionId: string,
    token: string,
  ): Promise<PersistedCoherence | null> {
    this.assertFence(runId, recoveryExecutionId, token);
    const value = this.coherenceOperations.get(operationId);
    if (!value) return null;
    const run = this.requireRun(runId);
    if (documentVersionId !== run.draft?.version.id)
      throw new Error("Persisted coherence document mismatch");
    const coherenceBlockers = value.response.findings.filter(
      (finding) => finding.severity === "blocker",
    ).length;
    const outcome =
      coherenceBlockers === 0 ? "export" : run.status === "blocked" ? "blocked" : "revise";
    return structuredClone({
      ...value,
      gate: { ...value.gate, coherence_blockers: coherenceBlockers, outcome },
    });
  }

  async saveCoherence(input: {
    run_id: string;
    document_version_id: string;
    execution_id: string;
    token: string;
    request: CoherenceRequest;
    response: CoherenceResponse;
    provider: string;
    model: string;
  }): Promise<"revise" | "blocked" | "export"> {
    const request = CoherenceRequestSchema.parse(input.request),
      response = CoherenceResponseSchema.parse(input.response);
    const fenced = this.assertFence(input.run_id, input.execution_id, input.token),
      run = fenced.run;
    const operationKey = `coherence:${request.operation_id}`;
    const existing = this.outputKeys.get(operationKey);
    if (existing) {
      if (existing !== canonicalHash(response)) throw new Error("Immutable coherence conflict");
      return response.findings.some((finding) => finding.severity === "blocker")
        ? run.coherenceReturnCycles >= 2
          ? "blocked"
          : "revise"
        : "export";
    }
    const prefixed = response.findings.map((finding) => ({
      ...finding,
      stable_key: `coherence:r${run.coherenceReturnCycles}:${finding.stable_key}`,
    }));
    const bodyRequest = JSON.stringify(request),
      bodyResponse = JSON.stringify(response);
    this.artifacts.push(
      {
        id: stableId("artifact", input.run_id, request.operation_id, "request"),
        run_id: input.run_id,
        step_execution_id: input.execution_id,
        parent_id: run.draft!.artifact.id,
        kind: "coherence_request",
        media_type: "application/json",
        body_text: bodyRequest,
        content_hash: contentHash(bodyRequest),
      },
      {
        id: stableId("artifact", input.run_id, request.operation_id, "response"),
        run_id: input.run_id,
        step_execution_id: input.execution_id,
        parent_id: run.draft!.artifact.id,
        kind: "coherence_response",
        media_type: "application/json",
        body_text: bodyResponse,
        content_hash: contentHash(bodyResponse),
      },
    );
    const stableKeys = new Set(
      this.findings
        .filter(
          (f) => f.run_id === input.run_id && f.document_version_id === input.document_version_id,
        )
        .map((f) => f.stable_key),
    );
    for (const finding of prefixed) {
      if (stableKeys.has(finding.stable_key)) throw new Error("Finding stable key conflict");
      this.findings.push({
        ...finding,
        hard_flag: false,
        id: stableId("finding", input.run_id, input.document_version_id, finding.stable_key),
        run_id: input.run_id,
        document_version_id: input.document_version_id,
        step_execution_id: input.execution_id,
        step: "final_coherence_export",
        disposition: null,
        rationale: null,
      });
    }
    this.providerUsage.push({
      id: stableId("usage", input.run_id, input.provider, request.operation_id),
      run_id: input.run_id,
      step_execution_id: input.execution_id,
      provider: input.provider,
      model: input.model,
      operation: "final_coherence_export",
      request_id: request.operation_id,
      ...response.usage,
    });
    this.coherenceRequests.push(structuredClone(request));
    this.outputKeys.set(operationKey, canonicalHash(response));
    const blockers = response.findings.some((finding) => finding.severity === "blocker");
    const outcome = blockers ? (run.coherenceReturnCycles >= 2 ? "blocked" : "revise") : "export";
    this.coherenceOperations.set(request.operation_id, {
      operation_id: request.operation_id,
      response: structuredClone(response),
      gate: {
        deterministic_blockers: 0,
        coherence_blockers: response.findings.filter((finding) => finding.severity === "blocker")
          .length,
        outcome,
      },
      producing_step_execution_id: input.execution_id,
    });
    if (blockers && run.coherenceReturnCycles >= 2) {
      fenced.state.status = "blocked";
      fenced.state.token = null;
      fenced.state.expiresAt = null;
      run.status = "blocked";
      run.currentStep = "final_coherence_export";
      run.blockReason = "coherence_cycle_cap";
      return "blocked";
    }
    if (blockers) {
      run.coherenceReturnCycles += 1;
      fenced.state.status = "succeeded";
      fenced.state.token = null;
      fenced.state.expiresAt = null;
      run.status = "running";
      run.currentStep = "revision_pass";
      run.blockReason = null;
      return "revise";
    }
    return "export";
  }

  async export(input: {
    run_id: string;
    document_version_id: string;
    idempotency_key: string;
    render_input: import("../../shared/export.js").ExportRenderInput;
    rendered: ExportRenderResult;
  }): Promise<ReturnType<typeof GoogleDocsExportSchema.parse>> {
    const prior = this.exports.find(
      (item) =>
        item.run_id === input.run_id && item.document_version_id === input.document_version_id,
    );
    const id = stableId("google-doc", input.idempotency_key);
    if (!prior)
      this.exports.push({
        run_id: input.run_id,
        document_version_id: input.document_version_id,
        external_url: `https://docs.google.local/document/d/${id}`,
        external_document_id: id,
        status: "pending",
      });
    return GoogleDocsExportSchema.parse({
      external_document_id: id,
      external_url: prior?.external_url ?? `https://docs.google.local/document/d/${id}`,
      replayed: Boolean(prior),
    });
  }

  async completeFinal(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void> {
    const { run, state } = this.assertFence(runId, executionId, token);
    if (
      run.draft?.version.id !== documentVersionId ||
      !this.exports.some(
        (item) => item.run_id === runId && item.document_version_id === documentVersionId,
      )
    )
      throw new Error("Final export is incomplete");
    state.status = "succeeded";
    state.token = null;
    state.expiresAt = null;
    run.status = "succeeded";
    run.currentStep = "final_coherence_export";
    run.blockReason = null;
  }

  /** Mirrors the PostgreSQL page exactly, including the id tie-breaker. */
  async listRunPage(query: RunListQuery): Promise<RunListPage> {
    const statuses = new Set<string>(RUN_LIST_FILTER_STATUSES[query.filter]);
    const matching = Array.from(this.runs.entries())
      .filter(([, run]) => statuses.has(run.status))
      .sort((left, right) =>
        right[1].createdAt === left[1].createdAt
          ? right[0].localeCompare(left[0])
          : right[1].createdAt - left[1].createdAt,
      );
    const offset = runListOffset(query);
    return RunListPageSchema.parse({
      runs: matching.slice(offset, offset + query.limit).map(([id, run]) => ({
        run_id: id,
        plane_ticket: run.handoff.plane_ticket,
        primary_keyword: run.handoff.primary_keyword,
        status: run.status,
        current_step: run.currentStep,
        created_at: new Date(run.createdAt).toISOString(),
        updated_at: new Date(run.updatedAt).toISOString(),
      })),
      pagination: runListPagination({
        page: query.page,
        limit: query.limit,
        total_items: matching.length,
      }),
      filter: query.filter,
    });
  }

  async listRuns(limit: number) {
    return Array.from(this.runs.entries())
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, limit)
      .map(([id, run]) =>
        RunSummarySchema.parse({
          run_id: id,
          plane_ticket: run.handoff.plane_ticket,
          primary_keyword: run.handoff.primary_keyword,
          status: run.status,
          current_step: run.currentStep,
          created_at: new Date(run.createdAt).toISOString(),
          updated_at: new Date(run.updatedAt).toISOString(),
        }),
      );
  }

  async getUsageTotals(runId: string) {
    this.requireRun(runId);
    return UsageTotalsSchema.parse(
      this.providerUsage
        .filter((item) => item.run_id === runId)
        .reduce(
          (sum, item) => ({
            input_units: sum.input_units + item.input_units,
            output_units: sum.output_units + item.output_units,
            cost_micros: sum.cost_micros + item.cost_micros,
          }),
          { input_units: 0, output_units: 0, cost_micros: 0 },
        ),
    );
  }

  async recoverDeterministicBlock(runId: string): Promise<boolean> {
    const run = this.requireRun(runId);
    const currentDocumentId = run.draft?.version.id;
    const rerunKey = currentDocumentId ? `${runId}:${currentDocumentId}` : "";
    const rerun = this.deterministicReruns.get(rerunKey);
    const rerunExecutionId = this.deterministicRerunExecutions.get(rerunKey);
    const hasAuthoritativeBlocker = Boolean(
      rerun?.comparison &&
      rerunExecutionId &&
      rerun.comparison.retained_blockers.length + rerun.comparison.introduced_blockers.length > 0 &&
      this.findings.some(
        (finding) =>
          finding.run_id === runId &&
          finding.document_version_id === currentDocumentId &&
          finding.step_execution_id === rerunExecutionId &&
          finding.step === "automated_checks_rerun" &&
          finding.severity === "blocker",
      ),
    );
    if (
      run.status !== "blocked" ||
      run.blockReason !== "deterministic_blockers" ||
      run.deterministicRepairCycles >= 2 ||
      !hasAuthoritativeBlocker
    )
      return false;
    run.status = "running";
    run.currentStep = "revision_pass";
    run.blockReason = null;
    run.deterministicRepairCycles += 1;
    run.updatedAt = this.now();
    return true;
  }

  async authoriseExceptionalCorrection(input: {
    run_id: string;
    idempotency_key: string;
    explicit_confirmation: true;
  }): Promise<"authorised" | "replay"> {
    // Exact key ownership first, then a separate check for an authorisation this
    // run already holds under a different key. Both paths are observational.
    const sameKey = this.exceptionalCorrectionAuthorisations.find(
      (item) => item.idempotency_key === input.idempotency_key,
    );
    if (sameKey) {
      if (sameKey.run_id !== input.run_id) throw new ConflictError("Authorisation key conflict");
      return "replay";
    }
    if (this.exceptionalCorrectionAuthorisations.some((item) => item.run_id === input.run_id))
      throw new ConflictError("The run already has an exceptional authorisation.");
    const run = this.requireRun(input.run_id);
    const documentVersionId = run.draft?.version.id;
    const rerunKey = documentVersionId ? `${input.run_id}:${documentVersionId}` : "";
    const result = this.deterministicReruns.get(rerunKey);
    const executionId = this.deterministicRerunExecutions.get(rerunKey);
    const exactBlockers = this.findings.filter(
      (finding) =>
        finding.run_id === input.run_id &&
        finding.document_version_id === documentVersionId &&
        finding.step_execution_id === executionId &&
        finding.step === "automated_checks_rerun" &&
        finding.severity === "blocker",
    ) as ExceptionalCorrectionFinding[];
    const preview = run.draft
      ? previewExceptionalCorrection({
          draft: run.draft.draft,
          handoff: run.handoff,
          documentVersionId: documentVersionId!,
          findings: exactBlockers,
          exclusions: revisionBindingExclusions({
            document: run.draft.draft,
            // Same exclusions execution will apply, so authorisation can never
            // record authority over rejected prose.
            rejectedLocations: this.findings.flatMap((finding) =>
              finding.run_id === input.run_id &&
              finding.document_version_id === documentVersionId &&
              this.dispositions.find(
                (item) => item.finding_id === finding.id && item.decision === "rejected",
              )
                ? [finding.location]
                : [],
            ),
          }),
          ...(run.links ? { internalLinks: run.links } : {}),
        })
      : null;
    const bindings = preview?.bindings ?? null;
    if (
      !input.explicit_confirmation ||
      run.status !== "blocked" ||
      run.blockReason !== "deterministic_blockers" ||
      run.deterministicRepairCycles !== 2 ||
      run.exceptionalCorrectionAuthorised ||
      !result?.comparison ||
      exactBlockers.length === 0 ||
      !bindings ||
      exactBlockers.length !==
        result.comparison.retained_blockers.length + result.comparison.introduced_blockers.length
    )
      throw new ConflictError("Exceptional correction is not available for this exact document.");
    this.exceptionalCorrectionAuthorisations.push({
      run_id: input.run_id,
      document_version_id: documentVersionId!,
      deterministic_rerun_step_execution_id: executionId!,
      idempotency_key: input.idempotency_key,
      blocker_set_hash: canonicalHash(exactBlockers.map((item) => item.id)),
      bindings,
    });
    run.exceptionalCorrectionAuthorised = true;
    run.exceptionalCorrectionDocumentId = documentVersionId!;
    run.status = "running";
    run.currentStep = "revision_pass";
    run.blockReason = null;
    run.updatedAt = this.now();
    return "authorised";
  }

  async getRunDetail(runId: string) {
    const run = this.requireRun(runId),
      current = run.draft;
    const attempts = PIPELINE_STEPS.flatMap((definition) => {
      const values = run.steps.filter((item) => item.step === definition.id);
      return (
        values.length
          ? values
          : [
              {
                id: stableId("pending", runId, definition.id),
                step: definition.id,
                attempt: 1,
                status: "queued" as const,
                error: undefined,
              },
            ]
      ).map((item) => ({
        id: item.id,
        step: definition.id,
        number: definition.number,
        name: definition.name,
        attempt: item.attempt,
        status: item.status,
        error: item.error ?? null,
      }));
    });
    const currentFindings = current
      ? this.findings.filter((item) => item.document_version_id === current.version.id)
      : [];
    const exportRecord = current
      ? this.exports.find((item) => item.document_version_id === current.version.id)
      : undefined;
    const deterministicResult = current
      ? this.deterministicReruns.get(`${runId}:${current.version.id}`)
      : undefined;
    const deterministicBlockers = deterministicResult?.comparison
      ? deterministicResult.comparison.retained_blockers.length +
        deterministicResult.comparison.introduced_blockers.length
      : 0;
    const coherenceBlockers = currentFindings.filter(
      (item) => item.step === "final_coherence_export" && item.severity === "blocker",
    ).length;
    const exceptionalBlockers = currentFindings.filter(
      (item) => item.step === "automated_checks_rerun" && item.severity === "blocker",
    ) as ExceptionalCorrectionFinding[];
    const exceptionalExclusions = current
      ? revisionBindingExclusions({
          document: current.draft,
          rejectedLocations: currentFindings.flatMap((finding) =>
            this.dispositions.some(
              (item) => item.finding_id === finding.id && item.decision === "rejected",
            )
              ? [finding.location]
              : [],
          ),
        })
      : null;
    const exceptionalPreview =
      current && exceptionalBlockers.length === deterministicBlockers && exceptionalExclusions
        ? previewExceptionalCorrection({
            draft: current.draft,
            handoff: run.handoff,
            documentVersionId: current.version.id,
            findings: exceptionalBlockers,
            exclusions: exceptionalExclusions,
            ...(run.links ? { internalLinks: run.links } : {}),
          })
        : null;
    const draftOperationStatus = [...this.outputKeys.entries()].find(
      ([key, value]) => key.startsWith("draft-state:") && value.includes(`\"run_id\":\"${runId}\"`),
    );
    const paidOperationAmbiguities = [...this.outputKeys.entries()]
      .filter(([key, value]) => key.endsWith(":status") && value === "provider_in_flight")
      .flatMap(([statusKey]) => {
        const key = statusKey.slice(0, -":status".length);
        const identity = this.outputKeys.get(key);
        if (
          this.outputKeys.get(`${key}:run-id`) !== runId &&
          !identity?.includes(`\"run_id\":\"${runId}\"`)
        )
          return [];
        const kind = key.startsWith("draft-state:")
          ? "draft"
          : key.startsWith("review-operation:")
            ? "review"
            : key.startsWith("revision-state:")
              ? "revision"
              : key.startsWith("coherence-state:")
                ? "coherence"
                : null;
        if (!kind) return [];
        return [
          PaidOperationProjectionSchema.parse(
            paidOperationAmbiguity({
              operation_id: key.slice(key.indexOf(":") + 1),
              kind,
              owner:
                this.outputKeys.get(`${key}:owner`) ??
                `step_execution:${this.outputKeys.get(`${key}:producer`) ?? "unknown"}`,
            }),
          ),
        ];
      })
      .sort((left, right) =>
        `${left.kind}:${left.operation_id}`.localeCompare(`${right.kind}:${right.operation_id}`),
      );
    const draftRecovery =
      run.status === "retryable_failed" && run.currentStep === "draft" && !current
        ? draftOperationStatus
          ? this.outputKeys.get(`${draftOperationStatus[0]}:status`) === "provider_in_flight"
            ? ("ambiguous_technical_review" as const)
            : ("none" as const)
          : ("legacy_confirmation_required" as const)
        : ("none" as const);
    return RunDetailSchema.parse({
      run_id: runId,
      status: run.status,
      current_step: run.currentStep,
      updated_at: new Date(run.updatedAt).toISOString(),
      coherence_return_cycles: run.coherenceReturnCycles,
      deterministic_repair_cycles: run.deterministicRepairCycles,
      steps: attempts,
      current_document: current
        ? { version: current.version, artifact: current.artifact, draft: current.draft }
        : null,
      counts: {
        warnings: currentFindings.filter((item) => item.severity === "warning").length,
        unverified:
          current?.draft.claims.filter((item) => item.status === "unverified").length ?? 0,
        hard_flags: this.claims.filter(
          (item) =>
            item.run_id === runId &&
            item.document_version_id === current?.version.id &&
            item.hard_flag === true,
        ).length,
        rejected_findings: this.findings.filter(
          (item) => item.run_id === runId && item.disposition === "rejected",
        ).length,
      },
      usage: await this.getUsageTotals(runId),
      link_discovery: {
        shortlist: structuredClone(run.links ?? []),
        metadata: run.linkDiscoveryMetadata,
      },
      export: {
        status: exportRecord ? "succeeded" : "not_started",
        external_url: exportRecord?.external_url ?? null,
      },
      // "running" is never a live in-process state here — there is no background
      // worker, so it always means the run is resting between synchronous,
      // externally-triggered steps and needs the operator to trigger the next
      // one explicitly.
      can_retry:
        (run.status === "retryable_failed" && draftRecovery !== "ambiguous_technical_review") ||
        run.status === "running" ||
        // A run waiting at 1.9 with its dispositions recorded (step succeeded)
        // is resting between externally-triggered steps, ready to continue.
        (run.status === "waiting" &&
          run.steps.some(
            (candidate) => candidate.step === "findings_review" && candidate.status === "succeeded",
          )),
      draft_recovery: draftRecovery,
      blocked_for_operator: run.status === "blocked" || paidOperationAmbiguities.length > 0,
      paid_operation_ambiguities: paidOperationAmbiguities,
      serp_probe: (() => {
        const evidence = this.serpEvidence.get(`${runId}:${run.ingest.input_hash}`) ?? null;
        return {
          status: evidence?.status ?? "pending",
          evidence,
          warning: evidence ? serpWarning(evidence) : null,
        };
      })(),
      can_recover_deterministic_block:
        run.status === "blocked" &&
        run.blockReason === "deterministic_blockers" &&
        run.deterministicRepairCycles < 2 &&
        deterministicBlockers > 0 &&
        Boolean(this.deterministicRerunExecutions.get(`${runId}:${current?.version.id ?? ""}`)),
      exceptional_correction: {
        available:
          run.status === "blocked" &&
          run.blockReason === "deterministic_blockers" &&
          run.deterministicRepairCycles === 2 &&
          !run.exceptionalCorrectionAuthorised &&
          deterministicBlockers > 0 &&
          exceptionalPreview !== null,
        authorised: run.exceptionalCorrectionAuthorised,
        requires_ai: exceptionalPreview?.requires_ai ?? null,
      },
      block_reason: run.blockReason ?? "unknown",
      block_counts: {
        deterministic_blockers: deterministicBlockers,
        coherence_blockers: coherenceBlockers,
      },
      fact_evidence_sources: this.sources
        .filter((source) => source.run_id === runId)
        .flatMap((source) => {
          const snapshot = source.snapshot as Record<string, unknown>;
          const selection = snapshot.selection_evidence as Record<string, unknown> | undefined;
          return typeof snapshot.extraction_method === "string" &&
            typeof snapshot.evidence_hash === "string" &&
            typeof snapshot.evidence_excerpt === "string"
            ? [
                {
                  url: String(source.uri).slice(0, 2_048),
                  extraction_method: snapshot.extraction_method.slice(0, 120),
                  retrieved_at: String(source.retrieved_at),
                  content_hash: String(snapshot.content_hash ?? source.content_hash),
                  evidence_hash: snapshot.evidence_hash,
                  excerpt: snapshot.evidence_excerpt.slice(0, 2_000),
                  selection_reason: String(
                    snapshot.selection_reason ??
                      selection?.selection_reason ??
                      selection?.strategy ??
                      "Stored historical source evidence.",
                  ).slice(0, 500),
                },
              ]
            : [];
        }),
      deterministic_blocker_details: currentFindings
        .filter((item) => item.step === "automated_checks_rerun" && item.severity === "blocker")
        .map(({ rule_reference, location, issue, suggested_fix }) => ({
          rule_reference,
          location,
          issue,
          suggested_fix,
        })),
    });
  }

  runState(runId: string) {
    const run = this.requireRun(runId);
    return { status: run.status, current_step: run.currentStep };
  }
  async claimNextSerpWork(owner: string, leaseMs: number): Promise<SerpProbeWork | null> {
    if (!owner.trim() || leaseMs <= 0) throw new Error("SERP lease claim is invalid");
    for (const command of this.commands)
      if (
        command.kind === "probe_serp" &&
        !this.serpEvidence.has(`${command.run_id}:${command.handoff_hash}`)
      ) {
        const previous = this.serpLeases.get(command.command_id);
        if (previous && previous.expiresAt > this.now()) continue;
        const token = randomUUID();
        const expiresAt = this.now() + leaseMs;
        this.serpLeases.set(command.command_id, { owner, token, expiresAt });
        return {
          run_id: command.run_id,
          handoff_hash: command.handoff_hash,
          command_id: command.command_id,
          mode: previous ? "recover_without_dispatch" : "dispatch",
          lease_owner: owner,
          lease_token: token,
          lease_expires_at: new Date(expiresAt).toISOString(),
        };
      }
    return null;
  }

  async heartbeatSerpWork(rawWork: SerpProbeWork, leaseMs: number): Promise<void> {
    const work = this.requireSerpWorkIdentity(rawWork);
    const lease = this.serpLeases.get(work.command_id);
    if (
      !lease ||
      lease.token !== work.lease_token ||
      lease.owner !== work.lease_owner ||
      lease.expiresAt <= this.now()
    )
      throw new Error("SERP lease fencing rejected heartbeat");
    lease.expiresAt = this.now() + leaseMs;
  }

  async getSerpProbeHandoff(rawWork: SerpProbeWork): Promise<Handoff> {
    const work = this.requireSerpWorkIdentity(rawWork);
    const run = this.requireRun(work.run_id);
    if (run.ingest.input_hash !== work.handoff_hash) throw new Error("SERP handoff hash mismatch");
    return structuredClone(run.handoff);
  }

  async recordSerpEvidence(rawWork: SerpProbeWork, raw: SerpEvidence): Promise<void> {
    const work = this.requireSerpWorkIdentity(rawWork);
    const evidence = SerpEvidenceSchema.parse(raw);
    if (evidence.handoff_hash !== work.handoff_hash) throw new Error("SERP handoff hash mismatch");
    const key = `${work.run_id}:${work.handoff_hash}`;
    const existing = this.serpEvidence.get(key);
    const lease = this.serpLeases.get(work.command_id);
    if (!lease || lease.token !== work.lease_token || lease.owner !== work.lease_owner)
      throw new Error("SERP completion requires a matching lease fence");
    if (existing) {
      if (canonicalHash(existing) !== canonicalHash(evidence))
        throw new Error("Immutable SERP evidence conflict");
      return;
    }
    if (lease.expiresAt <= this.now())
      throw new Error("SERP completion requires a matching unexpired lease fence");
    this.serpEvidence.set(key, structuredClone(evidence));
  }

  private requireSerpWorkIdentity(rawWork: SerpProbeWork): SerpProbeWork {
    const work = SerpProbeWorkSchema.parse(rawWork);
    const command = this.commands.find(
      (candidate) => candidate.kind === "probe_serp" && candidate.command_id === work.command_id,
    );
    if (
      !command ||
      command.kind !== "probe_serp" ||
      command.run_id !== work.run_id ||
      command.handoff_hash !== work.handoff_hash
    )
      throw new Error("SERP work command identity mismatch");
    return work;
  }

  async findCommand(idempotencyKey: string) {
    return this.commands.find((command) => command.idempotency_key === idempotencyKey) ?? null;
  }

  configureEditorialCorrection(handler: (runId: string) => Promise<unknown>): void {
    this.editorialCorrectionHandler = handler;
  }

  async submitCommand(
    rawCommand: import("../../shared/commands.js").RunCommand,
  ): Promise<CommandSubmissionResult> {
    const command = parseRunCommand(rawCommand);
    const expectedHash = commandPayloadHash(command);
    if (command.payload_hash !== expectedHash)
      throw new RepositoryConflictError(
        "The command payload hash does not match its canonical input.",
      );
    const existing = this.commands.find((item) => item.idempotency_key === command.idempotency_key);
    if (existing) {
      if (commandPayloadHash(existing) !== expectedHash)
        throw new RepositoryConflictError(
          "The command idempotency key is bound to different input.",
        );
      const stored = this.commandResults.get(existing.command_id);
      if (!stored) throw new Error("Command terminal result is missing");
      return CommandSubmissionResultSchema.parse({ ...structuredClone(stored), replayed: true });
    }
    const transactionSnapshot = new Map<string, unknown>();
    for (const [key, value] of Object.entries(this))
      if (Array.isArray(value) || value instanceof Map || value instanceof Set)
        transactionSnapshot.set(key, structuredClone(value));
    try {
      let runId = "run_id" in command ? command.run_id : "";
      let result: unknown;
      let queueAccepted = false;
      switch (command.kind) {
        case "create_run":
          result = await this.createIngest(
            command.idempotency_key,
            canonicalHash(command.handoff),
            command.handoff,
            command.warnings,
          );
          runId = (result as IngestResult).run_id;
          queueAccepted = true;
          const handoffHash = canonicalHash(command.handoff);
          const probe = parseRunCommand({
            command_id: stableId("command", "probe-serp", runId, handoffHash),
            idempotency_key: `probe_serp:${runId}:${handoffHash}`,
            payload_hash: "0".repeat(64),
            requested_at: command.requested_at,
            kind: "probe_serp",
            run_id: runId,
            handoff_hash: handoffHash,
          });
          this.commands.push({ ...probe, payload_hash: commandPayloadHash(probe) });
          break;
        case "resume_run": {
          const run = this.requireRun(runId);
          if (run.status === "blocked") {
            if (!(await this.recoverDeterministicBlock(runId)))
              throw new ConflictError(
                "Only a deterministic blocker with remaining correction budget can be resumed.",
              );
          }
          await this.enqueueRun(runId, command.options);
          result = { queued: true };
          queueAccepted = true;
          break;
        }
        case "submit_findings":
          result = await this.submitDispositions(runId, command.dispositions);
          queueAccepted = (result as { continuation_required: boolean }).continuation_required;
          break;
        case "cancel_run":
          await this.cancelRun(runId);
          result = { cancelled: true };
          break;
        case "open_editorial_correction":
          if (!this.editorialCorrectionHandler)
            throw new UnprocessableError("Editorial correction is not configured.");
          result = await this.editorialCorrectionHandler(runId);
          break;
        case "authorise_exceptional_correction": {
          const outcome = await this.authoriseExceptionalCorrection({
            run_id: runId,
            idempotency_key: command.idempotency_key,
            explicit_confirmation: true,
          });
          result = { outcome };
          if (outcome === "authorised") {
            await this.enqueueRun(runId);
            queueAccepted = true;
          }
          break;
        }
        case "probe_serp":
          if (this.requireRun(runId).ingest.input_hash !== command.handoff_hash)
            throw new ConflictError("SERP handoff hash mismatch.");
          result = { queued: true };
          queueAccepted = true;
          break;
        case "retry_export": {
          const run = this.requireRun(runId);
          const final = [...run.steps]
            .reverse()
            .find((step) => step.step === "final_coherence_export");
          if (
            run.status !== "retryable_failed" ||
            run.currentStep !== "final_coherence_export" ||
            final?.status !== "retryable_failed" ||
            !final.error?.includes("STEP_1_12_FAILED;stage=google_docs_export;") ||
            !this.exports.some(
              (item) =>
                item.run_id === runId &&
                item.document_version_id === run.draft?.version.id &&
                item.status === "failed",
            )
          )
            throw new ConflictError("The export is not available for retry.");
          await this.enqueueRun(runId);
          result = { queued: true };
          queueAccepted = true;
          break;
        }
        default:
          throw new UnprocessableError(`Command ${command.kind} is not implemented in S3.`);
      }
      this.commands.push(structuredClone(command));
      this.commandActivity.push(
        parseCommandActivity({
          activity_id: `command:${command.command_id}:accepted`,
          run_id: runId,
          sequence: this.commandActivity.filter((item) => item.run_id === runId).length + 1,
          type: "command_accepted",
          occurred_at: command.requested_at,
          command_id: command.command_id,
          summary: "Command accepted.",
        }),
      );
      const terminal = CommandSubmissionResultSchema.parse({
        command_id: command.command_id,
        run_id: runId,
        replayed: false,
        queue_accepted: queueAccepted,
        result,
      });
      this.commandResults.set(command.command_id, structuredClone(terminal));
      return terminal;
    } catch (error) {
      for (const [key, snapshot] of transactionSnapshot) {
        const current = (this as unknown as Record<string, unknown>)[key];
        if (Array.isArray(current) && Array.isArray(snapshot))
          current.splice(0, current.length, ...snapshot);
        else if (current instanceof Map && snapshot instanceof Map) {
          current.clear();
          for (const [entryKey, entryValue] of snapshot) current.set(entryKey, entryValue);
        } else if (current instanceof Set && snapshot instanceof Set) {
          current.clear();
          for (const entry of snapshot) current.add(entry);
        }
      }
      throw error;
    }
  }

  async listCommandActivity(runId: string) {
    this.requireRun(runId);
    return this.commandActivity
      .filter((activity) => activity.run_id === runId)
      .map((activity) => structuredClone(activity));
  }

  async enqueueRun(runId: string, options: QueueOptions = {}): Promise<void> {
    const run = this.requireRun(runId);
    if (["succeeded", "cancelled", "waiting", "blocked"].includes(run.status))
      throw new ConflictError("This run is not queueable in its current state.");
    const parsed = QueueOptionsSchema.parse(options);
    const legacyReview =
      run.status === "retryable_failed" &&
      [
        "review_writing_style",
        "review_information_gain",
        "review_fact_checking",
        "review_link_conversion",
      ].includes(run.currentStep ?? "");
    if (legacyReview && parsed.authorise_legacy_review_recovery !== true)
      throw new ConflictError(
        "This historical review failure requires explicit operator recovery authorisation.",
      );
    const active = this.queueJobs.find(
      (job) => job.run_id === runId && !["completed", "cancelled"].includes(job.state),
    );
    if (active) {
      if (["ready", "leased", "retry_wait"].includes(active.state)) {
        const signal = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => value),
        ) as QueueOptions;
        if (!Object.keys(signal).length) return;
        const currentAuthority = Object.values(active.options).some(Boolean);
        const pendingAuthority =
          active.pendingRefresh || Object.keys(active.pendingOptions).length > 0;
        const sameRefresh =
          signal.refresh_link_discovery &&
          (active.pendingRefresh || active.options.refresh_link_discovery === true);
        const sameRecovery =
          !signal.refresh_link_discovery &&
          Object.keys(signal).every(
            (key) =>
              active.pendingOptions[key as keyof QueueOptions] ||
              active.options[key as keyof QueueOptions],
          );
        if ((currentAuthority || pendingAuthority) && !sameRefresh && !sameRecovery)
          throw new ConflictError("Queue authorities must be requested separately.");
        if (signal.refresh_link_discovery) {
          if (active.phase === "downstream_started")
            throw new ConflictError(
              "Link refresh cannot be accepted after paid downstream processing has started.",
            );
          active.pendingRefresh = true;
        } else active.pendingOptions = signal;
        return;
      }
      if (legacyReview && active.state !== "operator_action")
        throw new ConflictError("Historical review recovery is not available for this queue job.");
      Object.assign(active, {
        state: "ready",
        attempt: 0,
        phase: "pre_downstream",
        availableAt: this.now(),
        options: parsed,
        pendingRefresh: false,
        resumeAfterRefresh: false,
        pendingOptions: {},
      });
      delete active.error;
      return;
    }
    this.queueJobs.push({
      id: stableId("queue-job", runId, String(this.queueJobs.length)),
      run_id: runId,
      state: "ready",
      attempt: 0,
      phase: "pre_downstream",
      availableAt: this.now(),
      token: null,
      expiresAt: null,
      options: parsed,
      pendingRefresh: false,
      resumeAfterRefresh: false,
      pendingOptions: {},
    });
  }

  async claimQueueJob(_owner: string, leaseMs: number): Promise<QueueLease | null> {
    const job = this.queueJobs
      .filter((candidate) => {
        const status = this.requireRun(candidate.run_id).status;
        const refreshOnly =
          candidate.options.refresh_link_discovery === true &&
          Object.keys(candidate.options).length === 1;
        if (
          status === "cancelled" ||
          (["waiting", "blocked", "succeeded"].includes(status) && !refreshOnly)
        )
          return false;
        return (
          candidate.state === "ready" ||
          (candidate.state === "retry_wait" && candidate.availableAt <= this.now()) ||
          (candidate.state === "leased" && candidate.expiresAt! <= this.now())
        );
      })
      .sort((a, b) => a.availableAt - b.availableAt)[0];
    if (!job) return null;
    if (job.attempt >= 3) {
      job.state = "operator_action";
      job.token = null;
      job.expiresAt = null;
      return null;
    }
    job.state = "leased";
    job.attempt += 1;
    job.token = randomUUID();
    job.expiresAt = this.now() + leaseMs;
    return {
      id: job.id,
      run_id: job.run_id,
      token: job.token,
      attempt: job.attempt,
      phase: job.phase,
      options: job.options,
    };
  }

  async heartbeatQueueJob(jobId: string, token: string, leaseMs: number): Promise<boolean> {
    const job = this.queueJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.state !== "leased" || job.token !== token || job.expiresAt! <= this.now())
      return false;
    job.expiresAt = this.now() + leaseMs;
    return true;
  }

  async closeRefreshWindow(
    jobId: string,
    token: string,
  ): Promise<"refresh_promoted" | "downstream_started" | null> {
    const job = this.queueJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.state !== "leased" || job.token !== token || job.expiresAt! <= this.now())
      return null;
    if (job.pendingRefresh) {
      job.state = "ready";
      job.options = { refresh_link_discovery: true };
      job.pendingRefresh = false;
      job.resumeAfterRefresh = true;
      job.attempt = 0;
      job.phase = "pre_downstream";
      job.availableAt = this.now();
      job.token = null;
      job.expiresAt = null;
      delete job.error;
      return "refresh_promoted";
    }
    job.phase = "downstream_started";
    return "downstream_started";
  }

  async finishQueueJob(
    jobId: string,
    token: string,
    state: "parked" | "operator_action" | "completed" | "cancelled",
    errorCode?: string,
  ): Promise<boolean> {
    const job = this.queueJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.state !== "leased" || job.token !== token || job.expiresAt! <= this.now())
      return false;
    if (state !== "cancelled" && job.resumeAfterRefresh) {
      job.state = "ready";
      job.options = {};
      job.resumeAfterRefresh = false;
      job.phase = "pre_downstream";
      job.attempt = 0;
      job.availableAt = this.now();
      delete job.error;
    } else if (
      state !== "cancelled" &&
      (job.pendingRefresh || Object.keys(job.pendingOptions).length)
    ) {
      job.state = "ready";
      job.options = job.pendingRefresh ? { refresh_link_discovery: true } : job.pendingOptions;
      job.phase = "pre_downstream";
      job.pendingRefresh = false;
      job.pendingOptions = {};
      job.attempt = 0;
      job.availableAt = this.now();
      delete job.error;
    } else {
      job.state = state;
      if (errorCode === undefined) delete job.error;
      else job.error = errorCode;
    }
    job.token = null;
    job.expiresAt = null;
    return true;
  }

  async deferQueueJob(jobId: string, token: string, delayMs: number): Promise<boolean> {
    const job = this.queueJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.state !== "leased" || job.token !== token || job.expiresAt! <= this.now())
      return false;
    job.state = "retry_wait";
    job.attempt = Math.max(0, job.attempt - 1);
    job.availableAt = this.now() + delayMs;
    job.token = null;
    job.expiresAt = null;
    job.error = "step_lease_coordination_wait";
    return true;
  }

  async retryQueueJob(
    jobId: string,
    token: string,
    delayMs: number,
    errorCode: string,
  ): Promise<boolean> {
    const job = this.queueJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.state !== "leased" || job.token !== token || job.expiresAt! <= this.now())
      return false;
    job.state = job.attempt < 3 ? "retry_wait" : "operator_action";
    job.availableAt = this.now() + delayMs;
    job.token = null;
    job.expiresAt = null;
    job.error = errorCode;
    return true;
  }

  async recoverQueueJobs(): Promise<void> {
    for (const run of this.runs.values()) {
      for (const step of run.steps) {
        if (
          step.status === "running" &&
          step.expiresAt !== null &&
          step.expiresAt <= this.now() &&
          ![...this.outputKeys.entries()].some(
            ([key, value]) =>
              key.includes(run.ingest.result.run_id) && value === "provider_in_flight",
          )
        ) {
          step.status = "retryable_failed";
          step.token = null;
          step.expiresAt = null;
          step.error = "lease expired during startup recovery";
          run.status = "retryable_failed";
          run.currentStep = step.step;
        }
      }
      const runId = run.ingest.result.run_id;
      const resolvedCommands = this.commands
        .filter((command) => {
          const terminal = CommandSubmissionResultSchema.safeParse(
            this.commandResults.get(command.command_id),
          );
          if (!terminal.success || terminal.data.run_id !== runId || !this.runs.has(runId))
            return false;
          return "run_id" in command ? command.run_id === runId : command.kind === "create_run";
        })
        .sort(
          (left, right) =>
            left.requested_at.localeCompare(right.requested_at) ||
            left.command_id.localeCompare(right.command_id),
        );
      for (const command of resolvedCommands)
        if (!this.commandActivity.some((activity) => activity.command_id === command.command_id))
          this.commandActivity.push(
            parseCommandActivity({
              activity_id: `command:${command.command_id}:accepted`,
              run_id: runId,
              sequence:
                this.commandActivity.filter((activity) => activity.run_id === runId).length + 1,
              type: "command_accepted",
              occurred_at: command.requested_at,
              command_id: command.command_id,
              summary: "Command accepted.",
            }),
          );
      const terminal = run.status === "cancelled" || run.status === "succeeded";
      if (
        terminal &&
        !this.commandActivity.some((activity) => activity.activity_id === `run:${runId}:terminal`)
      )
        this.commandActivity.push(
          parseCommandActivity({
            activity_id: `run:${runId}:terminal`,
            run_id: runId,
            sequence:
              this.commandActivity.filter((activity) => activity.run_id === runId).length + 1,
            type: run.status === "cancelled" ? "run_cancelled" : "export_succeeded",
            occurred_at: new Date(run.updatedAt).toISOString(),
            summary: run.status === "cancelled" ? "Run cancelled." : "Export succeeded.",
          }),
        );
      const ambiguous =
        [...this.outputKeys.entries()].some(
          ([key, value]) => key.includes(runId) && value === "provider_in_flight",
        ) ||
        this.exports.some(
          (item) =>
            item.run_id === runId &&
            (item.status ?? "pending") === "pending" &&
            item.external_document_id !== undefined,
        );
      const existingQueue = this.queueJobs.find(
        (job) => job.run_id === runId && !["completed", "cancelled"].includes(job.state),
      );
      if (ambiguous && existingQueue) {
        existingQueue.state = "operator_action";
        existingQueue.token = null;
        existingQueue.expiresAt = null;
        existingQueue.error = "ambiguous_paid_operation";
      }
      const orphan = resolvedCommands.find(
        (command) =>
          command.kind !== "cancel_run" &&
          CommandSubmissionResultSchema.parse(this.commandResults.get(command.command_id))
            .queue_accepted,
      );
      if (orphan && ["running", "retryable_failed"].includes(run.status) && !existingQueue) {
        await this.enqueueRun(runId);
        if (ambiguous) {
          const recoveredQueue = this.queueJobs.find((job) => job.run_id === runId);
          if (recoveredQueue) {
            recoveredQueue.state = "operator_action";
            recoveredQueue.error = "ambiguous_paid_operation";
          }
        }
      }
    }
    for (const job of this.queueJobs) {
      const status = this.requireRun(job.run_id).status;
      if (status === "cancelled") {
        job.state = "cancelled";
        job.token = null;
        job.expiresAt = null;
      } else if (
        ["waiting", "blocked", "succeeded"].includes(status) &&
        job.options.refresh_link_discovery === true &&
        Object.keys(job.options).length === 1
      ) {
        // A previously promoted dedicated refresh remains claimable across startup.
      } else if (["waiting", "blocked", "succeeded"].includes(status) && job.pendingRefresh) {
        job.state = "ready";
        job.options = { refresh_link_discovery: true };
        job.phase = "pre_downstream";
        job.pendingRefresh = false;
        job.attempt = 0;
        job.availableAt = this.now();
        job.token = null;
        job.expiresAt = null;
      } else if (["waiting", "blocked", "succeeded"].includes(status)) {
        job.state = status === "succeeded" ? "completed" : "parked";
        job.token = null;
        job.expiresAt = null;
      } else if (job.state === "leased" && job.expiresAt! <= this.now()) {
        job.state = job.attempt < 3 ? "ready" : "operator_action";
        job.token = null;
        job.expiresAt = null;
      }
    }
  }

  async queueExecutionState(runId: string) {
    const run = this.requireRun(runId);
    const ambiguous =
      [...this.outputKeys.entries()].some(
        ([key, value]) => key.includes(runId) && value === "provider_in_flight",
      ) ||
      this.exports.some(
        (item) =>
          item.run_id === runId &&
          (item.status ?? "pending") === "pending" &&
          item.external_document_id !== undefined,
      );
    const coordination_wait = run.steps.some(
      (step) => step.status === "running" && step.expiresAt !== null && step.expiresAt > this.now(),
    );
    return { run_status: run.status, current_step: run.currentStep, ambiguous, coordination_wait };
  }

  async hasActiveQueueJob(runId: string): Promise<boolean> {
    return this.queueJobs.some(
      (job) => job.run_id === runId && ["ready", "leased", "retry_wait"].includes(job.state),
    );
  }

  private requireRun(id: string): RunState {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError("The run was not found.");
    return run;
  }
  private assertFence(
    runId: string,
    id: string,
    token: string,
  ): { run: RunState; state: StepState } {
    const found = this.findExecution(id);
    if (found.run !== this.requireRun(runId)) throw new Error("Stale fencing token");
    this.assertFenceState(found.state, token);
    return found;
  }
  private completeValidatedStep(run: RunState, state: StepState): void {
    state.status = "succeeded";
    state.token = null;
    state.expiresAt = null;
    run.blockReason = null;
    if (state.step === "internal_link_discovery") run.currentStep = "draft";
    else if (state.step === "findings_review") {
      run.status = "waiting";
      run.currentStep = "findings_review";
    } else {
      const index = PIPELINE_STEPS.findIndex((item) => item.id === state.step);
      const next = PIPELINE_STEPS[index + 1]?.id;
      if (next) run.currentStep = next;
    }
  }
  private safeFailureMessage(value: string): string {
    const known = [
      "Revision removed the handoff primary keyword intent",
      "Revision introduced, removed or altered an unsupported factual claim",
      "Revision altered",
      "Duplicate accepted finding",
      "Pipeline operation failed safely",
      // Structured, already-safe Step 1.12 diagnostics (stage/category/reason
      // only). Preserved here to match PostgresMilestoneRepository, so tests
      // observe the same operator-facing message the real repository stores.
      "STEP_1_12_FAILED",
      "lease expired",
      // Provider errors are redacted typed messages by construction (no secrets).
      "Review provider",
      "Revision provider",
      "Coherence provider",
      "Draft provider",
      "Step output belongs to another producing attempt",
      "Link discovery blocked:",
    ].find((message) => value.includes(message));
    return (known ? value : "Pipeline operation failed safely").slice(0, 160);
  }
  private requireNonEmpty(value: string, name: string): string {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
    return value.trim();
  }
  private assertFenceState(state: StepState, token: string): void {
    if (state.status !== "running" || state.token !== token || state.expiresAt! <= this.now())
      throw new Error("Stale fencing token");
  }
  private findExecution(id: string): { run: RunState; state: StepState } {
    for (const run of this.runs.values()) {
      const state = run.steps.find((candidate) => candidate.id === id);
      if (state) return { run, state };
    }
    throw new Error(`Unknown execution ${id}`);
  }
}

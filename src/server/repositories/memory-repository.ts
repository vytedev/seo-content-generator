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
import { ConflictError, NotFoundError, UnprocessableError } from "../../shared/errors.js";
import { PIPELINE_STEPS, type Handoff, type PipelineStepId } from "../../shared/pipeline.js";
import { FindingLocationSchema } from "../../shared/checker/index.js";
import { bindExceptionalBlockers } from "../../shared/exceptional-recovery.js";
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
  DraftProviderRequestSchema,
  DraftProviderResponseSchema,
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
  implements MilestoneRepository, MilestoneThreeRepository, MilestoneFourRepository
{
  private readonly runs = new Map<string, RunState>();
  private readonly keys = new Map<string, string>();
  readonly providerUsage: ProviderUsageRecord[] = [];
  readonly artifacts: ArtifactRecord[] = [];
  readonly documentVersions: DocumentVersionRecord[] = [];
  readonly findings: FindingRecord[] = [];
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
  readonly exports: Array<{ run_id: string; document_version_id: string; external_url: string }> =
    [];
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
  async claimStep(runId: string, step: PipelineStepId, _owner: string) {
    await this.ensureStep(runId, step);
    const run = this.requireRun(runId);
    const attempts = run.steps
      .filter((candidate) => candidate.step === step)
      .sort((a, b) => b.attempt - a.attempt);
    let state = attempts[0]!;
    if (state.status === "succeeded") {
      if (run.currentStep !== step) throw new Error("Step already succeeded");
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
    run.status = "running";
    run.currentStep = step;
    run.blockReason = null;
    run.updatedAt = this.now();
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
  async completeStep(executionId: string, token: string): Promise<void> {
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
    run.currentStep = order[Math.min(index + 1, order.length - 1)]!;
  }
  /** Operator stop: revokes in-flight leases; fenced writes then bounce. */
  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== "running")
      throw new ConflictError("Only a running blog post can be stopped.");
    for (const step of run.steps) {
      if (step.status === "running") {
        step.status = "cancelled";
        step.token = null;
        step.expiresAt = null;
      }
    }
    run.status = "cancelled";
    run.blockReason = null;
    run.updatedAt = this.now();
  }
  async failStep(executionId: string, token: string, error: string): Promise<void> {
    const { run, state } = this.findExecution(executionId);
    // A cancelled run keeps its operator-decided state; the unwinding
    // orchestrator's failure write must no-op instead of un-cancelling it.
    if (state.status === "cancelled") return;
    this.assertFenceState(state, token);
    state.status = "retryable_failed";
    state.token = null;
    state.expiresAt = null;
    state.error = this.safeFailureMessage(error);
    run.status = "retryable_failed";
    run.currentStep = state.step;
    run.blockReason = null;
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
  async saveDraft(
    runId: string,
    executionId: string,
    token: string,
    response: DraftProviderResponse,
    provider: string,
    model: string,
    rawRequest?: import("../../shared/milestone-two.js").DraftProviderRequest,
  ) {
    const parsed = DraftProviderResponseSchema.parse(response);
    const request = rawRequest ? DraftProviderRequestSchema.parse(rawRequest) : undefined;
    const parsedProvider = this.requireNonEmpty(provider, "provider");
    const parsedModel = this.requireNonEmpty(model, "model");
    this.assertFence(runId, executionId, token);
    const run = this.requireRun(runId);
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
    if (request) {
      const requestBody = JSON.stringify(request);
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
    }
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
  ): Promise<void> {
    const request = ReviewRequestSchema.parse(rawRequest);
    const response = PersistedReviewResponseSchema.parse(rawResponse);
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
    const key = `${runId}:${documentVersionId}:${step}`;
    const identity = canonicalHash(response);
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
    const waiting = run.steps.find(
      (item) => item.step === "findings_review" && item.status === "waiting",
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
    const frozen = this.activeReviewSet(runId);
    if (!frozen || frozen.findings_step_execution_id !== waiting.id)
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
    for (const { finding, item } of selected) {
      this.dispositions.push({
        finding_id: finding.id,
        decision: item.decision,
        ...(item.rationale?.trim() ? { rationale: item.rationale.trim() } : {}),
      });
    }
    const pending = reviewSet.some(
      (item) => !this.dispositions.some((disposition) => disposition.finding_id === item.id),
    );
    if (!pending) {
      this.findingReviewSubmissions.push({
        run_id: runId,
        review_set_id: frozen.id,
        idempotency_key: parsed.idempotency_key,
        payload_hash: payloadHash,
        finding_count: selected.length,
      });
      waiting.status = "succeeded";
      // Findings review has concluded — the run moves on to the next
      // (externally-triggered, model-owned) step rather than staying
      // parked at the step that just succeeded.
      run.status = "running";
      run.currentStep = "revision_pass";
      run.blockReason = null;
    }
    return { completed: !pending, submitted: selected.length, continuation_required: !pending };
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
    return { source, findings, rejected_locations, verified_fact_locations };
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
  }

  async releaseRevisionProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `revision-state:${input.operation_id}:status`;
    if (this.outputKeys.get(key) === "provider_in_flight") this.outputKeys.set(key, "started");
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
      .map((claim) =>
        ExportClaimSchema.parse({
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
          location: claim.location,
          claim_hash: canonicalHash({ text: claim.claim_text, location: claim.location }),
          sources: [],
        }),
      );
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
    const response = this.outputKeys.get(`${key}:response`);
    return response ? CoherenceResponseSchema.parse(JSON.parse(response)) : null;
  }
  async checkpointCoherenceResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: CoherenceResponse;
  }) {
    this.assertFence(input.run_id, input.execution_id, input.token);
    const key = `coherence-state:${input.operation_id}:response`,
      value = JSON.stringify(CoherenceResponseSchema.parse(input.response));
    const existing = this.outputKeys.get(key);
    if (existing && existing !== value) throw new Error("Immutable coherence checkpoint conflict");
    this.outputKeys.set(key, value);
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
    const replay = this.exceptionalCorrectionAuthorisations.find(
      (item) => item.idempotency_key === input.idempotency_key,
    );
    if (replay) {
      if (replay.run_id !== input.run_id) throw new ConflictError("Authorisation key conflict");
      return "replay";
    }
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
    );
    const bindings = run.draft ? bindExceptionalBlockers(run.draft.draft, exactBlockers) : null;
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
        run.status === "retryable_failed" ||
        run.status === "running" ||
        // A run waiting at 1.9 with its dispositions recorded (step succeeded)
        // is resting between externally-triggered steps, ready to continue.
        (run.status === "waiting" &&
          run.steps.some(
            (candidate) => candidate.step === "findings_review" && candidate.status === "succeeded",
          )),
      blocked_for_operator: run.status === "blocked",
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
          deterministicBlockers > 0,
        authorised: run.exceptionalCorrectionAuthorised,
        requires_ai: currentFindings.some(
          (item) =>
            item.step === "automated_checks_rerun" &&
            item.severity === "blocker" &&
            !["keyword.related.meaningful_section", "links.verified_internal_presence"].includes(
              item.rule_reference,
            ),
        ),
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

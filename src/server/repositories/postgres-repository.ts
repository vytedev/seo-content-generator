import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { SerpEvidenceSchema, type SerpEvidence } from "../../shared/ingest-contracts.js";
import { SerpProbeWorkSchema, type SerpProbeWork } from "../../shared/serp-evidence.js";
import { serpWarning } from "../pipeline/serp-probe-worker.js";
import { FindingLocationSchema } from "../../shared/checker/index.js";
import { revisionBindingExclusions } from "../../shared/revision-planning.js";
import type { FindingLocation } from "../../shared/revision-application.js";
import {
  ExceptionalBlockerBindingSchema,
  previewExceptionalCorrection,
  type ExceptionalCorrectionFinding,
} from "../../shared/exceptional-recovery.js";
import type { Pool, PoolClient } from "pg";
import {
  RUN_LIST_FILTER_STATUSES,
  RunListPageSchema,
  runListOffset,
  runListPagination,
  type RunListPage,
  type RunListQuery,
} from "../../shared/contracts/run-list.js";
import { classifyError, logger } from "../logger.js";
import {
  DeterministicManifestSchema,
  DeterministicRunResultSchema,
  type DeterministicManifest,
  type DeterministicRunResult,
} from "../../shared/deterministic-run.js";
import {
  HandoffSchema,
  PIPELINE_STEPS,
  type Handoff,
  type PipelineStepId,
} from "../../shared/pipeline.js";
import {
  CoherenceRequestSchema,
  CoherenceResponseSchema,
  PersistedCoherenceSchema,
  RevisionRequestSchema,
  RevisionResponseSchema,
  type CoherenceRequest,
  type CoherenceResponse,
  type MilestoneFourRepository,
  type RevisionFinding,
  type RevisionRequest,
  type RevisionResponse,
  type RevisionFailureIdentity,
  type RevisionSafeFailureCategory,
} from "../../shared/milestone-four.js";
import {
  BlogSchemaTemplateSchema,
  ExportClaimSchema,
  ExportRejectedFindingSchema,
  WriterTemplateSchema,
  type ExportClaim,
  type ExportRejectedFinding,
} from "../../shared/export.js";
import {
  RunDetailSchema,
  RunSummarySchema,
  UsageTotalsSchema,
  type RunBlockReason,
} from "../../shared/contracts/run-detail.js";
import {
  ArtifactSchema,
  DocumentVersionSchema,
  StructuredDraftSchema,
  readStoredStructuredDraft,
} from "../../shared/contracts/content.js";
import {
  ConflictError,
  NotFoundError,
  RepositoryConflictError,
  UnprocessableError,
} from "../../shared/errors.js";
import {
  BulkDispositionSchema,
  FindingFiltersSchema,
  PersistedReviewFindingSchema,
  PersistedReviewResponseSchema,
  ReviewRequestSchema,
  type BulkDisposition,
  type FindingRecord,
  type MilestoneThreeRepository,
  type PersistedReviewResponse,
  type ReferenceSnapshot,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewResponse,
  type ReviewStep,
} from "../../shared/milestone-three.js";
import {
  DraftProviderRequestSchema,
  DraftProviderResponseSchema,
  IngestResultSchema,
  InternalLinkSchema,
  InternalLinksArtifactSnapshotSchema,
  LiveInternalLinkSchema,
  LinkDiscoveryMetadataSchema,
  canonicalHash,
  stableId,
  deriveDraftOperationIdentity,
  linkCandidateProvenance,
  contentHash,
  type DraftOperationCommand,
  type DraftOperationIdentity,
  type DraftProviderResponse,
  type IngestResult,
  type InternalLink,
  type MilestoneRepository,
} from "../../shared/milestone-two.js";
import { QueueOptionsSchema, type QueueLease, type QueueOptions } from "../../shared/queue.js";
import { PaidOperationProjectionSchema } from "../../shared/paid-operation.js";
import { paidOperationAmbiguity } from "../providers/paid-operation-lifecycle.js";
import {
  CommandSubmissionResultSchema,
  commandPayloadHash,
  parseCommandActivity,
  parseRunCommand,
  type CommandSubmissionResult,
  type RunCommandRepository,
} from "../../shared/command-repository.js";

function projectEvidenceSource(row: any) {
  const snapshot = row.snapshot as Record<string, unknown> | null;
  if (
    !snapshot ||
    typeof snapshot.extraction_method !== "string" ||
    typeof snapshot.evidence_hash !== "string" ||
    typeof snapshot.evidence_excerpt !== "string"
  )
    return [];
  const selection = snapshot.selection_evidence as Record<string, unknown> | undefined;
  const reason = snapshot.selection_reason ?? selection?.selection_reason ?? selection?.strategy;
  return [
    {
      url: String(row.uri).slice(0, 2_048),
      extraction_method: snapshot.extraction_method.slice(0, 120),
      retrieved_at: new Date(row.retrieved_at).toISOString(),
      content_hash: String(snapshot.content_hash ?? row.content_hash),
      evidence_hash: snapshot.evidence_hash,
      excerpt: snapshot.evidence_excerpt.slice(0, 2_000),
      selection_reason: String(reason ?? "Stored historical source evidence.").slice(0, 500),
    },
  ];
}

export function assertImmutableSourceMatches(
  stored: {
    source_type: string;
    title: string | null;
    retrieved_at: Date | string;
    content_hash: string;
    snapshot: Record<string, unknown>;
    evidence?: readonly string[];
  },
  incoming: {
    source_type: string;
    title: string | null;
    retrieved_at: string;
    snapshot: Record<string, unknown>;
    evidence: string;
  },
  expectedHash: string,
): void {
  const retrievedAt =
    stored.retrieved_at instanceof Date
      ? stored.retrieved_at.toISOString()
      : new Date(stored.retrieved_at).toISOString();
  if (
    stored.source_type !== incoming.source_type ||
    stored.title !== incoming.title ||
    retrievedAt !== incoming.retrieved_at ||
    stored.content_hash !== expectedHash ||
    canonicalHash(stored.snapshot) !== canonicalHash(incoming.snapshot) ||
    (stored.evidence !== undefined &&
      (stored.evidence.length !== 1 || stored.evidence[0] !== incoming.evidence))
  )
    throw new Error("Immutable source conflict");
}

const authorisedReadabilityFromBindings = (
  bindings: ReadonlyArray<{
    finding_id: string;
    readability_blocks?: Array<{ line_start: number; line_end: number }> | undefined;
    selector_version?: string | undefined;
    target_set_identity?: string | undefined;
  }>,
) =>
  Object.fromEntries(
    bindings
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
  );

export class PostgresMilestoneRepository
  implements
    MilestoneRepository,
    MilestoneThreeRepository,
    MilestoneFourRepository,
    RunCommandRepository
{
  private readonly transactionContext = new AsyncLocalStorage<PoolClient>();
  private editorialCorrectionHandler: ((runId: string) => Promise<unknown>) | undefined;

  constructor(
    private readonly pool: Pool,
    // Long enough to cover a worst-case model operation (3 × 60s HTTP
    // attempts + backoff + corrective re-request ≈ 3.5 min) even before the
    // orchestrator's heartbeat renewal kicks in.
    private readonly leaseMs = 300_000,
    private readonly templateSelection: {
      writer: { template_id: string; version: string };
      schema: { template_id: string; version: string };
      allow_local_pending: boolean;
    } = {
      writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
      schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
      allow_local_pending: false,
    },
  ) {}

  async findIngest(key: string) {
    const result = await this.pool.query<{
      id: string;
      input_hash: string;
      handoff: Handoff;
      body_text: string | null;
    }>(
      `select r.id,r.input_hash,r.handoff,a.body_text from runs r
       left join artifacts a on a.run_id=r.id and a.kind='ingest_result' where r.idempotency_key=$1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    const resultValue = IngestResultSchema.parse({
      run_id: row.id,
      input_hash: row.input_hash,
      handoff: HandoffSchema.parse(row.handoff),
      warnings: row.body_text
        ? ((JSON.parse(row.body_text) as { warnings?: unknown }).warnings ?? [])
        : [],
    });
    return { key, input_hash: row.input_hash, result: resultValue };
  }

  async createIngest(
    key: string,
    inputHash: string,
    handoff: Handoff,
    warnings: IngestResult["warnings"],
  ): Promise<IngestResult> {
    return this.transaction(async (client) => {
      const runId = randomUUID(),
        executionId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `insert into runs(id,idempotency_key,input_hash,plane_ticket,handoff,status,current_step)
         values($1,$2,$3,$4,$5::jsonb,'running','internal_link_discovery')
         on conflict(idempotency_key) do nothing returning id`,
        [runId, key, inputHash, handoff.plane_ticket, JSON.stringify(handoff)],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ id: string; input_hash: string }>(
          "select id,input_hash from runs where idempotency_key=$1 for update",
          [key],
        );
        if (existing.rows[0]?.input_hash !== inputHash)
          throw new RepositoryConflictError(
            "The ingest idempotency key is bound to different input.",
          );
        const replay = await this.findIngestClient(client, key);
        if (!replay) throw new Error("Ingest replay missing");
        return replay.result;
      }
      await client.query(
        "insert into step_executions(id,run_id,step,attempt,status,started_at,completed_at) values($1,$2,'ingest_handoff',1,'succeeded',clock_timestamp(),clock_timestamp())",
        [executionId, runId],
      );
      const payload = { handoff, warnings },
        body = JSON.stringify(payload);
      await client.query(
        `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
        values($1,$2,'ingest_result','application/json',$3,$4,$5)`,
        [runId, executionId, body, contentHash(body), Buffer.byteLength(body)],
      );
      await this.enqueueRunClient(client, runId, {});
      return { run_id: runId, input_hash: inputHash, handoff, warnings };
    });
  }

  async ensureStep(runId: string, step: PipelineStepId): Promise<void> {
    await this.pool.query(
      `insert into step_executions(run_id,step,attempt,status)
      select $1,$2,1,'queued' where not exists(select 1 from step_executions where run_id=$1 and step=$2)
      on conflict(run_id,step,attempt) do nothing`,
      [runId, step],
    );
  }
  async stepSucceeded(runId: string, step: PipelineStepId): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from step_executions where run_id=$1 and step=$2 and status='succeeded' limit 1",
      [runId, step],
    );
    return result.rowCount === 1;
  }
  async stepWaiting(runId: string, step: PipelineStepId): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from step_executions where run_id=$1 and step=$2 and status='waiting' limit 1",
      [runId, step],
    );
    return result.rowCount === 1;
  }
  async claimStep(runId: string, step: PipelineStepId, owner: string, replaySucceeded = false) {
    return this.transaction(async (client) => {
      await client.query("select id from runs where id=$1 for update", [runId]);
      const latest = await client.query<{
        id: string;
        attempt: number;
        status: string;
        lease_expires_at: Date | null;
      }>(
        "select id,attempt,status,lease_expires_at from step_executions where run_id=$1 and step=$2 order by attempt desc limit 1 for update",
        [runId, step],
      );
      let row = latest.rows[0];
      if (!row) {
        row = (
          await client.query(
            `insert into step_executions(run_id,step,attempt,status) values($1,$2,1,'queued') returning id,attempt,status,lease_expires_at`,
            [runId, step],
          )
        ).rows[0]!;
      } else if (row.status === "succeeded") {
        const current = await client.query<{ current_step: PipelineStepId }>(
          "select current_step from runs where id=$1",
          [runId],
        );
        if (!replaySucceeded && current.rows[0]?.current_step !== step)
          throw new Error("Step already succeeded");
        row = (
          await client.query(
            `insert into step_executions(run_id,step,attempt,status) values($1,$2,$3,'queued') returning id,attempt,status,lease_expires_at`,
            [runId, step, row.attempt + 1],
          )
        ).rows[0]!;
      } else if (
        (row.status === "running" || row.status === "leased") &&
        row.lease_expires_at &&
        row.lease_expires_at > new Date()
      )
        throw new Error("Step is already leased");
      else if (row.status !== "queued") {
        if (
          (row.status === "running" || row.status === "leased") &&
          row.lease_expires_at &&
          row.lease_expires_at <= new Date()
        ) {
          await client.query(
            `update step_executions set status='retryable_failed',lease_token=null,lease_owner=null,lease_expires_at=null,
            error='{"message":"lease expired"}'::jsonb,updated_at=clock_timestamp() where id=$1`,
            [row.id],
          );
        }
        row = (
          await client.query(
            `insert into step_executions(run_id,step,attempt,status) values($1,$2,$3,'queued') returning id,attempt,status,lease_expires_at`,
            [runId, step, row.attempt + 1],
          )
        ).rows[0]!;
      }
      if (!row) throw new Error("Missing step execution");
      const execution = row;
      const token = randomUUID();
      const claimed = await client.query<{ id: string }>(
        "select id from claim_step_execution($1,$2,$3::interval,$4)",
        [execution.id, owner, `${this.leaseMs} milliseconds`, token],
      );
      if (!claimed.rows[0]) throw new Error("Step is already leased");
      const started = await client.query<{ started: boolean }>(
        "select start_step_execution($1,$2) started",
        [execution.id, token],
      );
      if (!started.rows[0]?.started) throw new Error("Could not start fenced execution");
      if (!replaySucceeded)
        await client.query(
          "update runs set status='running',current_step=$2,block_reason=null,updated_at=clock_timestamp() where id=$1",
          [runId, step],
        );
      logger.info("step.started", { run_id: runId, step, attempt: execution.attempt });
      return { execution_id: execution.id, token };
    });
  }
  /** Fenced lease renewal: extends the lease only while the token still holds it. */
  async heartbeatStep(executionId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `update step_executions set lease_expires_at=clock_timestamp()+($3::text)::interval,updated_at=clock_timestamp()
       where id=$1 and status='running' and lease_token=$2 and lease_expires_at>clock_timestamp()
       returning id`,
      [executionId, token, `${this.leaseMs} milliseconds`],
    );
    return result.rowCount === 1;
  }
  /** Operator stop: revokes in-flight leases so every fenced write bounces and
   *  the synchronous pipeline unwinds without overwriting the cancelled state. */
  async cancelRun(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query<{ status: string }>(
        "select status from runs where id=$1 for update",
        [runId],
      );
      const row = run.rows[0];
      if (!row) throw new NotFoundError("The run was not found.");
      if (!new Set(["queued", "running", "retryable_failed", "waiting", "blocked"]).has(row.status))
        throw new ConflictError("Only an active or operator-paused blog post can be stopped.");
      await client.query(
        `update step_executions set status='cancelled',lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
         where run_id=$1 and status in ('running','leased')`,
        [runId],
      );
      await client.query(
        `update pipeline_queue_jobs set state='cancelled',lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
         where run_id=$1 and state in ('ready','leased','retry_wait','parked','operator_action')`,
        [runId],
      );
      await client.query(
        "update runs set status='cancelled',block_reason=null,updated_at=clock_timestamp() where id=$1",
        [runId],
      );
      logger.warn("run.cancelled", { run_id: runId });
    });
  }
  async completeStep(
    executionId: string,
    token: string,
    preserveRunProgress = false,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = await client.query<{ run_id: string; step: PipelineStepId }>(
        "select run_id,step from step_executions where id=$1 for update",
        [executionId],
      );
      await this.requireFenceClient(
        client,
        "select complete_step_execution($1,$2) changed",
        executionId,
        token,
      );
      const value = row.rows[0];
      if (!value) throw new Error("Unknown execution");
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
      const index = order.indexOf(value.step);
      const next = order[Math.min(index + 1, order.length - 1)]!;
      if (!preserveRunProgress)
        await client.query(
          "update runs set status='running',current_step=$2,block_reason=null,updated_at=clock_timestamp() where id=$1",
          [value.run_id, next],
        );
      logger.info("step.completed", {
        run_id: value.run_id,
        step: value.step,
        next_step: next === value.step ? "(pipeline end)" : next,
      });
    });
  }
  async failStep(
    executionId: string,
    token: string,
    error: string,
    preserveRunProgress = false,
  ): Promise<void> {
    const safeError = this.safeFailureMessage(error);
    await this.transaction(async (client) => {
      const row = await client.query<{ run_id: string; step: PipelineStepId; status: string }>(
        "select run_id,step,status from step_executions where id=$1 for update",
        [executionId],
      );
      // A cancelled run must keep its operator-decided state: the unwinding
      // orchestrator still calls failStep, and that write must no-op instead of
      // flipping the run back to retryable_failed.
      if (row.rows[0]?.status === "cancelled") return;
      await this.requireFenceClient(
        client,
        "select fail_step_execution($1,$2,$3::jsonb) changed",
        executionId,
        token,
        JSON.stringify({ message: safeError }),
      );
      const value = row.rows[0];
      if (!value) throw new Error("Unknown execution");
      if (!preserveRunProgress)
        await client.query(
          "update runs set status='retryable_failed',current_step=$2,block_reason=null,updated_at=clock_timestamp() where id=$1",
          [value.run_id, value.step],
        );
      logger.warn("step.failed", {
        run_id: value.run_id,
        step: value.step,
        ...classifyError(error),
      });
    });
  }
  async saveLinkDiscoveryEvidence(
    runId: string,
    executionId: string,
    token: string,
    metadata: import("../../shared/milestone-two.js").LinkDiscoveryMetadata,
  ): Promise<void> {
    const parsed = LinkDiscoveryMetadataSchema.parse(metadata);
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      if (parsed.cacheWrite) await this.applyLinkDiscoveryCacheWrite(client, parsed);
      const body = JSON.stringify(parsed);
      await client.query(
        `insert into link_discovery_attempts(run_id,step_execution_id,eligibility,reason,source_health,counts,cache_state,identity,metadata,metadata_hash)
         values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10)
         on conflict(step_execution_id) do nothing`,
        [
          runId,
          executionId,
          parsed.eligibility,
          parsed.reason ?? null,
          JSON.stringify(parsed.providerStatus),
          JSON.stringify(parsed.counts),
          parsed.cache.state,
          JSON.stringify(parsed.identity),
          body,
          contentHash(body),
        ],
      );
    });
  }
  private async applyLinkDiscoveryCacheWrite(
    client: PoolClient,
    metadata: import("../../shared/milestone-two.js").LinkDiscoveryMetadata,
  ): Promise<string> {
    const cache = metadata.cacheWrite;
    if (!cache) throw new Error("Missing link discovery cache operation");
    if (
      canonicalHash(cache.payload) !== cache.response_hash ||
      new Date(cache.expires_at).getTime() <= new Date(cache.retrieved_at).getTime() ||
      new Date(cache.expires_at).getTime() - new Date(cache.retrieved_at).getTime() > 86_400_000
    )
      throw new Error("Invalid link discovery cache operation");
    const cached = await client.query<{ id: string; response_hash: string }>(
      `insert into link_discovery_cache(cache_key,request_hash,response_hash,provider,retrieved_at,expires_at,payload)
       values($1,$2,$3,$4,$5,$6,$7::jsonb)
       on conflict(cache_key,request_hash) do update set response_hash=excluded.response_hash,provider=excluded.provider,retrieved_at=excluded.retrieved_at,expires_at=excluded.expires_at,payload=excluded.payload
       where link_discovery_cache.retrieved_at=$8 returning id,response_hash`,
      [
        cache.cache_key,
        cache.request_hash,
        cache.response_hash,
        cache.provider,
        cache.retrieved_at,
        cache.expires_at,
        JSON.stringify(cache.payload),
        cache.observed_retrieved_at,
      ],
    );
    const cacheRow =
      cached.rows[0] ??
      (
        await client.query<{ id: string; response_hash: string }>(
          `select id,response_hash from link_discovery_cache where cache_key=$1 and request_hash=$2`,
          [cache.cache_key, cache.request_hash],
        )
      ).rows[0];
    if (
      !cacheRow ||
      cacheRow.response_hash !== cache.response_hash ||
      (metadata.cacheId && metadata.cacheId !== cacheRow.id)
    )
      throw new Error("Link discovery cache fence changed before run persistence");
    return cacheRow.id;
  }

  async getHandoff(runId: string): Promise<Handoff> {
    const r = await this.pool.query<{ handoff: Handoff }>("select handoff from runs where id=$1", [
      runId,
    ]);
    return HandoffSchema.parse(r.rows[0]?.handoff);
  }
  async getLinks(runId: string): Promise<InternalLink[] | null> {
    return (await this.getLinksArtifact(runId))?.body ?? null;
  }
  async getLinksArtifact(runId: string) {
    const r = await this.pool.query<{
      id: string;
      body_text: string;
      metadata_id: string | null;
      metadata_body: string | null;
    }>(
      `select a.id,a.body_text,m.id metadata_id,m.body_text metadata_body
       from artifacts a left join artifacts m on m.run_id=a.run_id
         and m.kind='internal_link_discovery_metadata'
       where a.run_id=$1 and a.kind='internal_links' order by a.created_at limit 1`,
      [runId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const body = InternalLinkSchema.array().parse(JSON.parse(row.body_text));
    const metadata = row.metadata_body
      ? LinkDiscoveryMetadataSchema.parse(JSON.parse(row.metadata_body))
      : null;
    return InternalLinksArtifactSnapshotSchema.parse({
      artifact_id: row.id,
      content_hash: contentHash(row.body_text),
      body_text: row.body_text,
      body,
      metadata_artifact_id: row.metadata_id,
      metadata_content_hash: row.metadata_body ? contentHash(row.metadata_body) : null,
      metadata_body_text: row.metadata_body,
      metadata,
    });
  }
  async saveLinks(
    runId: string,
    executionId: string,
    token: string,
    links: InternalLink[],
    metadata?: import("../../shared/milestone-two.js").LinkDiscoveryMetadataInput,
  ): Promise<void> {
    const parsedMetadata = metadata ? LinkDiscoveryMetadataSchema.parse(metadata) : undefined;
    const parsedLinks = parsedMetadata?.cacheWrite
      ? links.map((link) => LiveInternalLinkSchema.parse(link))
      : InternalLinkSchema.array().parse(links);
    const body = JSON.stringify(parsedLinks),
      hash = contentHash(body),
      identity = canonicalHash(parsedLinks);
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      let cacheId = parsedMetadata?.cacheId;
      if (parsedMetadata?.cacheWrite)
        cacheId = await this.applyLinkDiscoveryCacheWrite(client, parsedMetadata);
      if (parsedMetadata) {
        const evidenceBody = JSON.stringify(parsedMetadata);
        await client.query(
          `insert into link_discovery_attempts(run_id,step_execution_id,eligibility,reason,source_health,counts,cache_state,identity,metadata,metadata_hash)
           values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10)
           on conflict(step_execution_id) do nothing`,
          [
            runId,
            executionId,
            parsedMetadata.eligibility,
            parsedMetadata.reason ?? null,
            JSON.stringify(parsedMetadata.providerStatus),
            JSON.stringify(parsedMetadata.counts),
            parsedMetadata.cache.state,
            JSON.stringify(parsedMetadata.identity),
            evidenceBody,
            contentHash(evidenceBody),
          ],
        );
      }
      const existing = await client.query<{ body_text: string }>(
        "select body_text from artifacts where run_id=$1 and kind='internal_links' limit 1",
        [runId],
      );
      if (existing.rows[0]) {
        if (
          canonicalHash(
            InternalLinkSchema.array().parse(JSON.parse(existing.rows[0].body_text)),
          ) !== identity
        )
          throw new Error("Immutable link discovery conflict");
        return;
      }
      await client.query(
        `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,'internal_links','application/json',$3,$4,$5)`,
        [runId, executionId, body, hash, Buffer.byteLength(body)],
      );
      const persistedMetadata = parsedMetadata
        ? { ...parsedMetadata, ...(cacheId ? { cacheId } : {}) }
        : undefined;
      if (persistedMetadata) {
        const metadataBody = JSON.stringify(persistedMetadata);
        await client.query(
          `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
           values($1,$2,'internal_link_discovery_metadata','application/json',$3,$4,$5)`,
          [
            runId,
            executionId,
            metadataBody,
            contentHash(metadataBody),
            Buffer.byteLength(metadataBody),
          ],
        );
      }
      for (const [index, link] of parsedLinks.entries()) {
        if (parsedMetadata?.cacheWrite) LiveInternalLinkSchema.parse(link);
        if (!link.status || !link.hierarchy || !link.verified_at || !link.source) continue;
        await client.query(
          `insert into link_candidates(run_id,cache_id,target_url,title,primary_topic,source,hierarchy,rank,http_status,verified_at,provenance)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            runId,
            cacheId ?? null,
            link.url,
            link.title,
            link.primary_topic ?? null,
            link.source,
            link.hierarchy,
            index + 1,
            link.status,
            link.verified_at,
            JSON.stringify(linkCandidateProvenance(link, persistedMetadata)),
          ],
        );
      }
    });
  }
  async getDraft(runId: string) {
    const r = await this.pool.query<{
      artifact_id: string;
      artifact_parent_id: string | null;
      version_id: string;
      version_parent_id: string | null;
      revision: number;
      content_hash: string;
      artifact_content_hash: string;
      kind: string;
      media_type: string;
      body_text: string;
      step_execution_id: string;
    }>(
      `select a.id artifact_id,a.parent_id artifact_parent_id,a.kind,a.media_type,a.body_text,a.content_hash artifact_content_hash,a.step_execution_id,d.id version_id,d.parent_id version_parent_id,d.revision,d.content_hash
       from document_versions d join artifacts a on a.id=d.artifact_id where d.run_id=$1 order by d.revision desc limit 1`,
      [runId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const stored = readStoredStructuredDraft(JSON.parse(row.body_text));
    return {
      draft: stored.draft,
      legacy_derived_fields: stored.legacy_derived_fields,
      artifact: ArtifactSchema.parse({
        id: row.artifact_id,
        run_id: runId,
        step_execution_id: row.step_execution_id,
        parent_id: row.artifact_parent_id,
        kind: row.kind,
        media_type: row.media_type,
        body_text: row.body_text,
        content_hash: row.artifact_content_hash,
      }),
      version: DocumentVersionSchema.parse({
        id: row.version_id,
        run_id: runId,
        artifact_id: row.artifact_id,
        parent_id: row.version_parent_id,
        revision: row.revision,
        content_hash: row.content_hash,
      }),
    };
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
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      if (input.purpose === "legacy_operator_recovery" && !input.operator_authorised)
        throw new Error("Legacy draft recovery requires explicit operator authorisation");
      if (input.purpose === "initial" && input.operator_authorised)
        throw new Error("Initial draft operation cannot carry recovery authorisation");
      const history = await client.query<{ failed: boolean; operations: number }>(
        `select exists(select 1 from step_executions where run_id=$1 and step='draft' and status='retryable_failed') failed,
                (select count(*)::int from draft_operation_states where run_id=$1) operations`,
        [input.run_id],
      );
      const priorDraftFailure = history.rows[0]?.failed === true;
      const operationCount = history.rows[0]?.operations ?? 0;
      const ambiguous = await client.query(
        "select 1 from draft_operation_states where run_id=$1 and status='provider_in_flight' and response is null limit 1",
        [input.run_id],
      );
      if (ambiguous.rowCount)
        throw new Error(
          "Draft provider outcome is ambiguous; no duplicate call was made. A technical owner must authorise a new recovery operation.",
        );
      if (
        input.purpose === "legacy_operator_recovery" &&
        (!priorDraftFailure || operationCount > 0)
      )
        throw new Error("Legacy draft recovery is not eligible for this run");
      if (input.purpose === "initial" && priorDraftFailure && operationCount === 0)
        throw new Error("A pre-checkpoint draft failure requires explicit operator authorisation");
      const identity = deriveDraftOperationIdentity(input);
      const existing = await client.query<{
        run_id: string;
        request_hash: string;
        provider: string;
        model: string;
        contract_identity: string;
        purpose: DraftOperationIdentity["purpose"];
        response: unknown;
        response_hash: string | null;
        status: string;
      }>(
        `select run_id,request_hash,provider,model,contract_identity,purpose,response,response_hash,status
         from draft_operation_states where operation_id=$1 and run_id=$2 for update`,
        [identity.operation_id, input.run_id],
      );
      const row = existing.rows[0];
      if (row) {
        if (
          row.request_hash !== identity.request_hash ||
          row.provider !== identity.provider ||
          row.model !== identity.model ||
          row.contract_identity !== identity.contract_identity ||
          row.purpose !== identity.purpose
        )
          throw new Error("Immutable draft operation conflict");
        if (!row.response) {
          if (row.status === "provider_in_flight")
            throw new Error(
              "Draft provider outcome is ambiguous; no duplicate call was made. A technical owner must authorise a new recovery operation.",
            );
          return { identity, response: null };
        }
        const response = DraftProviderResponseSchema.parse(row.response);
        if (row.response_hash !== canonicalHash(response))
          throw new Error("Draft checkpoint hash mismatch");
        return { identity, response };
      }
      await client.query(
        `insert into draft_operation_states(operation_id,run_id,producing_step_execution_id,request_hash,provider,model,contract_identity,purpose,operator_authorised)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          identity.operation_id,
          input.run_id,
          input.execution_id,
          identity.request_hash,
          identity.provider,
          identity.model,
          identity.contract_identity,
          identity.purpose,
          input.operator_authorised,
        ],
      );
      return { identity, response: null };
    });
  }
  private async assertDraftCommand(client: PoolClient, input: DraftOperationCommand) {
    await this.assertFence(client, input.run_id, input.execution_id, input.token);
    if (input.identity.run_id !== input.run_id)
      throw new Error("Draft operation cannot cross runs");
    const row = await client.query(
      `select 1 from draft_operation_states where operation_id=$1 and run_id=$2 and request_hash=$3
       and provider=$4 and model=$5 and contract_identity=$6 and purpose=$7 for update`,
      [
        input.identity.operation_id,
        input.run_id,
        input.identity.request_hash,
        input.identity.provider,
        input.identity.model,
        input.identity.contract_identity,
        input.identity.purpose,
      ],
    );
    if (row.rowCount !== 1) throw new Error("Draft operation identity mismatch");
  }
  async markDraftProviderInFlight(input: DraftOperationCommand): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertDraftCommand(client, input);
      const changed = await client.query(
        `update draft_operation_states set status='provider_in_flight',release_reason=null,
           ambiguity_reason='provider_in_flight_without_checkpoint'
         where operation_id=$1 and run_id=$2 and status='started' and response is null`,
        [input.identity.operation_id, input.run_id],
      );
      if (changed.rowCount !== 1) throw new Error("Draft operation cannot start a provider call");
    });
  }
  async releaseDraftProviderFailure(
    input: DraftOperationCommand & {
      reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertDraftCommand(client, input);
      const changed = await client.query(
        `update draft_operation_states set status='started',ambiguity_reason=null,
           release_reason=$3
         where operation_id=$1 and run_id=$2 and status='provider_in_flight' and response is null`,
        [input.identity.operation_id, input.run_id, input.reason],
      );
      if (changed.rowCount !== 1)
        throw new Error("Draft operation has no releasable provider reservation");
    });
  }
  async checkpointDraftResponse(
    input: DraftOperationCommand & { response: DraftProviderResponse },
  ): Promise<void> {
    const response = DraftProviderResponseSchema.parse(input.response);
    const responseHash = canonicalHash(response);
    await this.transaction(async (client) => {
      await this.assertDraftCommand(client, input);
      const changed = await client.query(
        `update draft_operation_states
         set response=$2::jsonb,response_hash=$3,status='checkpointed',ambiguity_reason=null,checkpointed_at=clock_timestamp()
         where operation_id=$1 and run_id=$4 and status='provider_in_flight' and response is null`,
        [input.identity.operation_id, JSON.stringify(response), responseHash, input.run_id],
      );
      if (changed.rowCount !== 1) {
        const existing = await client.query<{ response_hash: string | null }>(
          "select response_hash from draft_operation_states where operation_id=$1 and run_id=$2",
          [input.identity.operation_id, input.run_id],
        );
        if (existing.rows[0]?.response_hash !== responseHash)
          throw new Error("Immutable draft checkpoint conflict");
      }
    });
  }
  async saveDraft(
    runId: string,
    executionId: string,
    token: string,
    response: DraftProviderResponse,
    operation: DraftOperationIdentity,
  ) {
    const parsed = DraftProviderResponseSchema.parse(response);
    await this.transaction(async (client) => {
      await client.query("select id from runs where id=$1 for update", [runId]);
      await this.assertFence(client, runId, executionId, token);
      if (operation.run_id !== runId) throw new Error("Draft operation cannot cross runs");
      const checkpoint = await client.query<{ response_hash: string | null; status: string }>(
        `select response_hash,status from draft_operation_states where operation_id=$1 and run_id=$2
         and request_hash=$3 and provider=$4 and model=$5 and contract_identity=$6 and purpose=$7`,
        [
          operation.operation_id,
          runId,
          operation.request_hash,
          operation.provider,
          operation.model,
          operation.contract_identity,
          operation.purpose,
        ],
      );
      if (
        checkpoint.rows[0]?.status !== "checkpointed" ||
        checkpoint.rows[0].response_hash !== canonicalHash(parsed)
      )
        throw new Error("Draft persistence requires its exact validated provider checkpoint");
      const parsedProvider = operation.provider;
      const parsedModel = operation.model;
      const existing = await client.query<{ body_text: string }>(
        `select a.body_text from document_versions d join artifacts a on a.id=d.artifact_id where d.run_id=$1 and d.revision=1`,
        [runId],
      );
      const identity = canonicalHash(parsed.draft);
      if (existing.rows[0]) {
        if (
          canonicalHash(readStoredStructuredDraft(JSON.parse(existing.rows[0].body_text)).draft) !==
          identity
        )
          throw new Error("Immutable draft conflict");
        return;
      }
      const body = JSON.stringify(parsed.draft),
        hash = contentHash(body),
        artifactId = randomUUID();
      await client.query(
        `insert into artifacts(id,run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,$3,'draft','application/json',$4,$5,$6)`,
        [artifactId, runId, executionId, body, hash, Buffer.byteLength(body)],
      );
      await client.query(
        "insert into document_versions(run_id,artifact_id,revision,content_hash) values($1,$2,1,$3)",
        [runId, artifactId, hash],
      );
      const requestBody = JSON.stringify(operation);
      const requestHash = contentHash(requestBody);
      await client.query(
        `insert into artifacts(id,run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,$3,'draft_request','application/json',$4,$5,$6)`,
        [
          randomUUID(),
          runId,
          executionId,
          requestBody,
          requestHash,
          Buffer.byteLength(requestBody),
        ],
      );
      await client.query(
        `insert into provider_usage(run_id,step_execution_id,provider,model,operation,request_id,input_units,output_units,cost_micros,latency_ms) values($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)`,
        [
          runId,
          executionId,
          parsedProvider,
          parsedModel,
          parsed.request_id,
          parsed.usage.input_units,
          parsed.usage.output_units,
          parsed.usage.cost_micros,
          parsed.usage.latency_ms ?? null,
        ],
      );
    });
    const saved = await this.getDraft(runId);
    if (!saved) throw new Error("Draft transaction produced no document");
    return saved;
  }
  async snapshotReferences(
    runId: string,
    executionId: string,
    token: string,
  ): Promise<ReferenceSnapshot[]> {
    return this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      const existing = await client.query<{
        kind: string;
        version_id: string;
        content_hash: string;
        immutable_pointer: string;
        content: string;
      }>(
        `select d.kind,v.id version_id,s.content_hash,
         'postgres://reference_versions/' || v.id immutable_pointer,v.body_markdown content
         from step_reference_snapshots s
         join reference_documents d on d.id=s.reference_document_id
         join reference_versions v on v.id=s.reference_version_id
         where s.step_execution_id=$1 order by d.kind`,
        [executionId],
      );
      if (existing.rows.length) return existing.rows;
      const expected = await client.query<{
        reference_document_id: string;
        kind: string;
        version_id: string | null;
        content_hash: string | null;
        content: string | null;
      }>(
        `select d.id reference_document_id,d.kind,a.reference_version_id version_id,v.content_hash,v.body_markdown content
         from step_executions e join substep_reference_map m on m.step=e.step
         join reference_documents d on d.id=m.reference_document_id
         left join reference_activations a on a.reference_document_id=d.id
           and (
             a.provisional_local
             or exists(select 1 from reference_approval_attestations aa where aa.reference_version_id=a.reference_version_id)
           )
         left join reference_versions v on v.id=a.reference_version_id
         where e.id=$1 order by d.kind`,
        [executionId],
      );
      const missing = expected.rows.filter((row) => !row.version_id || !row.content_hash);
      if (missing.length)
        throw new Error(
          `Mapped references have no active version: ${missing.map((row) => row.kind).join(", ")}`,
        );
      for (const row of expected.rows)
        await client.query(
          `insert into step_reference_snapshots(step_execution_id,reference_document_id,reference_version_id,content_hash)
         values($1,$2,$3,$4) on conflict(step_execution_id,reference_document_id) do nothing`,
          [executionId, row.reference_document_id, row.version_id, row.content_hash],
        );
      return expected.rows.map((row) => ({
        kind: row.kind,
        version_id: row.version_id!,
        content_hash: row.content_hash!,
        immutable_pointer: `postgres://reference_versions/${row.version_id!}`,
        content: row.content!,
      }));
    });
  }

  async hasStepOutput(
    runId: string,
    documentVersionId: string,
    step: PipelineStepId,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from step_outputs where run_id=$1 and document_version_id=$2 and step=$3",
      [runId, documentVersionId, step],
    );
    return result.rowCount === 1;
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
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const existing = await client.query<{ manifest_hash: string }>(
        "select manifest_hash from deterministic_manifests where run_id=$1",
        [input.run_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].manifest_hash !== manifest.manifest_hash)
          throw new Error("Immutable deterministic baseline conflict");
        return;
      }
      await this.insertFindingsClient(
        client,
        input.run_id,
        input.document_version_id,
        input.execution_id,
        input.findings,
      );
      await client.query(
        `insert into deterministic_manifests(run_id,document_version_id,step_execution_id,manifest_hash,manifest,result_hash,result) values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [
          input.run_id,
          input.document_version_id,
          input.execution_id,
          manifest.manifest_hash,
          JSON.stringify(manifest),
          result.result_hash,
          JSON.stringify(result),
        ],
      );
      await client.query(
        "insert into step_outputs(run_id,document_version_id,step,step_execution_id,content_hash) values($1,$2,'automated_checks',$3,$4)",
        [input.run_id, input.document_version_id, input.execution_id, result.result_hash],
      );
      await this.completeOutputStepClient(
        client,
        input.run_id,
        input.execution_id,
        input.token,
        "automated_checks",
      );
    });
  }

  async getDeterministicManifest(runId: string) {
    const row = (
      await this.pool.query<{ manifest: unknown; result: unknown }>(
        "select manifest,result from deterministic_manifests where run_id=$1",
        [runId],
      )
    ).rows[0];
    if (!row) throw new Error("Step 1.4 deterministic manifest is missing");
    // The Step 1.11 validators own parsing so malformed persisted JSON is
    // normalised to DeterministicManifestMismatchError rather than leaking ZodError.
    return {
      manifest: row.manifest as DeterministicManifest,
      result: row.result as DeterministicRunResult,
    };
  }

  async saveFindings(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    raw: Array<ReviewFinding & { hard_flag: boolean }>,
    /** When false the producing attempt stays open, so the same lease may park the wait. */
    complete = true,
  ): Promise<void> {
    const values = raw.map((item) => PersistedReviewFindingSchema.parse(item));
    await this.transaction((client) =>
      this.saveFindingsClient(
        client,
        runId,
        documentVersionId,
        executionId,
        token,
        values,
        canonicalHash(values),
        complete,
      ),
    );
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
    const request = ReviewRequestSchema.parse(input.request);
    const requestHash = canonicalHash(request);
    const provider = this.requireNonEmpty(input.provider, "provider");
    const model = this.requireNonEmpty(input.model, "model");
    const operationId = stableId(
      "review-operation",
      input.run_id,
      input.document_version_id,
      input.step,
      requestHash,
      provider,
      model,
    );
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const existing = await client.query<{
        run_id: string;
        document_version_id: string;
        producing_step_execution_id: string;
        step: string;
        request_hash: string;
        provider: string;
        model: string;
        status: string;
        response: unknown;
        response_hash: string | null;
      }>("select * from review_operation_states where operation_id=$1 for update", [operationId]);
      const row = existing.rows[0];
      if (row) {
        if (
          row.run_id !== input.run_id ||
          row.document_version_id !== input.document_version_id ||
          row.step !== input.step ||
          row.request_hash !== requestHash ||
          row.provider !== provider ||
          row.model !== model
        )
          throw new Error("Immutable review operation conflict");
        if (row.status === "provider_in_flight")
          throw new Error("Review provider outcome is ambiguous; operator action is required");
        if (row.status === "checkpointed") {
          const response = PersistedReviewResponseSchema.parse(row.response);
          if (row.response_hash !== canonicalHash(response))
            throw new Error("Review checkpoint hash mismatch");
          return { operation_id: operationId, response };
        }
        if (row.producing_step_execution_id !== input.execution_id) {
          const ownership = await client.query<{
            previous_status: string;
            previous_lease_token: string | null;
            previous_lease_owner: string | null;
            previous_lease_expires_at: Date | null;
            previous_attempt: number;
            current_status: string;
            current_attempt: number;
            current_step: string;
          }>(
            `select previous.status previous_status,previous.lease_token previous_lease_token,
                    previous.lease_owner previous_lease_owner,previous.lease_expires_at previous_lease_expires_at,
                    previous.attempt previous_attempt,current.status current_status,
                    current.attempt current_attempt,current.step current_step
               from step_executions previous,step_executions current
              where previous.id=$1 and previous.run_id=$2 and previous.step=$3
                and current.id=$4 and current.run_id=$2 and current.step=$3`,
            [row.producing_step_execution_id, input.run_id, input.step, input.execution_id],
          );
          const owner = ownership.rows[0];
          if (
            !owner ||
            owner.previous_status !== "retryable_failed" ||
            owner.previous_lease_token !== null ||
            owner.previous_lease_owner !== null ||
            owner.previous_lease_expires_at !== null ||
            owner.current_status !== "running" ||
            owner.previous_attempt >= owner.current_attempt
          )
            throw new Error("Started review operation cannot be adopted by this attempt");
          await client.query(
            `insert into review_operation_adoptions(operation_id,run_id,from_step_execution_id,to_step_execution_id)
             values($1,$2,$3,$4)`,
            [operationId, input.run_id, row.producing_step_execution_id, input.execution_id],
          );
          const adopted = await client.query(
            `update review_operation_states set producing_step_execution_id=$3
              where operation_id=$1 and run_id=$2 and status='started' and producing_step_execution_id=$4`,
            [operationId, input.run_id, input.execution_id, row.producing_step_execution_id],
          );
          if (adopted.rowCount !== 1) throw new Error("Review operation adoption conflict");
        }
        return { operation_id: operationId, response: null };
      }
      await client.query(
        `insert into review_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,step,request_hash,provider,model)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          operationId,
          input.run_id,
          input.document_version_id,
          input.execution_id,
          input.step,
          requestHash,
          provider,
          model,
        ],
      );
      return { operation_id: operationId, response: null };
    });
  }

  async markReviewProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        "update review_operation_states set status='provider_in_flight',release_reason=null,ambiguity_reason='provider_in_flight_without_checkpoint' where operation_id=$1 and run_id=$2 and status='started' and producing_step_execution_id=$3",
        [input.operation_id, input.run_id, input.execution_id],
      );
      if (changed.rowCount !== 1) throw new Error("Review operation is not ready for dispatch");
    });
  }

  async releaseReviewProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        `update review_operation_states set status='started',release_reason=$1,ambiguity_reason=null
         where operation_id=$2 and run_id=$3 and producing_step_execution_id=$4
           and status='provider_in_flight' and response is null`,
        [input.reason, input.operation_id, input.run_id, input.execution_id],
      );
      if (changed.rowCount !== 1)
        throw new Error("Review operation has no releasable provider reservation");
    });
  }

  async checkpointReviewResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: PersistedReviewResponse;
  }): Promise<void> {
    const response = PersistedReviewResponseSchema.parse(input.response);
    const hash = canonicalHash(response);
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        `update review_operation_states set status='checkpointed',response=$2::jsonb,response_hash=$3,ambiguity_reason=null,checkpointed_at=clock_timestamp()
         where operation_id=$1 and run_id=$4 and status='provider_in_flight' and producing_step_execution_id=$5`,
        [input.operation_id, JSON.stringify(response), hash, input.run_id, input.execution_id],
      );
      if (changed.rowCount === 1) return;
      const existing = await client.query<{
        status: string;
        response_hash: string | null;
        producing_step_execution_id: string;
      }>(
        "select status,response_hash,producing_step_execution_id from review_operation_states where operation_id=$1",
        [input.operation_id],
      );
      if (
        existing.rows[0]?.status !== "checkpointed" ||
        existing.rows[0].response_hash !== hash ||
        existing.rows[0].producing_step_execution_id !== input.execution_id
      )
        throw new Error("Immutable review checkpoint conflict");
    });
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
    const request = ReviewRequestSchema.parse(rawRequest),
      response = PersistedReviewResponseSchema.parse(rawResponse),
      checkpointResponse = rawCheckpointResponse
        ? PersistedReviewResponseSchema.parse(rawCheckpointResponse)
        : response;
    const parsedProvider = this.requireNonEmpty(provider, "provider"),
      parsedModel = this.requireNonEmpty(model, "model");
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      const operationId = stableId(
        "review-operation",
        runId,
        documentVersionId,
        step,
        canonicalHash(request),
        parsedProvider,
        parsedModel,
      );
      const checkpoint = await client.query<{ status: string; response_hash: string | null }>(
        "select status,response_hash from review_operation_states where operation_id=$1 and run_id=$2",
        [operationId, runId],
      );
      const identity = canonicalHash(response);
      if (
        checkpoint.rows[0]?.status !== "checkpointed" ||
        checkpoint.rows[0].response_hash !== canonicalHash(checkpointResponse)
      )
        throw new Error("Review persistence requires its exact validated provider checkpoint");
      const existing = await client.query<{ content_hash: string }>(
        "select content_hash from step_outputs where run_id=$1 and document_version_id=$2 and step=$3",
        [runId, documentVersionId, step],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].content_hash !== identity)
          throw new Error("Immutable review conflict");
        return;
      }
      const findings = response.findings.map((finding) => ({
        ...finding,
        stable_key: `${step}:${finding.stable_key}`,
      }));
      await this.insertFindingsClient(client, runId, documentVersionId, executionId, findings);
      for (const [kind, value] of [
        ["review_request", request],
        ["review_response", response],
      ] as const) {
        const body = JSON.stringify(value);
        await client.query(
          `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,$3,'application/json',$4,$5,$6)`,
          [runId, executionId, kind, body, contentHash(body), Buffer.byteLength(body)],
        );
      }
      await client.query(
        `insert into provider_usage(run_id,step_execution_id,provider,model,operation,request_id,input_units,output_units,cost_micros,latency_ms) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          runId,
          executionId,
          parsedProvider,
          parsedModel,
          step,
          response.request_id,
          response.usage.input_units,
          response.usage.output_units,
          response.usage.cost_micros,
          response.usage.latency_ms ?? null,
        ],
      );
      const sourceIds = new Map<string, string>(),
        pendingSources = new Map<
          string,
          {
            source_type: string;
            title: string | null;
            retrieved_at: string;
            content_hash: string;
            snapshot: Record<string, unknown>;
            evidence: readonly string[];
          }
        >();
      for (const source of response.sources) {
        const id = randomUUID(),
          snapshot = JSON.stringify(source.snapshot),
          hash = contentHash(snapshot),
          immutableKey = `${source.uri}:${hash}`,
          pending = pendingSources.get(immutableKey);
        if (pending) assertImmutableSourceMatches(pending, source, hash);
        else
          pendingSources.set(immutableKey, {
            source_type: source.source_type,
            title: source.title,
            retrieved_at: source.retrieved_at,
            content_hash: hash,
            snapshot: source.snapshot,
            evidence: [source.evidence],
          });
        const inserted = await client.query<{ id: string }>(
          `insert into sources(id,run_id,source_type,uri,title,retrieved_at,content_hash,snapshot)
           values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           on conflict(run_id,uri,content_hash) do nothing returning id`,
          [
            id,
            runId,
            source.source_type,
            source.uri,
            source.title,
            source.retrieved_at,
            hash,
            snapshot,
          ],
        );
        let sourceId = inserted.rows[0]?.id;
        if (!sourceId) {
          const resolved = (
            await client.query<{
              id: string;
              source_type: string;
              title: string | null;
              retrieved_at: Date;
              content_hash: string;
              snapshot: Record<string, unknown>;
              evidence: string[];
            }>(
              `select s.id,s.source_type,s.title,s.retrieved_at,s.content_hash,s.snapshot,
                 coalesce(array_agg(distinct cs.evidence) filter(where cs.evidence is not null),'{}') evidence
               from sources s left join claim_sources cs on cs.run_id=s.run_id and cs.source_id=s.id
               where s.run_id=$1 and s.uri=$2 and s.content_hash=$3
               group by s.id`,
              [runId, source.uri, hash],
            )
          ).rows[0];
          if (!resolved) throw new Error("Immutable source could not be resolved");
          assertImmutableSourceMatches(
            resolved.evidence.length
              ? resolved
              : (({ evidence: _evidence, ...row }) => row)(resolved),
            source,
            hash,
          );
          sourceId = resolved.id;
        }
        sourceIds.set(source.stable_key, sourceId);
      }
      for (const claim of response.claims) {
        const source = response.sources.find((item) => item.stable_key === claim.source_key),
          sourceId = sourceIds.get(claim.source_key);
        if (!source || !sourceId) throw new Error("Claim source is missing");
        const claimId = randomUUID();
        await client.query(
          `insert into claims(id,run_id,document_version_id,claim_text,claim_hash,type,status,location,hard_flag) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            claimId,
            runId,
            documentVersionId,
            claim.claim_text,
            canonicalHash({ text: claim.claim_text, location: claim.location }),
            claim.type,
            claim.status,
            JSON.stringify(claim.location),
            claim.hard_flag,
          ],
        );
        await client.query(
          `insert into claim_sources(run_id,claim_id,source_id,status,evidence_location,evidence) values($1,$2,$3,$4,$5,$6)`,
          [runId, claimId, sourceId, claim.status, source.uri, source.evidence],
        );
      }
      await client.query(
        "insert into step_outputs(run_id,document_version_id,step,step_execution_id,content_hash) values($1,$2,$3,$4,$5)",
        [runId, documentVersionId, step, executionId, identity],
      );
      await this.completeOutputStepClient(client, runId, executionId, token, step);
    });
  }

  async waitForFindings(runId: string, executionId: string, token: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      const current = await client.query<{ document_version_id: string }>(
        `select id document_version_id from document_versions where run_id=$1 order by revision desc limit 1`,
        [runId],
      );
      const review = current.rows[0];
      if (!review) throw new UnprocessableError("The current document version is unavailable.");
      const members = await client.query<{ id: string }>(
        `select f.id from findings f join step_executions pe on pe.id=f.step_execution_id
         where f.run_id=$1 and f.document_version_id=$2
           and pe.step in ('automated_checks','review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
         order by case f.severity when 'blocker' then 0 when 'warning' then 1 else 2 end,
           array_position(enum_range(null::pipeline_step),pe.step),f.stable_key`,
        [runId, review.document_version_id],
      );
      const reviewSetId = randomUUID();
      await client.query(
        `insert into finding_review_sets(id,run_id,document_version_id,findings_step_execution_id,membership_hash,finding_count)
         values($1,$2,$3,$4,$5,$6)`,
        [
          reviewSetId,
          runId,
          review.document_version_id,
          executionId,
          canonicalHash(members.rows.map((row) => row.id)),
          members.rows.length,
        ],
      );
      for (const [ordinal, member] of members.rows.entries())
        await client.query(
          `insert into finding_review_set_members(review_set_id,finding_id,ordinal) values($1,$2,$3)`,
          [reviewSetId, member.id, ordinal],
        );
      if (members.rows.length === 0) {
        await this.requireFenceClient(
          client,
          "select complete_step_execution($1,$2) changed",
          executionId,
          token,
        );
        await client.query(
          `insert into finding_review_submissions(review_set_id,run_id,idempotency_key,payload_hash,finding_count,decision_count)
           values($1,$2,$3,$4,0,0)`,
          [
            reviewSetId,
            runId,
            `automatic:${executionId}`,
            canonicalHash({ document_version_id: review.document_version_id, dispositions: [] }),
          ],
        );
        await client.query(
          "update runs set status='running',current_step='revision_pass',block_reason=null,updated_at=clock_timestamp() where id=$1",
          [runId],
        );
        return;
      }
      const changed = await client.query(
        `update step_executions set status='waiting',lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=$1 and lease_token=$2 returning id`,
        [executionId, token],
      );
      if (!changed.rows[0]) throw new Error("Stale fencing token");
      await client.query(
        "update runs set status='waiting',current_step='findings_review',block_reason=null,updated_at=clock_timestamp() where id=$1",
        [runId],
      );
    });
  }

  /**
   * Opens a controlled editorial-correction review round for the SAME immutable
   * document version. Atomic and idempotent: the run row is locked for the whole
   * transaction, every fence is checked before any write, and a replay returns
   * the existing round rather than creating a second one.
   *
   * Prior rounds are never mutated or deleted; the new round simply becomes the
   * highest, which is what listFindings treats as active.
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
    return this.transaction(async (client) => {
      const run = (
        await client.query<{ status: string }>("select status from runs where id=$1 for update", [
          input.run_id,
        ])
      ).rows[0];
      if (!run) throw new NotFoundError("The run was not found.");
      if (run.status === "cancelled" || run.status === "succeeded")
        throw new ConflictError("A finished run cannot open an editorial correction.");

      // The correction must target the run's current immutable version, byte for
      // byte. A newer child version means a correction already progressed.
      const current = (
        await client.query<{ id: string; content_hash: string }>(
          "select id,content_hash from document_versions where run_id=$1 order by revision desc limit 1",
          [input.run_id],
        )
      ).rows[0];
      if (!current) throw new UnprocessableError("The current document version is unavailable.");
      if (current.id !== input.document_version_id)
        throw new ConflictError("The correction source is no longer the current document version.");
      if (current.content_hash !== input.expected_content_hash)
        throw new ConflictError("The correction source content hash changed.");
      logger.info("correction.source_fence_checked", {
        run_id: input.run_id,
        correction_source_version_id: input.document_version_id,
        source_is_current: true,
        content_hash_matches: true,
      });

      const active = (
        await client.query<{ id: string; round: number; membership_hash: string }>(
          "select id,round,membership_hash from finding_review_sets where run_id=$1 order by round desc limit 1",
          [input.run_id],
        )
      ).rows[0];
      if (!active)
        throw new ConflictError("The first findings review round has not been frozen yet.");
      logger.info("correction.active_round_resolved", {
        run_id: input.run_id,
        active_round: active.round,
      });
      // Replay before the waiting-round guard: an already-open correction round
      // is itself waiting, so checking the guard first would reject its own
      // idempotent re-open.
      if (active.round > 1 && active.membership_hash === membershipKeys)
        return { status: "replayed" as const, review_set_id: active.id, round: active.round };

      // Two waiting rounds would leave two open operator queues and disposition
      // submission would have to choose between them. Fail closed with no write.
      const waiting = (
        await client.query<{ count: number }>(
          `select count(*)::int count from step_executions
           where run_id=$1 and step='findings_review' and status='waiting'`,
          [input.run_id],
        )
      ).rows[0]!.count;
      logger.info("correction.waiting_execution_checked", {
        run_id: input.run_id,
        waiting_findings_review_count: waiting,
      });
      if (waiting > 0)
        throw new ConflictError(
          "A findings review round is already awaiting decisions; decide it before opening an editorial correction.",
        );

      const round = active.round + 1;
      const attempt = (
        await client.query<{ next: number }>(
          "select coalesce(max(attempt),0)+1 next from step_executions where run_id=$1 and step='findings_review'",
          [input.run_id],
        )
      ).rows[0]!.next;
      const executionId = (
        await client.query<{ id: string }>(
          `insert into step_executions(run_id,step,attempt,status,started_at)
           values($1,'findings_review',$2,'waiting',clock_timestamp()) returning id`,
          [input.run_id, attempt],
        )
      ).rows[0]!.id;

      await this.insertFindingsClient(
        client,
        input.run_id,
        input.document_version_id,
        executionId,
        findings,
      );
      const memberIds = (
        await client.query<{ id: string }>(
          `select id from findings where run_id=$1 and step_execution_id=$2 order by stable_key`,
          [input.run_id, executionId],
        )
      ).rows.map((row) => row.id);
      const reviewSetId = randomUUID();
      await client.query(
        `insert into finding_review_sets(id,run_id,document_version_id,findings_step_execution_id,membership_hash,finding_count,round)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [
          reviewSetId,
          input.run_id,
          input.document_version_id,
          executionId,
          membershipKeys,
          memberIds.length,
          round,
        ],
      );
      for (const [ordinal, id] of memberIds.entries())
        await client.query(
          "insert into finding_review_set_members(review_set_id,finding_id,ordinal) values($1,$2,$3)",
          [reviewSetId, id, ordinal],
        );
      // A controlled reopening: the run returns to the ordinary operator wait.
      await client.query(
        "update runs set status='waiting',current_step='findings_review',block_reason=null,updated_at=clock_timestamp() where id=$1",
        [input.run_id],
      );
      logger.info("editorial_correction.round_opened", {
        run_id: input.run_id,
        round,
        finding_count: memberIds.length,
        checker_version: input.checker_version,
        source_round: active.round,
      });
      return { status: "opened" as const, review_set_id: reviewSetId, round };
    });
  }

  async listFindings(runId: string, rawFilters: unknown): Promise<FindingRecord[]> {
    const filters = FindingFiltersSchema.parse(rawFilters);
    const result = await this.pool.query<any>(
      // The operator queue is the ACTIVE round only: the highest round for the
      // run. Earlier rounds stay immutable and separately queryable, so a
      // correction never re-surfaces already-dispositioned history.
      `select f.*,e.step,d.decision disposition,d.rationale from finding_review_sets rs
       join finding_review_set_members m on m.review_set_id=rs.id
       join findings f on f.id=m.finding_id
       join step_executions e on e.id=f.step_execution_id
       left join finding_dispositions d on d.finding_id=f.id where rs.run_id=$1
       and rs.round=(select max(round) from finding_review_sets where run_id=$1)
       and ($2::pipeline_step is null or e.step=$2) and ($3::finding_severity is null or f.severity=$3)
       and ($4::text is null or f.category=$4) and ($5::text is null or ($5='pending' and d.id is null) or d.decision::text=$5)
       order by m.ordinal`,
      [
        runId,
        filters.step ?? null,
        filters.severity ?? null,
        filters.category ?? null,
        filters.disposition ?? null,
      ],
    );
    const sourceRows = result.rows.length
      ? (
          await this.pool.query<any>(
            `select f.id finding_id,s.uri,s.retrieved_at,s.content_hash,s.snapshot,cs.evidence
             from findings f
             join claims c on c.run_id=f.run_id and c.document_version_id=f.document_version_id and c.location=f.location
             join claim_sources cs on cs.run_id=c.run_id and cs.claim_id=c.id
             join sources s on s.run_id=cs.run_id and s.id=cs.source_id
             where f.id=any($1::uuid[])`,
            [result.rows.map((row: any) => row.id)],
          )
        ).rows
      : [];
    return result.rows.map((row: any) => ({
      id: row.id,
      run_id: row.run_id,
      document_version_id: row.document_version_id,
      step_execution_id: row.step_execution_id,
      step: row.step,
      stable_key: row.stable_key,
      category: row.category,
      rule_reference: row.rule_reference,
      severity: row.severity,
      location: row.location,
      issue: row.issue,
      ...(row.evidence ? { evidence: row.evidence } : {}),
      suggested_fix: row.suggested_fix,
      hard_flag: row.hard_flag,
      disposition: row.disposition,
      rationale: row.rationale,
      evidence_sources: sourceRows
        .filter((source: any) => source.finding_id === row.id)
        .flatMap((source: any) => projectEvidenceSource(source)),
    }));
  }

  async submitDispositions(
    runId: string,
    rawInput: BulkDisposition,
  ): Promise<{ completed: boolean; submitted: number; continuation_required: boolean }> {
    const input = BulkDispositionSchema.parse(rawInput);
    return this.transaction(async (client) => {
      const lockedRun = await client.query<{
        current_document_id: string | null;
        status: string;
        current_step: PipelineStepId;
      }>(
        `select r.status,r.current_step,(select id from document_versions where run_id=r.id order by revision desc limit 1) current_document_id
         from runs r where r.id=$1 for update`,
        [runId],
      );
      if (!lockedRun.rows[0]) throw new NotFoundError("The findings run was not found.");
      const normalized = {
        document_version_id: input.document_version_id,
        dispositions: input.dispositions.map((item) => ({
          finding_id: item.finding_id,
          decision: item.decision,
          rationale: item.rationale?.trim() || null,
        })),
      };
      const payloadHash = canonicalHash(normalized);
      const replay = await client.query<{
        run_id: string;
        payload_hash: string;
        finding_count: number;
        review_set_id: string;
        document_version_id: string;
        execution_status: string;
      }>(
        `select s.run_id,s.payload_hash,s.finding_count,s.review_set_id,rs.document_version_id,
                e.status execution_status
         from finding_review_submissions s
         join finding_review_sets rs on rs.id=s.review_set_id
         join step_executions e on e.id=rs.findings_step_execution_id
         where s.idempotency_key=$1`,
        [input.idempotency_key],
      );
      if (replay.rows[0]) {
        const stored = replay.rows[0];
        if (stored.run_id !== runId || stored.payload_hash !== payloadHash)
          throw new ConflictError("The idempotency key is bound to a different review submission.");
        const findingsIndex = PIPELINE_STEPS.findIndex((item) => item.id === "findings_review");
        const currentIndex = PIPELINE_STEPS.findIndex(
          (item) => item.id === lockedRun.rows[0]!.current_step,
        );
        if (
          lockedRun.rows[0]!.status === "cancelled" ||
          lockedRun.rows[0]!.status === "blocked" ||
          currentIndex <= findingsIndex ||
          stored.execution_status !== "succeeded"
        )
          throw new ConflictError(
            "The completed findings review is not in a replayable run state.",
          );
        if (
          lockedRun.rows[0]!.current_document_id !== input.document_version_id ||
          stored.document_version_id !== input.document_version_id
        )
          throw new ConflictError("The completed findings review document is no longer current.");
        return {
          completed: true,
          submitted: stored.finding_count,
          continuation_required: false,
        };
      }
      // Deterministic and explicitly scoped to the active (latest) round: with
      // more than one waiting execution the target must never depend on row
      // order, and decisions must never land on a superseded round.
      const waiting = await client.query<{ id: string; round: number | null }>(
        `select e.id,rs.round from step_executions e
         left join finding_review_sets rs on rs.findings_step_execution_id=e.id
         where e.run_id=$1 and e.step='findings_review' and e.status='waiting'
         order by rs.round desc nulls last,e.attempt desc,e.created_at desc,e.id desc
         limit 1 for update of e`,
        [runId],
      );
      const execution = waiting.rows[0];
      const activeRound = (
        await client.query<{ round: number | null }>(
          "select max(round) round from finding_review_sets where run_id=$1",
          [runId],
        )
      ).rows[0]!.round;
      if (
        execution &&
        execution.round !== null &&
        activeRound !== null &&
        execution.round !== activeRound
      )
        throw new ConflictError("Dispositions must target the active review round.");
      if (!execution || lockedRun.rows[0].status !== "waiting")
        throw new ConflictError("Findings review is not waiting for dispositions.");
      if (!lockedRun.rows[0].current_document_id)
        throw new UnprocessableError("The current document version is unavailable.");
      if (lockedRun.rows[0].current_document_id !== input.document_version_id)
        throw new ConflictError("Dispositions must target the current document version.");
      const ids = input.dispositions.map((item) => item.finding_id);
      const reviewSet = await client.query<{ review_set_id: string; id: string }>(
        `select rs.id review_set_id,f.id from finding_review_sets rs
         join finding_review_set_members m on m.review_set_id=rs.id
         join findings f on f.id=m.finding_id
         where rs.run_id=$1 and rs.document_version_id=$2 and rs.findings_step_execution_id=$3
         order by m.ordinal for update of f`,
        [runId, input.document_version_id, execution.id],
      );
      const reviewSetId =
        reviewSet.rows[0]?.review_set_id ??
        (
          await client.query<{ id: string }>(
            `select id from finding_review_sets where run_id=$1 and document_version_id=$2 and findings_step_execution_id=$3 and finding_count=0`,
            [runId, input.document_version_id, execution.id],
          )
        ).rows[0]?.id;
      if (!reviewSetId)
        throw new ConflictError(
          "The waiting findings execution has no matching frozen review set.",
        );
      const allowedIds = new Set(reviewSet.rows.map((row) => row.id));
      if (ids.length !== allowedIds.size || ids.some((id) => !allowedIds.has(id)))
        throw new UnprocessableError(
          "Every pending finding in the frozen review set needs a decision.",
        );
      const already = await client.query(
        "select 1 from finding_dispositions where finding_id=any($1::uuid[]) limit 1",
        [ids],
      );
      if (already.rows[0]) throw new ConflictError("A finding already has a disposition.");
      for (const item of input.dispositions)
        await client.query(
          `insert into finding_dispositions(run_id,finding_id,revision_step_execution_id,decision,rationale) values($1,$2,$3,$4,$5)`,
          [runId, item.finding_id, execution.id, item.decision, item.rationale?.trim() || null],
        );
      const pending = await client.query(
        `select 1 from finding_review_set_members m
         where m.review_set_id=$1 and not exists(select 1 from finding_dispositions d where d.finding_id=m.finding_id) limit 1`,
        [reviewSetId],
      );
      if (!pending.rows[0]) {
        await client.query(
          `insert into finding_review_submissions(review_set_id,run_id,idempotency_key,payload_hash,finding_count,decision_count)
           values($1,$2,$3,$4,$5,$5)`,
          [reviewSetId, runId, input.idempotency_key, payloadHash, reviewSet.rows.length],
        );
        await client.query(
          "update step_executions set status='succeeded',completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1",
          [execution.id],
        );
        // Findings review has concluded — the run moves on to the next
        // (externally-triggered, model-owned) step rather than staying
        // parked at the step that just succeeded.
        await client.query(
          "update runs set status='running',current_step='revision_pass',block_reason=null,updated_at=clock_timestamp() where id=$1",
          [runId],
        );
        await this.enqueueRunClient(client, runId, {});
      }
      return {
        completed: !pending.rows[0],
        submitted: input.dispositions.length,
        continuation_required: !pending.rows[0],
      };
    });
  }

  async getRevisionFindings(runId: string, documentVersionId: string) {
    const cycle = await this.pool.query<{
      coherence_return_cycles: number;
      deterministic_repair_cycles: number;
      current_step: PipelineStepId;
    }>(
      "select coherence_return_cycles,deterministic_repair_cycles,current_step from runs where id=$1",
      [runId],
    );
    const run = cycle.rows[0];
    const exceptional = (
      await this.pool.query<{
        document_version_id: string;
        deterministic_rerun_step_execution_id: string;
        blocker_set_hash: string;
        blocker_bindings: unknown;
      }>(
        `select document_version_id,deterministic_rerun_step_execution_id,blocker_set_hash,blocker_bindings
         from exceptional_correction_authorisations where run_id=$1`,
        [runId],
      )
    ).rows[0];
    if (exceptional && exceptional.document_version_id !== documentVersionId)
      throw new Error("Exceptional correction is not bound to the current document.");
    const currentRerun = (
      await this.pool.query<{
        step_execution_id: string;
        blockers: number;
        actual_blockers: number;
        blocker_set_hash: string | null;
      }>(
        `select r.step_execution_id,r.retained_blockers+r.introduced_blockers blockers,
           count(f.id)::int actual_blockers,
           encode(digest(string_agg(f.id::text||':'||f.rule_reference||':'||f.location::text,'|' order by f.created_at,f.stable_key),'sha256'),'hex') blocker_set_hash
         from deterministic_reruns r
         join step_executions e on e.id=r.step_execution_id and e.run_id=r.run_id
           and e.step='automated_checks_rerun' and e.status='succeeded'
         join findings f on f.run_id=r.run_id and f.document_version_id=r.document_version_id
           and f.step_execution_id=r.step_execution_id and f.severity='blocker'
         where r.run_id=$1 and r.document_version_id=$2
           and ($3::uuid is null or r.step_execution_id=$3)
         group by r.step_execution_id,r.retained_blockers,r.introduced_blockers`,
        [runId, documentVersionId, exceptional?.deterministic_rerun_step_execution_id ?? null],
      )
    ).rows[0];
    if (
      exceptional &&
      (!currentRerun ||
        currentRerun.actual_blockers !== currentRerun.blockers ||
        currentRerun.blocker_set_hash !== exceptional.blocker_set_hash)
    )
      throw new Error("Exceptional correction blocker binding no longer matches Step 1.11.");
    const source =
      currentRerun?.blockers && currentRerun.actual_blockers === currentRerun.blockers
        ? exceptional
          ? ("operator_authorised_repair" as const)
          : ("deterministic_repair" as const)
        : run?.coherence_return_cycles
          ? ("coherence_repair" as const)
          : run?.deterministic_repair_cycles || run?.current_step === "automated_checks_rerun"
            ? (() => {
                throw new Error(
                  "Deterministic recovery evidence is missing for the current document; operator action is required.",
                );
              })()
            : ("operator_findings" as const);
    const result = await this.pool.query<any>(
      source === "operator_findings"
        ? // Only the ACTIVE round's accepted findings drive this revision. An
          // earlier round's accepted findings were already applied to produce
          // the current version; re-applying them would duplicate the edit.
          `select f.* from finding_review_sets rs
           join finding_review_set_members m on m.review_set_id=rs.id
           join findings f on f.id=m.finding_id
           join finding_dispositions d on d.finding_id=f.id and d.run_id=f.run_id
           where rs.run_id=$1 and rs.document_version_id=$2 and d.decision='accepted'
             and rs.round=(select max(round) from finding_review_sets where run_id=$1)
           order by m.ordinal`
        : source === "deterministic_repair" || source === "operator_authorised_repair"
          ? `select f.* from findings f join step_executions e on e.id=f.step_execution_id
             where f.run_id=$1 and f.document_version_id=$2
               and f.step_execution_id=$3 and e.step='automated_checks_rerun'
               and e.status='succeeded' and f.severity='blocker'
             order by f.created_at,f.stable_key`
          : `select f.* from findings f join step_executions e on e.id=f.step_execution_id
             where f.run_id=$1 and f.document_version_id=$2
               and e.step='final_coherence_export' and f.severity='blocker'
             order by f.created_at,f.stable_key`,
      source === "operator_findings"
        ? [runId, documentVersionId]
        : source === "deterministic_repair" || source === "operator_authorised_repair"
          ? [runId, documentVersionId, currentRerun!.step_execution_id]
          : [runId, documentVersionId],
    );
    // Authority is only ever the immutable persisted authorisation; it is never
    // recomputed at execution time, so it cannot widen after the operator
    // confirmed it.
    const exceptionalBindings = exceptional
      ? z.array(ExceptionalBlockerBindingSchema).parse(exceptional.blocker_bindings)
      : [];
    const findings = result.rows.map((row: any) => ({
      id: row.id,
      stable_key: row.stable_key,
      category: row.category,
      rule_reference: row.rule_reference,
      severity: row.severity,
      location:
        exceptionalBindings.find((binding) => binding.finding_id === row.id)?.location ??
        row.location,
      issue: row.issue,
      ...(row.evidence ? { evidence: row.evidence } : {}),
      suggested_fix: row.suggested_fix,
      disposition: "accepted" as const,
      origin_document_version_id: row.document_version_id,
    }));
    const exclusions = await this.pool.query<{ location: any }>(
      `select f.location from findings f join finding_dispositions d on d.finding_id=f.id and d.run_id=f.run_id
       where f.run_id=$1 and f.document_version_id=$2 and d.decision='rejected'`,
      [runId, documentVersionId],
    );
    const verified = await this.pool.query<{ location: any }>(
      `select location from claims where run_id=$1 and document_version_id=$2 and status='verified'`,
      [runId, documentVersionId],
    );
    return {
      source,
      findings,
      rejected_locations: exclusions.rows.map((row) => row.location),
      verified_fact_locations: verified.rows.map((row) => row.location),
      authorised_readability: authorisedReadabilityFromBindings(exceptionalBindings),
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
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const requestHash = canonicalHash(RevisionRequestSchema.parse(input.request));
      const existing = await client.query<{
        request_hash: string;
        response: unknown;
        response_hash: string | null;
      }>(
        "select request_hash,response,response_hash from revision_operation_states where operation_id=$1 for update",
        [input.operation_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash)
          throw new Error("Immutable revision operation conflict");
        if (!existing.rows[0].response) {
          const state = await client.query<{ status: string }>(
            "select status from revision_operation_states where operation_id=$1",
            [input.operation_id],
          );
          if (state.rows[0]?.status === "provider_in_flight")
            throw new Error(
              "Revision provider outcome is ambiguous; no duplicate call was made. Change provider/model or contract version to start a new operation.",
            );
          return null;
        }
        const response = RevisionResponseSchema.parse(existing.rows[0].response);
        if (existing.rows[0].response_hash !== canonicalHash(response))
          throw new Error("Revision checkpoint hash mismatch");
        return response;
      }
      await client.query(
        `insert into revision_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash) values($1,$2,$3,$4,$5)`,
        [
          input.operation_id,
          input.run_id,
          input.document_version_id,
          input.execution_id,
          requestHash,
        ],
      );
      return null;
    });
  }

  async markRevisionProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        `update revision_operation_states set status='provider_in_flight',release_reason=null,
           ambiguity_reason='provider_in_flight_without_checkpoint'
         where operation_id=$1 and run_id=$2 and status='started' and response is null`,
        [input.operation_id, input.run_id],
      );
      if (changed.rowCount !== 1)
        throw new Error("Revision operation cannot start a provider call");
    });
  }

  async releaseRevisionProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      await client.query(
        `update revision_operation_states set status='started',ambiguity_reason=null,release_reason=$3
         where operation_id=$1 and run_id=$2 and status='provider_in_flight' and response is null`,
        [input.operation_id, input.run_id, input.reason],
      );
    });
  }

  async checkpointRevisionResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: RevisionResponse;
  }): Promise<void> {
    const response = RevisionResponseSchema.parse(input.response),
      responseHash = canonicalHash(response);
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const result = await client.query(
        `update revision_operation_states set response=$2::jsonb,response_hash=$3,status='checkpointed',ambiguity_reason=null,checkpointed_at=clock_timestamp() where operation_id=$1 and run_id=$4 and response is null`,
        [input.operation_id, JSON.stringify(response), responseHash, input.run_id],
      );
      if (result.rowCount !== 1) {
        const existing = await client.query<{ response_hash: string }>(
          "select response_hash from revision_operation_states where operation_id=$1",
          [input.operation_id],
        );
        if (existing.rows[0]?.response_hash !== responseHash)
          throw new Error("Immutable revision checkpoint conflict");
      }
    });
  }

  async getRevisionFailureLock(runId: string, identity: RevisionFailureIdentity) {
    const result = await this.pool.query<{
      failure_category: RevisionSafeFailureCategory;
      failures: number;
    }>(
      `select failure_category,count(*)::int failures
       from revision_provider_failures
       where run_id=$1 and provider=$2 and model=$3 and prompt_version=$4 and planning_version=$5
       group by failure_category having count(*) >= 2 order by max(created_at) desc limit 1`,
      [
        runId,
        identity.provider,
        identity.model,
        identity.prompt_version,
        identity.planning_version,
      ],
    );
    const row = result.rows[0];
    return row && row.failures >= 2
      ? { category: row.failure_category, failures: row.failures }
      : null;
  }

  async recordRevisionFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    identity: RevisionFailureIdentity;
    category: RevisionSafeFailureCategory;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      await client.query(
        `insert into revision_provider_failures(run_id,step_execution_id,operation_id,provider,model,prompt_version,planning_version,failure_category)
         values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(step_execution_id) do nothing`,
        [
          input.run_id,
          input.execution_id,
          input.operation_id,
          input.identity.provider,
          input.identity.model,
          input.identity.prompt_version,
          input.identity.planning_version,
          input.category,
        ],
      );
    });
  }

  async getExportClaims(runId: string, documentVersionId: string): Promise<ExportClaim[]> {
    const result = await this.pool.query<any>(
      `select c.id,c.claim_text,c.claim_hash,c.type,c.status,c.location,c.hard_flag,
       coalesce(jsonb_agg(jsonb_build_object('id',s.id,'uri',s.uri,'title',s.title,'publisher',s.publisher,
         'retrieved_at',s.retrieved_at,'content_hash',s.content_hash,'evidence_location',cs.evidence_location,
         'evidence',cs.evidence,'evidence_hash',case when cs.evidence is null then null else encode(digest(cs.evidence,'sha256'),'hex') end)
         order by s.created_at,s.id) filter(where s.id is not null),'[]') sources
       from claims c left join claim_sources cs on cs.claim_id=c.id and cs.run_id=c.run_id
       left join sources s on s.id=cs.source_id and s.run_id=cs.run_id
       where c.run_id=$1 and c.document_version_id=$2
       group by c.id order by c.created_at,c.id`,
      [runId, documentVersionId],
    );
    const draft = await this.getDraft(runId);
    return result.rows.map((row) => {
      const claimIndex =
        row.location?.field === "claims" && Number.isInteger(row.location?.line_start)
          ? row.location.line_start - 1
          : -1;
      const product =
        claimIndex >= 0 && draft?.draft.claims[claimIndex]?.text === row.claim_text
          ? draft?.draft.claims[claimIndex]?.product_identifier
          : undefined;
      return ExportClaimSchema.parse({
        ...row,
        sources: row.sources.map((source: any) => ({
          ...source,
          ...(source.title === null ? { title: undefined } : {}),
          ...(source.publisher === null ? { publisher: undefined } : {}),
          ...(source.evidence_location === null ? { evidence_location: undefined } : {}),
          ...(source.evidence === null ? { evidence: undefined } : {}),
        })),
        ...(product ? { product_identifier: product } : {}),
      });
    });
  }

  async getRejectedFindings(
    runId: string,
    finalDocumentVersionId: string,
  ): Promise<ExportRejectedFinding[]> {
    const result = await this.pool.query<any>(
      `select f.id finding_id,d.id disposition_id,rs.id review_set_id,rs.membership_hash review_set_membership_hash,
       f.stable_key,f.category,f.rule_reference,f.severity,f.location,f.issue,f.evidence,f.suggested_fix,d.rationale,
       encode(digest(jsonb_build_object('id',f.id,'stable_key',f.stable_key,'location',f.location)::text,'sha256'),'hex') finding_hash,
       encode(digest(jsonb_build_object('id',d.id,'decision',d.decision,'rationale',d.rationale)::text,'sha256'),'hex') disposition_hash
       from document_versions final
       join finding_review_sets rs on rs.run_id=final.run_id
       join step_executions review_execution on review_execution.id=rs.findings_step_execution_id
         and review_execution.run_id=rs.run_id and review_execution.step='findings_review'
         and review_execution.status='succeeded'
       join finding_review_set_members rsm on rsm.review_set_id=rs.id
       join findings f on f.id=rsm.finding_id and f.run_id=rs.run_id
         and f.document_version_id=rs.document_version_id
       join finding_dispositions d on d.finding_id=f.id and d.run_id=f.run_id
       where final.run_id=$1 and final.id=$2 and d.decision='rejected'
       order by review_execution.completed_at desc,rsm.ordinal`,
      [runId, finalDocumentVersionId],
    );
    return result.rows.map((row) =>
      ExportRejectedFindingSchema.parse({
        ...row,
        ...(row.evidence === null ? { evidence: undefined } : {}),
      }),
    );
  }

  async getContentTemplates() {
    const selected = [
      { ...this.templateSelection.writer, kind: "writer_submission" as const },
      { ...this.templateSelection.schema, kind: "blog_schema" as const },
    ];
    const rows = await Promise.all(
      selected.map(async (selection) => {
        const row = (
          await this.pool.query<{
            id: string;
            template_id: string;
            version: string;
            kind: string;
            status: "pending_editorial_approval" | "approved";
            body: unknown;
            content_hash: string;
          }>(
            `select id,template_id,version,kind,status,body,content_hash from content_templates
             where template_id=$1 and version=$2 and kind=$3`,
            [selection.template_id, selection.version, selection.kind],
          )
        ).rows[0];
        if (!row) throw new Error("Configured content template version is missing");
        if (row.content_hash !== contentHash(JSON.stringify(row.body)))
          throw new Error("Persisted content template hash mismatch");
        if (row.status !== "approved" && !this.templateSelection.allow_local_pending)
          throw new Error("Configured content template is not authorised");
        return row;
      }),
    );
    const [writer, schema] = rows;
    return {
      writer_template: WriterTemplateSchema.parse({
        row_id: writer!.id,
        template_id: writer!.template_id,
        version: writer!.version,
        status: writer!.status,
        ...(writer!.body as object),
        body_hash: writer!.content_hash,
        policy: writer!.status === "approved" ? "authorised" : "local_pending_explicit",
      }),
      schema_template: BlogSchemaTemplateSchema.parse({
        row_id: schema!.id,
        registry_id: schema!.template_id,
        version: schema!.version,
        status: schema!.status,
        ...(schema!.body as object),
        body_hash: schema!.content_hash,
        policy: schema!.status === "approved" ? "authorised" : "local_pending_explicit",
      }),
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
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const current = await client.query<{
        version_id: string;
        artifact_id: string;
        revision: number;
      }>(
        `select d.id version_id,d.artifact_id,d.revision from document_versions d where d.run_id=$1 order by revision desc limit 1 for update`,
        [input.run_id],
      );
      const row = current.rows[0];
      if (!row || row.version_id !== request.document_version_id)
        throw new Error("Revision must target the current document");
      const operation = await client.query<{ content_hash: string }>(
        "select content_hash from provider_operations where operation_id=$1 for update",
        [request.operation_id],
      );
      if (input.audits.length !== request.accepted_findings.length)
        throw new Error("Revision audit cardinality mismatch");
      const { revisionManifestHash } = await import("../../shared/revision-application.js");
      const manifestHash = revisionManifestHash(input.audits);
      input.audits.forEach((audit, index) => {
        const finding = request.accepted_findings[index],
          result = response.finding_results[index];
        if (
          !finding ||
          !result ||
          audit.ordinal !== index ||
          audit.finding_id !== finding.id ||
          result.finding_id !== finding.id ||
          audit.status !== result.status ||
          audit.changed !== (audit.status === "applied")
        )
          throw new Error("Revision audit consistency mismatch");
      });
      const identity = canonicalHash({ response, manifest_hash: manifestHash });
      if (operation.rows[0]) {
        if (operation.rows[0].content_hash !== identity)
          throw new Error("Immutable revision conflict");
        return;
      }
      const body = JSON.stringify(response.document),
        hash = contentHash(body),
        artifactId = randomUUID(),
        versionId = randomUUID();
      await client.query(
        `insert into artifacts(id,run_id,step_execution_id,parent_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,$3,$4,'draft_revision','application/json',$5,$6,$7)`,
        [
          artifactId,
          input.run_id,
          input.execution_id,
          row.artifact_id,
          body,
          hash,
          Buffer.byteLength(body),
        ],
      );
      await client.query(
        `insert into document_versions(id,run_id,artifact_id,parent_id,revision,content_hash,revision_source) values($1,$2,$3,$4,$5,$6,$7)`,
        [
          versionId,
          input.run_id,
          artifactId,
          row.version_id,
          row.revision + 1,
          hash,
          request.revision_source,
        ],
      );
      for (const [kind, value, parent] of [
        ["revision_request", request, row.artifact_id],
        ["revision_response", response, artifactId],
      ] as const) {
        const auditBody = JSON.stringify(value);
        await client.query(
          `insert into artifacts(run_id,step_execution_id,parent_id,kind,media_type,body_text,content_hash,size_bytes) values($1,$2,$3,$4,'application/json',$5,$6,$7)`,
          [
            input.run_id,
            input.execution_id,
            parent,
            kind,
            auditBody,
            contentHash(auditBody),
            Buffer.byteLength(auditBody),
          ],
        );
      }
      await client.query(
        `with copied as (
           insert into claims(id,run_id,document_version_id,claim_text,claim_hash,type,status,location,hard_flag)
           select gen_random_uuid(),run_id,$3,claim_text,claim_hash,type,status,location,hard_flag
           from claims where run_id=$1 and document_version_id=$2
           returning id,claim_hash
         )
         insert into claim_sources(run_id,claim_id,source_id,status,evidence_location,evidence)
         select $1,n.id,cs.source_id,cs.status,cs.evidence_location,cs.evidence
         from copied n
         join claims old on old.run_id=$1 and old.document_version_id=$2 and old.claim_hash=n.claim_hash
         join claim_sources cs on cs.run_id=$1 and cs.claim_id=old.id`,
        [input.run_id, row.version_id, versionId],
      );
      for (let index = 0; index < input.audits.length; index += 1) {
        const audit = input.audits[index]!;
        await client.query(
          `insert into revision_finding_audits(run_id,operation_id,step_execution_id,source_document_version_id,result_document_version_id,finding_id,ordinal,status,reason,location,location_json,hunks,manifest_hash,changed,before_hash,after_hash)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)`,
          [
            input.run_id,
            request.operation_id,
            input.execution_id,
            row.version_id,
            versionId,
            audit.finding_id,
            index,
            audit.status,
            audit.reason,
            JSON.stringify(audit.location),
            JSON.stringify(audit.location),
            JSON.stringify(audit.hunks),
            manifestHash,
            audit.changed,
            audit.before_hash,
            audit.after_hash,
          ],
        );
      }
      await client.query(
        `insert into provider_usage(run_id,step_execution_id,provider,model,operation,request_id,input_units,output_units,cost_micros,latency_ms) values($1,$2,$3,$4,'revision_pass',$5,$6,$7,$8,$9)`,
        [
          input.run_id,
          input.execution_id,
          input.provider,
          input.model,
          request.operation_id,
          response.usage.input_units,
          response.usage.output_units,
          response.usage.cost_micros,
          response.usage.latency_ms ?? null,
        ],
      );
      await client.query(
        `insert into provider_operations(operation_id,run_id,document_version_id,step_execution_id,operation,content_hash) values($1,$2,$3,$4,'revision_pass',$5)`,
        [request.operation_id, input.run_id, versionId, input.execution_id, identity],
      );
      await this.completeOutputStepClient(
        client,
        input.run_id,
        input.execution_id,
        input.token,
        "revision_pass",
      );
    });
    const saved = await this.getDraft(input.run_id);
    if (!saved) throw new Error("Revision transaction produced no document");
    return saved;
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
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const current = await client.query<{ id: string }>(
        "select id from document_versions where run_id=$1 order by revision desc limit 1 for update",
        [input.run_id],
      );
      if (current.rows[0]?.id !== input.document_version_id)
        throw new Error("Revision must target the current document");
      const existing = await client.query<{
        run_id: string;
        document_version_id: string;
        revision_source: string;
      }>(
        "select run_id,document_version_id,revision_source from revision_noop_completions where operation_id=$1 for update",
        [input.operation_id],
      );
      if (
        existing.rows[0] &&
        (existing.rows[0].run_id !== input.run_id ||
          existing.rows[0].document_version_id !== input.document_version_id ||
          existing.rows[0].revision_source !== input.source)
      )
        throw new Error("Immutable revision no-op conflict");
      await client.query(
        `insert into revision_noop_completions(operation_id,run_id,step_execution_id,document_version_id,revision_source)
         values($1,$2,$3,$4,$5) on conflict(operation_id) do nothing`,
        [
          input.operation_id,
          input.run_id,
          input.execution_id,
          input.document_version_id,
          input.source,
        ],
      );
      await this.completeOutputStepClient(
        client,
        input.run_id,
        input.execution_id,
        input.token,
        "revision_pass",
      );
    });
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
    const values = input.findings.map((item) =>
      PersistedReviewFindingSchema.parse({ ...item, hard_flag: false }),
    );
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const existing = (
        await client.query<{ result_hash: string; result: unknown }>(
          `select result_hash,result from deterministic_reruns
           where run_id=$1 and document_version_id=$2 for update`,
          [input.run_id, input.document_version_id],
        )
      ).rows[0];
      if (existing) {
        const stored = DeterministicRunResultSchema.parse(existing.result);
        if (
          existing.result_hash === result.result_hash &&
          canonicalHash(stored) === canonicalHash(result)
        ) {
          const run = (
            await client.query<{ deterministic_repair_cycles: number }>(
              "select deterministic_repair_cycles from runs where id=$1",
              [input.run_id],
            )
          ).rows[0]!;
          const blockers =
            result.comparison!.retained_blockers.length +
            result.comparison!.introduced_blockers.length;
          return blockers === 0
            ? "continue"
            : run.deterministic_repair_cycles >= 2
              ? "blocked"
              : "repair";
        }
        throw new ConflictError("Step 1.11 rerun already exists with different content");
      }
      await this.insertFindingsClient(
        client,
        input.run_id,
        input.document_version_id,
        input.execution_id,
        values,
      );
      await client.query(
        `insert into deterministic_reruns(run_id,document_version_id,step_execution_id,baseline_manifest_hash,result_hash,result,retained_blockers,introduced_blockers) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          input.run_id,
          input.document_version_id,
          input.execution_id,
          result.baseline_manifest_hash,
          result.result_hash,
          JSON.stringify(result),
          result.comparison!.retained_blockers.length,
          result.comparison!.introduced_blockers.length,
        ],
      );
      await client.query(
        "insert into step_outputs(run_id,document_version_id,step,step_execution_id,content_hash) values($1,$2,'automated_checks_rerun',$3,$4)",
        [input.run_id, input.document_version_id, input.execution_id, result.result_hash],
      );
      await this.requireFenceClient(
        client,
        "select complete_step_execution($1,$2) changed",
        input.execution_id,
        input.token,
      );
      const blockerCount =
        result.comparison!.retained_blockers.length + result.comparison!.introduced_blockers.length;
      if (blockerCount === 0) {
        await client.query(
          "update runs set status='running',current_step='final_coherence_export',block_reason=null,updated_at=clock_timestamp() where id=$1",
          [input.run_id],
        );
        return "continue" as const;
      }
      const run = (
        await client.query<{ deterministic_repair_cycles: number }>(
          "select deterministic_repair_cycles from runs where id=$1 for update",
          [input.run_id],
        )
      ).rows[0]!;
      if (run.deterministic_repair_cycles >= 2) {
        await client.query(
          "update runs set status='blocked',current_step='automated_checks_rerun',block_reason='deterministic_blockers',updated_at=clock_timestamp() where id=$1",
          [input.run_id],
        );
        return "blocked" as const;
      }
      await client.query(
        "update runs set status='running',current_step='revision_pass',deterministic_repair_cycles=deterministic_repair_cycles+1,block_reason=null,updated_at=clock_timestamp() where id=$1",
        [input.run_id],
      );
      return "repair" as const;
    });
  }

  async getDeterministicGate(runId: string, documentVersionId: string) {
    const row = (
      await this.pool.query<{
        retained_blockers: number;
        introduced_blockers: number;
        result: any;
        content_hash: string;
        manifest_hash: string;
        config_hash: string;
      }>(
        `select d.retained_blockers,d.introduced_blockers,d.result,v.content_hash,
         m.manifest_hash,m.manifest->>'config_hash' config_hash
         from deterministic_reruns d join document_versions v on v.id=d.document_version_id and v.run_id=d.run_id
         join deterministic_manifests m on m.run_id=d.run_id
         where d.run_id=$1 and d.document_version_id=$2`,
        [runId, documentVersionId],
      )
    ).rows[0];
    if (!row) throw new Error("Step 1.11 result is missing");
    const result = DeterministicRunResultSchema.parse(row.result);
    const current = (
      await this.pool.query<{ id: string; content_hash: string }>(
        "select id,content_hash from document_versions where run_id=$1 order by revision desc limit 1",
        [runId],
      )
    ).rows[0];
    return {
      retained_blockers: row.retained_blockers,
      introduced_blockers: row.introduced_blockers,
      exact_document_match:
        current?.id === result.document_id &&
        current.content_hash === result.document_hash &&
        row.content_hash === result.document_hash &&
        result.baseline_manifest_hash === row.manifest_hash &&
        result.config_hash === row.config_hash,
      result_hash: result.result_hash,
    };
  }

  async getCoherenceRevisionContext(runId: string, documentVersionId: string) {
    const pair = (
      await this.pool.query<{
        parent_id: string | null;
        body_text: string;
        coherence_return_cycles: number;
      }>(
        `select current.parent_id,parent_artifact.body_text,r.coherence_return_cycles
       from document_versions current join document_versions parent on parent.id=current.parent_id and parent.run_id=current.run_id
       join artifacts parent_artifact on parent_artifact.id=parent.artifact_id and parent_artifact.run_id=parent.run_id
       join runs r on r.id=current.run_id where current.run_id=$1 and current.id=$2`,
        [runId, documentVersionId],
      )
    ).rows[0];
    if (!pair?.parent_id)
      throw new Error("Coherence requires an exact revised parent/current pair");
    const audits = await this.pool.query<{
      finding_id: string;
      status: "applied" | "unable";
      reason: string;
      location_json: unknown;
      hunks: import("../../shared/revision-application.js").RevisionHunk[];
      changed: boolean;
      before_hash: string;
      after_hash: string;
    }>(
      `select finding_id,status,reason,location_json,hunks,changed,before_hash,after_hash
       from revision_finding_audits where run_id=$1 and result_document_version_id=$2 order by ordinal`,
      [runId, documentVersionId],
    );
    const reason = (
      await this.pool.query<{
        revision_source: "operator_findings" | "deterministic_repair" | "coherence_repair";
      }>(
        `select coalesce(d.revision_source,n.revision_source) revision_source
         from document_versions d left join revision_noop_completions n
           on n.document_version_id=d.id and n.run_id=d.run_id
         where d.run_id=$1 and d.id=$2 limit 1`,
        [runId, documentVersionId],
      )
    ).rows[0]?.revision_source;
    if (!reason) throw new Error("Authoritative revision source is missing");
    return {
      parent_document_version_id: pair.parent_id,
      parent_document: readStoredStructuredDraft(JSON.parse(pair.body_text)).draft,
      revision_reason: reason,
      coherence_cycle: pair.coherence_return_cycles,
      revision_audits: audits.rows.map(({ location_json, ...row }) => ({
        ...row,
        finding_id: row.finding_id,
        location: FindingLocationSchema.parse(location_json),
      })),
    };
  }

  async blockFinalForDeterministic(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      const blockers = await client.query(
        `select 1 from findings f join step_executions e on e.id=f.step_execution_id
         where f.run_id=$1 and f.document_version_id=$2 and e.step='automated_checks_rerun'
         and f.severity='blocker' limit 1`,
        [runId, documentVersionId],
      );
      if (!blockers.rows[0]) throw new Error("Deterministic blocker gate changed");
      await client.query(
        `update step_executions set status='blocked',lease_token=null,lease_owner=null,
         lease_expires_at=null,updated_at=clock_timestamp() where id=$1`,
        [executionId],
      );
      await client.query(
        `update runs set status='blocked',current_step='final_coherence_export',block_reason='deterministic_blockers',updated_at=clock_timestamp()
         where id=$1`,
        [runId],
      );
    });
  }

  async beginCoherenceOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    document_version_id: string;
    request: CoherenceRequest;
  }) {
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const requestHash = canonicalHash(CoherenceRequestSchema.parse(input.request));
      const existing = await client.query<{
        request_hash: string;
        response: unknown;
        response_hash: string | null;
        status: string;
      }>(
        "select request_hash,response,response_hash,status from coherence_checkpoints where operation_id=$1 for update",
        [input.operation_id],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.request_hash !== requestHash)
          throw new Error("Immutable coherence operation conflict");
        if (row.response) {
          if (row.status !== "checkpointed")
            throw new Error("Coherence checkpoint response has invalid status");
          const response = CoherenceResponseSchema.parse(row.response);
          if (row.response_hash !== canonicalHash(response))
            throw new Error("Coherence checkpoint hash mismatch");
          return response;
        }
        if (row.status === "provider_in_flight")
          throw new Error(
            "Coherence provider outcome is ambiguous; no duplicate call was made. Operator action is required before this document can continue.",
          );
        if (row.status !== "started")
          throw new Error("Coherence checkpoint has an invalid response state");
        return null;
      }
      await client.query(
        `insert into coherence_checkpoints(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash) values($1,$2,$3,$4,$5)`,
        [
          input.operation_id,
          input.run_id,
          input.document_version_id,
          input.execution_id,
          requestHash,
        ],
      );
      return null;
    });
  }
  async markCoherenceProviderInFlight(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        `update coherence_checkpoints set status=$$provider_in_flight$$,release_reason=null,
           ambiguity_reason='provider_in_flight_without_checkpoint'
         where operation_id=$1 and run_id=$2 and status=$$started$$ and response is null and response_hash is null`,
        [input.operation_id, input.run_id],
      );
      if (changed.rowCount !== 1)
        throw new Error("Coherence operation cannot start a provider call");
    });
  }

  async releaseCoherenceProviderFailure(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    reason: import("../../shared/paid-operation.js").PaidOperationReleaseReason;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const changed = await client.query(
        `update coherence_checkpoints set status=$$started$$,ambiguity_reason=null,release_reason=$3
         where operation_id=$1 and run_id=$2 and status=$$provider_in_flight$$ and response is null and response_hash is null`,
        [input.operation_id, input.run_id, input.reason],
      );
      if (changed.rowCount !== 1)
        throw new Error("Coherence release requires an in-flight provider operation");
    });
  }

  async checkpointCoherenceResponse(input: {
    run_id: string;
    execution_id: string;
    token: string;
    operation_id: string;
    response: CoherenceResponse;
  }) {
    const response = CoherenceResponseSchema.parse(input.response),
      responseHash = canonicalHash(response);
    await this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const result = await client.query(
        `update coherence_checkpoints set response=$2::jsonb,response_hash=$3,status=$$checkpointed$$,ambiguity_reason=null,checkpointed_at=clock_timestamp()
         where operation_id=$1 and run_id=$4 and status=$$provider_in_flight$$ and response is null and response_hash is null`,
        [input.operation_id, JSON.stringify(response), responseHash, input.run_id],
      );
      if (result.rowCount === 1) return;
      const existing = await client.query<{
        response: unknown;
        response_hash: string | null;
        status: string;
      }>(
        "select response,response_hash,status from coherence_checkpoints where operation_id=$1 for update",
        [input.operation_id],
      );
      const row = existing.rows[0];
      if (row?.response && row.status === "checkpointed" && row.response_hash === responseHash)
        return;
      if (row?.response) throw new Error("Immutable coherence checkpoint conflict");
      throw new Error("Coherence checkpoint requires an in-flight provider operation");
    });
  }

  async recoverCoherence(
    runId: string,
    documentVersionId: string,
    operationId: string,
    recoveryExecutionId: string,
    token: string,
  ) {
    return this.transaction(async (client) => {
      await this.assertFence(client, runId, recoveryExecutionId, token);
      const result = await client.query<{
        step_execution_id: string;
        body_text: string;
      }>(
        `select o.step_execution_id,a.body_text from provider_operations o
         join artifacts a on a.run_id=o.run_id and a.step_execution_id=o.step_execution_id
           and a.kind='coherence_response'
         where o.operation_id=$1 and o.run_id=$2 and o.document_version_id=$3`,
        [operationId, runId, documentVersionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const response = CoherenceResponseSchema.parse(JSON.parse(row.body_text));
      const coherenceBlockers = response.findings.filter(
        (finding) => finding.severity === "blocker",
      ).length;
      const run = (
        await client.query<{ status: string; coherence_return_cycles: number }>(
          "select status,coherence_return_cycles from runs where id=$1 for update",
          [runId],
        )
      ).rows[0];
      if (!run) throw new NotFoundError("The run was not found.");
      const outcome =
        coherenceBlockers === 0 ? "export" : run.status === "blocked" ? "blocked" : "revise";
      await client.query(
        `insert into coherence_recoveries(operation_id,run_id,document_version_id,
          producing_step_execution_id,recovery_step_execution_id,outcome)
         values($1,$2,$3,$4,$5,$6) on conflict(operation_id,recovery_step_execution_id) do nothing`,
        [
          operationId,
          runId,
          documentVersionId,
          row.step_execution_id,
          recoveryExecutionId,
          outcome,
        ],
      );
      if (outcome === "revise") {
        await this.requireFenceClient(
          client,
          "select complete_step_execution($1,$2) changed",
          recoveryExecutionId,
          token,
        );
        await client.query(
          `update runs set status='running',current_step='revision_pass',block_reason=null,updated_at=clock_timestamp()
           where id=$1`,
          [runId],
        );
      } else if (outcome === "blocked") {
        await client.query(
          `update step_executions set status='blocked',lease_token=null,lease_owner=null,
           lease_expires_at=null,updated_at=clock_timestamp() where id=$1`,
          [recoveryExecutionId],
        );
        await client.query(
          `update runs set status='blocked',current_step='final_coherence_export',block_reason='coherence_cycle_cap',updated_at=clock_timestamp()
           where id=$1`,
          [runId],
        );
      }
      return PersistedCoherenceSchema.parse({
        operation_id: operationId,
        response,
        gate: {
          deterministic_blockers: 0,
          coherence_blockers: coherenceBlockers,
          outcome,
        },
        producing_step_execution_id: row.step_execution_id,
      });
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
    return this.transaction(async (client) => {
      await this.assertFence(client, input.run_id, input.execution_id, input.token);
      const run = (
        await client.query<{ coherence_return_cycles: number }>(
          "select coherence_return_cycles from runs where id=$1 for update",
          [input.run_id],
        )
      ).rows[0];
      if (!run) throw new NotFoundError("The run was not found.");
      const existing = await client.query<{ content_hash: string }>(
        "select content_hash from provider_operations where operation_id=$1",
        [request.operation_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].content_hash !== canonicalHash(response))
          throw new Error("Immutable coherence conflict");
        return response.findings.some((finding) => finding.severity === "blocker")
          ? run.coherence_return_cycles >= 2
            ? "blocked"
            : "revise"
          : "export";
      }
      const prefixed = response.findings.map((finding) => ({
        ...finding,
        stable_key: `coherence:r${run.coherence_return_cycles}:${finding.stable_key}`,
        hard_flag: false,
      }));
      await this.insertFindingsClient(
        client,
        input.run_id,
        input.document_version_id,
        input.execution_id,
        prefixed,
      );
      for (const [kind, value] of [
        ["coherence_request", request],
        ["coherence_response", response],
      ] as const) {
        const body = JSON.stringify(value);
        await client.query(
          `insert into artifacts(run_id,step_execution_id,parent_id,kind,media_type,body_text,content_hash,size_bytes) select $1,$2,artifact_id,$3,'application/json',$4,$5,$6 from document_versions where id=$7 and run_id=$1`,
          [
            input.run_id,
            input.execution_id,
            kind,
            body,
            contentHash(body),
            Buffer.byteLength(body),
            input.document_version_id,
          ],
        );
      }
      await client.query(
        `insert into provider_usage(run_id,step_execution_id,provider,model,operation,request_id,input_units,output_units,cost_micros,latency_ms) values($1,$2,$3,$4,'final_coherence_export',$5,$6,$7,$8,$9)`,
        [
          input.run_id,
          input.execution_id,
          input.provider,
          input.model,
          request.operation_id,
          response.usage.input_units,
          response.usage.output_units,
          response.usage.cost_micros,
          response.usage.latency_ms ?? null,
        ],
      );
      await client.query(
        `insert into provider_operations(operation_id,run_id,document_version_id,step_execution_id,operation,content_hash) values($1,$2,$3,$4,'final_coherence_export',$5)`,
        [
          request.operation_id,
          input.run_id,
          input.document_version_id,
          input.execution_id,
          canonicalHash(response),
        ],
      );
      const blockers = response.findings.some((finding) => finding.severity === "blocker");
      if (blockers && run.coherence_return_cycles >= 2) {
        await client.query(
          `update step_executions set status='blocked',lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=$1`,
          [input.execution_id],
        );
        await client.query(
          `update runs set status='blocked',current_step='final_coherence_export',block_reason='coherence_cycle_cap',updated_at=clock_timestamp() where id=$1`,
          [input.run_id],
        );
        return "blocked";
      }
      if (blockers) {
        await this.requireFenceClient(
          client,
          "select complete_step_execution($1,$2) changed",
          input.execution_id,
          input.token,
        );
        await client.query(
          `update runs set coherence_return_cycles=coherence_return_cycles+1,status='running',current_step='revision_pass',block_reason=null,updated_at=clock_timestamp() where id=$1`,
          [input.run_id],
        );
        return "revise";
      }
      return "export";
    });
  }

  async completeFinal(
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, runId, executionId, token);
      const exported = await client.query(
        "select 1 from exports where run_id=$1 and document_version_id=$2 and status='succeeded'",
        [runId, documentVersionId],
      );
      if (!exported.rows[0]) throw new Error("Final export is incomplete");
      await this.requireFenceClient(
        client,
        "select complete_step_execution($1,$2) changed",
        executionId,
        token,
      );
      await client.query(
        `update runs set status='succeeded',current_step='final_coherence_export',block_reason=null,updated_at=clock_timestamp() where id=$1`,
        [runId],
      );
    });
  }

  /**
   * One filtered page of run history.
   *
   * The filter, the count and the page all run in SQL: the table can hold every
   * run a local operator has ever started, so loading it to slice in memory
   * would get slower with every run. Ordering carries an id tie-breaker, without
   * which two runs created in the same millisecond could swap places between
   * pages and hide a row.
   */
  async listRunPage(query: RunListQuery): Promise<RunListPage> {
    const statuses = [...RUN_LIST_FILTER_STATUSES[query.filter]];
    const total = await this.pool.query<{ count: number }>(
      "select count(*)::int count from runs where status = any($1::run_status[])",
      [statuses],
    );
    const result = await this.pool.query<{
      id: string;
      plane_ticket: string;
      handoff: Handoff;
      status: string;
      current_step: PipelineStepId | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select id,plane_ticket,handoff,status,current_step,created_at,updated_at
       from runs where status = any($1::run_status[])
       order by created_at desc,id desc limit $2 offset $3`,
      [statuses, query.limit, runListOffset(query)],
    );
    return RunListPageSchema.parse({
      runs: result.rows.map((row) => ({
        run_id: row.id,
        plane_ticket: row.plane_ticket,
        primary_keyword: row.handoff.primary_keyword,
        status: row.status,
        current_step: row.current_step,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      pagination: runListPagination({
        page: query.page,
        limit: query.limit,
        total_items: total.rows[0]!.count,
      }),
      filter: query.filter,
    });
  }

  async listRuns(limit: number) {
    const result = await this.pool.query<{
      id: string;
      plane_ticket: string;
      handoff: Handoff;
      status: string;
      current_step: PipelineStepId | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select id,plane_ticket,handoff,status,current_step,created_at,updated_at
       from runs order by created_at desc limit $1`,
      [limit],
    );
    return result.rows.map((row) =>
      RunSummarySchema.parse({
        run_id: row.id,
        plane_ticket: row.plane_ticket,
        primary_keyword: row.handoff.primary_keyword,
        status: row.status,
        current_step: row.current_step,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      }),
    );
  }

  async getUsageTotals(runId: string) {
    const exists = await this.pool.query("select 1 from runs where id=$1", [runId]);
    if (!exists.rows[0]) throw new NotFoundError("The run was not found.");
    const row = (
      await this.pool.query<{ input_units: number; output_units: number; cost_micros: number }>(
        `select coalesce(sum(input_units),0)::int input_units,coalesce(sum(output_units),0)::int output_units,coalesce(sum(cost_micros),0)::bigint::int cost_micros from provider_usage where run_id=$1`,
        [runId],
      )
    ).rows[0]!;
    return UsageTotalsSchema.parse(row);
  }

  async recoverDeterministicBlock(runId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const changed = await client.query(
        `update runs r set status='running',current_step='revision_pass',block_reason=null,
           deterministic_repair_cycles=deterministic_repair_cycles+1,updated_at=clock_timestamp()
         where r.id=$1 and r.status='blocked' and r.block_reason='deterministic_blockers'
           and r.deterministic_repair_cycles<2
           and exists (
             select 1 from document_versions d
             join deterministic_reruns rr on rr.run_id=d.run_id and rr.document_version_id=d.id
             join step_executions e on e.id=rr.step_execution_id and e.run_id=rr.run_id
             where d.run_id=r.id
               and d.revision=(select max(latest.revision) from document_versions latest where latest.run_id=r.id)
               and e.step='automated_checks_rerun' and e.status='succeeded'
               and exists (
                 select 1 from findings f
                 where f.run_id=rr.run_id and f.document_version_id=rr.document_version_id
                   and f.step_execution_id=rr.step_execution_id and f.severity='blocker'
               )
           )`,
        [runId],
      );
      if (changed.rowCount === 1) await this.enqueueRunClient(client, runId, {});
      return changed.rowCount === 1;
    });
  }

  async authoriseExceptionalCorrection(input: {
    run_id: string;
    idempotency_key: string;
    explicit_confirmation: true;
  }): Promise<"authorised" | "replay"> {
    return this.transaction(async (client) => {
      await client.query("select id from runs where id=$1 for update", [input.run_id]);
      const replay = await client.query<{ run_id: string; idempotency_key: string }>(
        `select run_id,idempotency_key from exceptional_correction_authorisations
         where idempotency_key=$1 or run_id=$2
         order by (idempotency_key=$1) desc limit 1`,
        [input.idempotency_key, input.run_id],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (
          existing.idempotency_key === input.idempotency_key &&
          existing.run_id === input.run_id
        ) {
          // Replay is purely observational, exactly as the in-memory repository
          // behaves: it must not reopen a blocked child, change the run status,
          // current step, block reason, document version, blocker set or
          // revision operation, and it must not extend the one-time correction.
          return "replay" as const;
        }
        if (existing.idempotency_key === input.idempotency_key)
          throw new ConflictError("Authorisation key conflict");
        if (existing.run_id === input.run_id)
          throw new ConflictError("The run already has an exceptional authorisation.");
      }
      const authority = (
        await client.query<{
          document_version_id: string;
          step_execution_id: string;
          blocker_set_hash: string;
          blocker_count: number;
        }>(
          `select rr.document_version_id,rr.step_execution_id,
             encode(digest(string_agg(f.id::text||':'||f.rule_reference||':'||f.location::text,'|' order by f.created_at,f.stable_key),'sha256'),'hex') blocker_set_hash,
             count(*)::int blocker_count
           from runs r
           join document_versions d on d.run_id=r.id and d.revision=(select max(x.revision) from document_versions x where x.run_id=r.id)
           join deterministic_reruns rr on rr.run_id=d.run_id and rr.document_version_id=d.id
           join step_executions e on e.id=rr.step_execution_id and e.run_id=rr.run_id and e.step='automated_checks_rerun' and e.status='succeeded'
           join findings f on f.run_id=rr.run_id and f.document_version_id=rr.document_version_id and f.step_execution_id=rr.step_execution_id and f.severity='blocker'
           where r.id=$1 and r.status='blocked' and r.block_reason='deterministic_blockers' and r.deterministic_repair_cycles=2
             and not exists(select 1 from exceptional_correction_authorisations a where a.run_id=r.id)
           group by rr.document_version_id,rr.step_execution_id,rr.retained_blockers,rr.introduced_blockers
           having count(*)=rr.retained_blockers+rr.introduced_blockers`,
          [input.run_id],
        )
      ).rows[0];
      const draft = authority ? await this.getDraft(input.run_id) : null;
      const blockerRows = authority
        ? (
            await client.query<ExceptionalCorrectionFinding>(
              `select id,stable_key,category,rule_reference,severity,location,issue,evidence,suggested_fix from findings
               where run_id=$1 and document_version_id=$2 and step_execution_id=$3 and severity='blocker'
               order by created_at,stable_key`,
              [input.run_id, authority.document_version_id, authority.step_execution_id],
            )
          ).rows
        : [];
      // Authorisation must freeze the same exclusions execution will apply,
      // otherwise it could record authority over a rejected paragraph that the
      // planner then refuses — and an operator-visible authorisation would name
      // prose the operator had already rejected.
      const rejectedForAuthority = authority
        ? (
            await client.query<{ location: unknown }>(
              `select f.location from findings f
               join finding_dispositions d on d.finding_id=f.id and d.run_id=f.run_id
               where f.run_id=$1 and f.document_version_id=$2 and d.decision='rejected'`,
              [input.run_id, authority.document_version_id],
            )
          ).rows.map((row) => row.location as FindingLocation)
        : [];
      const links = draft ? await this.getLinksArtifact(input.run_id) : null;
      const preview = draft
        ? previewExceptionalCorrection({
            draft: draft.draft,
            handoff: await this.getHandoff(input.run_id),
            documentVersionId: authority!.document_version_id,
            findings: blockerRows,
            exclusions: revisionBindingExclusions({
              document: draft.draft,
              rejectedLocations: rejectedForAuthority,
            }),
            ...(links?.body ? { internalLinks: links.body } : {}),
          })
        : null;
      const bindings = preview?.bindings ?? null;
      if (!input.explicit_confirmation || !authority || !bindings)
        throw new ConflictError("Exceptional correction is not available for this exact document.");
      await client.query(
        `insert into exceptional_correction_authorisations(run_id,document_version_id,deterministic_rerun_step_execution_id,idempotency_key,blocker_set_hash,blocker_bindings,explicit_confirmation)
         values($1,$2,$3,$4,$5,$6::jsonb,true)`,
        [
          input.run_id,
          authority.document_version_id,
          authority.step_execution_id,
          input.idempotency_key,
          authority.blocker_set_hash,
          JSON.stringify(bindings),
        ],
      );
      await client.query(
        "update runs set status='running',current_step='revision_pass',block_reason=null,updated_at=clock_timestamp() where id=$1",
        [input.run_id],
      );
      await this.enqueueRunClient(client, input.run_id, {});
      return "authorised" as const;
    });
  }

  async getRunDetail(runId: string) {
    const run = (
      await this.pool.query<any>(
        "select id,status,current_step,coherence_return_cycles,deterministic_repair_cycles,block_reason,updated_at from runs where id=$1",
        [runId],
      )
    ).rows[0];
    if (!run) throw new NotFoundError("The run was not found.");
    const executions = (
      await this.pool.query<any>(
        "select id,step,attempt,status,error->>'message' error from step_executions where run_id=$1 order by created_at,attempt",
        [runId],
      )
    ).rows;
    const current = await this.getDraft(runId);
    const linksArtifact = await this.getLinksArtifact(runId);
    const draftOperation = (
      await this.pool.query<{ status: string }>(
        "select status from draft_operation_states where run_id=$1 order by created_at desc limit 1",
        [runId],
      )
    ).rows[0];
    const paidOperationRows = (
      await this.pool.query<{
        operation_id: string;
        kind: "draft" | "review" | "revision" | "coherence";
        owner: string;
      }>(
        `select d.operation_id,'draft' kind,'step_execution:'||d.producing_step_execution_id::text owner
           from draft_operation_states d left join step_executions e on e.id=d.producing_step_execution_id
          where d.run_id=$1 and d.status='provider_in_flight'
         union all
         select o.operation_id,'review','step_execution:'||o.producing_step_execution_id::text
           from review_operation_states o
          where o.run_id=$1 and o.status='provider_in_flight'
         union all
         select v.operation_id,'revision','step_execution:'||v.producing_step_execution_id::text
           from revision_operation_states v
          where v.run_id=$1 and v.status='provider_in_flight'
         union all
         select c.operation_id,'coherence','step_execution:'||c.producing_step_execution_id::text
           from coherence_checkpoints c
          where c.run_id=$1 and c.status='provider_in_flight'
         order by kind,operation_id`,
        [runId],
      )
    ).rows;
    const paidOperationAmbiguities = paidOperationRows.map((row) =>
      PaidOperationProjectionSchema.parse(paidOperationAmbiguity(row)),
    );
    const serpRow = (
      await this.pool.query<{
        evidence_id: string;
        handoff_hash: string;
        provider: string;
        query: string;
        retrieved_at: Date;
        status: "matched" | "mismatch" | "no_results" | "failed";
        composition: unknown;
        failure_reason: string | null;
      }>(
        "select evidence_id,handoff_hash,provider,query,retrieved_at,status,composition,failure_reason from serp_evidence where run_id=$1",
        [runId],
      )
    ).rows[0];
    const serpEvidence = serpRow
      ? SerpEvidenceSchema.parse({
          ...serpRow,
          retrieved_at: serpRow.retrieved_at.toISOString(),
        })
      : null;
    const draftRecovery =
      run.status === "retryable_failed" && run.current_step === "draft" && !current
        ? draftOperation?.status === "provider_in_flight"
          ? ("ambiguous_technical_review" as const)
          : draftOperation
            ? ("none" as const)
            : ("legacy_confirmation_required" as const)
        : ("none" as const);
    const latestLinkAttempt = (
      await this.pool.query<{ metadata: unknown }>(
        `select metadata from link_discovery_attempts where run_id=$1 order by created_at desc limit 1`,
        [runId],
      )
    ).rows[0];
    const counts = (
      await this.pool.query<any>(
        `select (select count(*)::int from findings where run_id=$1 and document_version_id=$2 and severity='warning') warnings,(select count(*)::int from claims where run_id=$1 and document_version_id=$2 and status='unverified') unverified,(select count(*)::int from claims where run_id=$1 and document_version_id=$2 and hard_flag) hard_flags,(select count(*)::int from finding_dispositions where run_id=$1 and decision='rejected') rejected_findings`,
        [runId, current?.version.id ?? null],
      )
    ).rows[0];
    const exported = (
      await this.pool.query<any>(
        `select status,external_url from export_operations where run_id=$1 order by created_at desc limit 1`,
        [runId],
      )
    ).rows[0];
    const blockEvidence = (
      await this.pool.query<{
        deterministic_blockers: number;
        coherence_blockers: number;
      }>(
        `select
           coalesce((select retained_blockers+introduced_blockers from deterministic_reruns
             where run_id=$1 and document_version_id=$2),0)::int deterministic_blockers,
           (select count(*)::int from findings f join step_executions e on e.id=f.step_execution_id
             where f.run_id=$1 and f.document_version_id=$2
               and e.step='final_coherence_export' and f.severity='blocker') coherence_blockers`,
        [runId, current?.version.id ?? null],
      )
    ).rows[0] ?? { deterministic_blockers: 0, coherence_blockers: 0 };
    const blockReason: RunBlockReason | "unknown" = run.block_reason ?? "unknown";
    const exceptional = (
      await this.pool.query<{ document_version_id: string }>(
        "select document_version_id from exceptional_correction_authorisations where run_id=$1",
        [runId],
      )
    ).rows[0];
    const exceptionalBlockers = current
      ? (
          await this.pool.query<ExceptionalCorrectionFinding & { location: FindingLocation }>(
            `select f.id,f.stable_key,f.category,f.rule_reference,f.severity,f.location,f.issue,f.evidence,f.suggested_fix
               from findings f join deterministic_reruns rr on rr.step_execution_id=f.step_execution_id
              where f.run_id=$1 and f.document_version_id=$2 and f.severity='blocker'
              order by f.created_at,f.stable_key`,
            [runId, current.version.id],
          )
        ).rows
      : [];
    const rejectedLocations = current
      ? (
          await this.pool.query<{ location: FindingLocation }>(
            `select f.location from findings f
               join finding_dispositions d on d.finding_id=f.id and d.run_id=f.run_id
              where f.run_id=$1 and f.document_version_id=$2 and d.decision='rejected'`,
            [runId, current.version.id],
          )
        ).rows.map((row) => row.location)
      : [];
    const exceptionalPreview =
      current && exceptionalBlockers.length === blockEvidence.deterministic_blockers
        ? previewExceptionalCorrection({
            draft: current.draft,
            handoff: await this.getHandoff(runId),
            documentVersionId: current.version.id,
            findings: exceptionalBlockers,
            exclusions: revisionBindingExclusions({
              document: current.draft,
              rejectedLocations,
            }),
            ...(linksArtifact?.body ? { internalLinks: linksArtifact.body } : {}),
          })
        : null;
    const steps = PIPELINE_STEPS.flatMap((definition) => {
      const rows = executions.filter((item: any) => item.step === definition.id);
      return (
        rows.length
          ? rows
          : [
              {
                id: `pending:${definition.id}`,
                step: definition.id,
                attempt: 1,
                status: "queued",
                error: null,
              },
            ]
      ).map((item: any) => ({
        id: item.id,
        step: item.step,
        number: definition.number,
        name: definition.name,
        attempt: item.attempt,
        status: item.status,
        error: item.error ?? null,
      }));
    });
    return RunDetailSchema.parse({
      run_id: run.id,
      status: run.status,
      current_step: run.current_step,
      updated_at: run.updated_at.toISOString(),
      coherence_return_cycles: run.coherence_return_cycles,
      deterministic_repair_cycles: run.deterministic_repair_cycles,
      steps,
      current_document: current
        ? {
            version: current.version,
            artifact: current.artifact,
            draft: current.draft,
            legacy_derived_fields: current.legacy_derived_fields,
          }
        : null,
      counts,
      usage: await this.getUsageTotals(runId),
      link_discovery: {
        shortlist: linksArtifact?.body ?? [],
        metadata:
          linksArtifact?.metadata ??
          (latestLinkAttempt?.metadata
            ? LinkDiscoveryMetadataSchema.parse(latestLinkAttempt.metadata)
            : null),
      },
      export: {
        status: exported?.status ?? "not_started",
        external_url: exported?.external_url ?? null,
      },
      // "running" is never a live in-process state here — there is no background
      // worker, so it always means the run is resting between synchronous,
      // externally-triggered steps (e.g. straight after findings review
      // concludes) and needs the operator to trigger the next one explicitly.
      // A run waiting at 1.9 whose dispositions are recorded (step succeeded)
      // is exactly that: resting, ready for the operator to continue.
      can_retry:
        (run.status === "retryable_failed" && draftRecovery !== "ambiguous_technical_review") ||
        run.status === "running" ||
        (run.status === "waiting" &&
          executions.some(
            (item: any) => item.step === "findings_review" && item.status === "succeeded",
          )) ||
        (exported?.status === "failed" && run.status !== "blocked"),
      draft_recovery: draftRecovery,
      blocked_for_operator: run.status === "blocked" || paidOperationAmbiguities.length > 0,
      paid_operation_ambiguities: paidOperationAmbiguities,
      serp_probe: {
        status: serpEvidence?.status ?? "pending",
        evidence: serpEvidence,
        warning: serpEvidence ? serpWarning(serpEvidence) : null,
      },
      can_recover_deterministic_block:
        run.status === "blocked" &&
        blockReason === "deterministic_blockers" &&
        run.deterministic_repair_cycles < 2 &&
        blockEvidence.deterministic_blockers > 0,
      exceptional_correction: {
        available:
          run.status === "blocked" &&
          blockReason === "deterministic_blockers" &&
          run.deterministic_repair_cycles === 2 &&
          !exceptional &&
          blockEvidence.deterministic_blockers > 0 &&
          exceptionalPreview !== null,
        authorised: Boolean(exceptional),
        requires_ai: exceptionalPreview?.requires_ai ?? null,
      },
      block_reason: blockReason,
      block_counts: blockEvidence,
      fact_evidence_sources: (
        await this.pool.query<any>(
          "select uri,retrieved_at,content_hash,snapshot from sources where run_id=$1 order by created_at",
          [runId],
        )
      ).rows.flatMap((source: any) => projectEvidenceSource(source)),
      deterministic_blocker_details: current
        ? (
            await this.pool.query<{
              rule_reference: string;
              location: Record<string, unknown>;
              issue: string;
              suggested_fix: string;
            }>(
              `select f.rule_reference,f.location,f.issue,f.suggested_fix from findings f
               join step_executions e on e.id=f.step_execution_id
               where f.run_id=$1 and f.document_version_id=$2
                 and e.step='automated_checks_rerun' and f.severity='blocker'
               order by f.created_at,f.stable_key`,
              [runId, current.version.id],
            )
          ).rows
        : [],
    });
  }

  private async saveFindingsClient(
    client: PoolClient,
    runId: string,
    documentVersionId: string,
    executionId: string,
    token: string,
    findings: Array<ReviewFinding & { hard_flag: boolean }>,
    identity: string,
    complete: boolean,
  ): Promise<void> {
    await this.assertFence(client, runId, executionId, token);
    const step = (
      await client.query<{ step: PipelineStepId }>("select step from step_executions where id=$1", [
        executionId,
      ])
    ).rows[0]?.step;
    if (!step) throw new Error("Unknown execution");
    const existing = await client.query<{ content_hash: string }>(
      "select content_hash from step_outputs where run_id=$1 and document_version_id=$2 and step=$3",
      [runId, documentVersionId, step],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].content_hash !== identity)
        throw new Error("Immutable findings conflict");
      return;
    }
    await this.insertFindingsClient(client, runId, documentVersionId, executionId, findings);
    await client.query(
      "insert into step_outputs(run_id,document_version_id,step,step_execution_id,content_hash) values($1,$2,$3,$4,$5)",
      [runId, documentVersionId, step, executionId, identity],
    );
    if (complete) await this.completeOutputStepClient(client, runId, executionId, token, step);
  }

  private async completeOutputStepClient(
    client: PoolClient,
    runId: string,
    executionId: string,
    token: string,
    step: PipelineStepId,
  ): Promise<void> {
    await this.requireFenceClient(
      client,
      "select complete_step_execution($1,$2) changed",
      executionId,
      token,
    );
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
    const next = order[Math.min(order.indexOf(step) + 1, order.length - 1)]!;
    await client.query(
      "update runs set status='running',current_step=$2,block_reason=null,updated_at=clock_timestamp() where id=$1",
      [runId, next],
    );
  }

  private async insertFindingsClient(
    client: PoolClient,
    runId: string,
    documentVersionId: string,
    executionId: string,
    findings: Array<ReviewFinding & { hard_flag: boolean }>,
  ): Promise<void> {
    for (const finding of findings)
      await client.query(
        `insert into findings(run_id,document_version_id,step_execution_id,stable_key,category,rule_reference,severity,location,issue,evidence,suggested_fix,hard_flag) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
        [
          runId,
          documentVersionId,
          executionId,
          finding.stable_key,
          finding.category,
          finding.rule_reference,
          finding.severity,
          JSON.stringify(finding.location),
          finding.issue,
          finding.evidence ?? null,
          finding.suggested_fix,
          finding.hard_flag,
        ],
      );
  }

  private async findIngestClient(client: PoolClient, key: string) {
    const result = await client.query<{
      id: string;
      input_hash: string;
      handoff: Handoff;
      body_text: string | null;
    }>(
      `select r.id,r.input_hash,r.handoff,a.body_text from runs r
       left join artifacts a on a.run_id=r.id and a.kind='ingest_result' where r.idempotency_key=$1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    const value = IngestResultSchema.parse({
      run_id: row.id,
      input_hash: row.input_hash,
      handoff: HandoffSchema.parse(row.handoff),
      warnings: row.body_text
        ? ((JSON.parse(row.body_text) as { warnings?: unknown }).warnings ?? [])
        : [],
    });
    return { key, input_hash: row.input_hash, result: value };
  }
  private safeFailureMessage(value: string): string {
    const known = [
      "Revision removed the handoff primary keyword intent",
      "Revision introduced, removed or altered an unsupported factual claim",
      "Revision altered",
      "Duplicate accepted finding",
      "Pipeline operation failed safely",
      // Bounded Step 1.12 diagnostics contain only stage/category/reason codes,
      // never provider bodies, prompts, tokens or document content.
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
  private async assertFence(client: PoolClient, runId: string, executionId: string, token: string) {
    const r = await client.query(
      "select 1 from step_executions where id=$1 and run_id=$2 and status='running' and lease_token=$3 and lease_expires_at>clock_timestamp() for update",
      [executionId, runId, token],
    );
    if (!r.rows[0]) throw new Error("Stale fencing token");
  }
  private async requireFenceClient(client: PoolClient, sql: string, ...values: unknown[]) {
    const r = await client.query<{ changed: boolean }>(sql, values);
    if (!r.rows[0]?.changed) throw new Error("Stale or expired fencing token");
  }
  async enqueueRun(runId: string, options: QueueOptions = {}): Promise<void> {
    const parsed = QueueOptionsSchema.parse(options);
    await this.transaction((client) => this.enqueueRunClient(client, runId, parsed));
  }

  configureEditorialCorrection(handler: (runId: string) => Promise<unknown>): void {
    this.editorialCorrectionHandler = handler;
  }

  async claimNextSerpWork(owner: string, leaseMs: number): Promise<SerpProbeWork | null> {
    if (!owner.trim() || leaseMs <= 0) throw new Error("SERP lease claim is invalid");
    const token = randomUUID();
    const row = (
      await this.pool.query<{
        command_id: string;
        run_id: string;
        handoff_hash: string;
        previous_status: string;
        lease_expires_at: Date;
      }>(
        `with candidate as (
           select command_id,status previous_status
             from run_command_outbox c
            where kind='probe_serp'
              and (status='pending' or (status='processing' and lease_expires_at<=clock_timestamp()))
              and not exists(select 1 from serp_evidence e where e.run_id=c.run_id and e.handoff_hash=c.payload->>'handoff_hash')
            order by created_at limit 1 for update skip locked
         )
         update run_command_outbox c
            set status='processing',lease_owner=$1,lease_token=$2,
                lease_expires_at=clock_timestamp()+($3::text||' milliseconds')::interval,
                updated_at=clock_timestamp()
           from candidate
          where c.command_id=candidate.command_id
         returning c.command_id,c.run_id,c.payload->>'handoff_hash' handoff_hash,
                   candidate.previous_status,c.lease_expires_at`,
        [owner, token, leaseMs],
      )
    ).rows[0];
    if (!row) return null;
    return {
      run_id: row.run_id,
      handoff_hash: row.handoff_hash,
      command_id: row.command_id,
      mode: row.previous_status === "processing" ? "recover_without_dispatch" : "dispatch",
      lease_owner: owner,
      lease_token: token,
      lease_expires_at: row.lease_expires_at.toISOString(),
    };
  }

  async heartbeatSerpWork(rawWork: SerpProbeWork, leaseMs: number): Promise<void> {
    const work = SerpProbeWorkSchema.parse(rawWork);
    const updated = await this.pool.query(
      `update run_command_outbox set lease_expires_at=clock_timestamp()+($5::text||' milliseconds')::interval,updated_at=clock_timestamp()
        where command_id=$1 and run_id=$2 and kind='probe_serp' and status='processing'
          and payload->>'handoff_hash'=$3 and lease_owner=$4 and lease_token=$6
          and lease_expires_at>clock_timestamp()`,
      [
        work.command_id,
        work.run_id,
        work.handoff_hash,
        work.lease_owner,
        leaseMs,
        work.lease_token,
      ],
    );
    if (updated.rowCount !== 1) throw new Error("SERP lease fencing rejected heartbeat");
  }

  async getSerpProbeHandoff(rawWork: SerpProbeWork): Promise<Handoff> {
    const work = SerpProbeWorkSchema.parse(rawWork);
    const row = (
      await this.pool.query<{ handoff: unknown; input_hash: string }>(
        `select r.handoff,r.input_hash
           from runs r join run_command_outbox c on c.run_id=r.id
          where r.id=$1 and c.command_id=$2 and c.kind='probe_serp'
            and c.payload->>'handoff_hash'=$3`,
        [work.run_id, work.command_id, work.handoff_hash],
      )
    ).rows[0];
    if (!row) throw new Error("SERP work command identity mismatch");
    if (row.input_hash !== work.handoff_hash) throw new Error("SERP handoff hash mismatch");
    return HandoffSchema.parse(row.handoff);
  }

  async recordSerpEvidence(rawWork: SerpProbeWork, raw: SerpEvidence): Promise<void> {
    const work = SerpProbeWorkSchema.parse(rawWork);
    const evidence = SerpEvidenceSchema.parse(raw);
    if (evidence.handoff_hash !== work.handoff_hash) throw new Error("SERP handoff hash mismatch");
    await this.transaction(async (client) => {
      const command = (
        await client.query<{
          status: string;
          lease_owner: string | null;
          lease_token: string | null;
          lease_expires_at: Date | null;
        }>(
          `select status,lease_owner,lease_token,lease_expires_at from run_command_outbox
            where command_id=$1 and run_id=$2 and kind='probe_serp'
              and payload->>'handoff_hash'=$3 for update`,
          [work.command_id, work.run_id, work.handoff_hash],
        )
      ).rows[0];
      if (!command) throw new Error("SERP work command identity mismatch");

      const existingRow = (
        await client.query<{
          evidence_id: string;
          handoff_hash: string;
          provider: string;
          query: string;
          retrieved_at: Date;
          status: "matched" | "mismatch" | "no_results" | "failed";
          composition: unknown;
          failure_reason: string | null;
        }>(
          `select evidence_id,handoff_hash,provider,query,retrieved_at,status,composition,failure_reason
             from serp_evidence where run_id=$1 and handoff_hash=$2`,
          [work.run_id, work.handoff_hash],
        )
      ).rows[0];
      if (
        command.lease_owner !== work.lease_owner ||
        command.lease_token !== work.lease_token ||
        !command.lease_expires_at ||
        command.lease_expires_at.getTime() <= Date.now()
      ) {
        // Observation-only replay after terminal completion keeps the original evidence.
        if (existingRow && (command.status === "succeeded" || command.status === "failed")) {
          const existing = SerpEvidenceSchema.parse({
            ...existingRow,
            retrieved_at: existingRow.retrieved_at.toISOString(),
          });
          if (canonicalHash(existing) !== canonicalHash(evidence))
            throw new Error("Immutable SERP evidence conflict");
          return;
        }
        throw new Error("SERP completion requires a matching lease fence");
      }
      if (existingRow) {
        const existing = SerpEvidenceSchema.parse({
          ...existingRow,
          retrieved_at: existingRow.retrieved_at.toISOString(),
        });
        if (canonicalHash(existing) !== canonicalHash(evidence))
          throw new Error("Immutable SERP evidence conflict");
        return;
      }
      if (
        command.status !== "processing" ||
        !command.lease_expires_at ||
        command.lease_expires_at.getTime() <= Date.now()
      )
        throw new Error("SERP completion requires a matching unexpired lease fence");

      await client.query(
        `insert into serp_evidence(evidence_id,run_id,handoff_hash,provider,query,retrieved_at,status,composition,failure_reason)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          evidence.evidence_id,
          work.run_id,
          evidence.handoff_hash,
          evidence.provider,
          evidence.query,
          evidence.retrieved_at,
          evidence.status,
          evidence.composition ? JSON.stringify(evidence.composition) : null,
          evidence.failure_reason,
        ],
      );
      const completed = await client.query(
        `update run_command_outbox set status='succeeded',terminal_result=jsonb_build_object('run_id',run_id::text,'queue_accepted',false,'result',jsonb_build_object('evidence_id',$2::text)),completed_at=clock_timestamp(),lease_owner=null,lease_token=null,lease_expires_at=null
         where command_id=$1 and run_id=$3 and kind='probe_serp' and status='processing'
           and payload->>'handoff_hash'=$4 and lease_owner=$5 and lease_token=$6
           and lease_expires_at>clock_timestamp()`,
        [
          work.command_id,
          evidence.evidence_id,
          work.run_id,
          work.handoff_hash,
          work.lease_owner,
          work.lease_token,
        ],
      );
      if (completed.rowCount !== 1)
        throw new Error("SERP completion requires exactly one claimed processing row");
    });
  }

  async findCommand(idempotencyKey: string) {
    const row = await this.pool.query<{ payload: unknown }>(
      "select payload from run_command_outbox where idempotency_key=$1",
      [idempotencyKey],
    );
    return row.rows[0] ? parseRunCommand(row.rows[0].payload) : null;
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
    return this.transaction(async (client) => {
      const existing = await client.query<{
        command_id: string;
        run_id: string | null;
        payload_hash: string;
        payload: unknown;
        terminal_result: unknown;
      }>(
        "select command_id,run_id,payload_hash,payload,terminal_result from run_command_outbox where idempotency_key=$1 for update",
        [command.idempotency_key],
      );
      const row = existing.rows[0];
      if (row) {
        if (
          row.payload_hash !== expectedHash ||
          commandPayloadHash(parseRunCommand(row.payload)) !== expectedHash
        )
          throw new RepositoryConflictError(
            "The command idempotency key is bound to different input.",
          );
        const terminal = z
          .object({ run_id: z.string(), queue_accepted: z.boolean(), result: z.unknown() })
          .strict()
          .parse(row.terminal_result);
        return CommandSubmissionResultSchema.parse({
          command_id: row.command_id,
          run_id: terminal.run_id,
          replayed: true,
          queue_accepted: terminal.queue_accepted,
          result: terminal.result,
        });
      }

      let runId = "run_id" in command ? command.run_id : "";
      let result: unknown;
      let queueAccepted = false;
      switch (command.kind) {
        case "create_run": {
          const created = await this.createIngest(
            command.idempotency_key,
            canonicalHash(command.handoff),
            command.handoff,
            command.warnings,
          );
          runId = created.run_id;
          result = created;
          queueAccepted = true;
          const handoffHash = canonicalHash(command.handoff);
          const probeId = stableId("command", "probe-serp", runId, handoffHash);
          const probeBase = {
            command_id: probeId,
            idempotency_key: `probe_serp:${runId}:${handoffHash}`,
            payload_hash: "0".repeat(64),
            requested_at: command.requested_at,
            kind: "probe_serp" as const,
            run_id: runId,
            handoff_hash: handoffHash,
          };
          const probe = { ...probeBase, payload_hash: commandPayloadHash(probeBase) };
          await client.query(
            `insert into run_command_outbox(command_id,run_id,kind,idempotency_key,payload_hash,payload,status,terminal_result,completed_at)
             values($1,$2,'probe_serp',$3,$4,$5::jsonb,'pending',null,null)`,
            [
              probe.command_id,
              runId,
              probe.idempotency_key,
              probe.payload_hash,
              JSON.stringify(probe),
            ],
          );
          break;
        }
        case "resume_run": {
          const state = await client.query<{ status: string }>(
            "select status from runs where id=$1 for update",
            [runId],
          );
          if (!state.rows[0]) throw new NotFoundError("The run was not found.");
          const recovered =
            state.rows[0].status === "blocked"
              ? await this.recoverDeterministicBlock(runId)
              : false;
          if (state.rows[0].status === "blocked" && !recovered)
            throw new ConflictError(
              "Only a deterministic blocker with remaining correction budget can be resumed.",
            );
          if (!recovered)
            await this.enqueueRunClient(client, runId, QueueOptionsSchema.parse(command.options));
          result = { queued: true, deterministic_recovery: recovered };
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
            explicit_confirmation: command.explicit_confirmation,
          });
          result = { outcome };
          queueAccepted = outcome === "authorised";
          break;
        }
        case "probe_serp": {
          const source = await client.query<{ input_hash: string }>(
            "select input_hash from runs where id=$1",
            [runId],
          );
          if (source.rows[0]?.input_hash !== command.handoff_hash)
            throw new ConflictError("SERP handoff hash mismatch.");
          result = { queued: true };
          queueAccepted = false;
          break;
        }
        case "retry_export": {
          const eligible = await client.query(
            `select 1 from runs r
             join lateral (select status,error from step_executions where run_id=r.id and step='final_coherence_export' order by attempt desc limit 1) e on true
             where r.id=$1 and r.status='retryable_failed' and r.current_step='final_coherence_export'
               and e.status='retryable_failed' and e.error->>'message' like '%STEP_1_12_FAILED;stage=google_docs_export;%'
               and exists(select 1 from export_operations x
                 where x.run_id=r.id and x.document_version_id=(select id from document_versions where run_id=r.id order by revision desc limit 1)
                   and x.status='failed')
             for update of r`,
            [runId],
          );
          if (!eligible.rows[0]) throw new ConflictError("The export is not available for retry.");
          await this.enqueueRunClient(client, runId, {});
          result = { queued: true };
          queueAccepted = true;
          break;
        }
        default:
          throw new UnprocessableError(`Command ${command.kind} is not implemented in S3.`);
      }

      await client.query(
        `insert into run_command_outbox(command_id,run_id,kind,idempotency_key,payload_hash,payload,status,terminal_result,completed_at)
         values($1,$2,$3,$4,$5,$6::jsonb,'succeeded',$7::jsonb,clock_timestamp())`,
        [
          command.command_id,
          command.kind === "create_run" ? null : runId,
          command.kind,
          command.idempotency_key,
          expectedHash,
          JSON.stringify(command),
          JSON.stringify({ run_id: runId, queue_accepted: queueAccepted, result }),
        ],
      );
      const sequence = (
        await client.query<{ sequence: number }>(
          "select coalesce(max(sequence),0)::int+1 sequence from run_activity_events where run_id=$1",
          [runId],
        )
      ).rows[0]!.sequence;
      const activity = parseCommandActivity({
        activity_id: `command:${command.command_id}:accepted`,
        run_id: runId,
        sequence,
        type: "command_accepted",
        occurred_at: command.requested_at,
        command_id: command.command_id,
        summary: "Command accepted.",
      });
      await client.query(
        `insert into run_activity_events(activity_id,run_id,sequence,type,command_id,summary,payload,occurred_at)
         values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          activity.activity_id,
          runId,
          sequence,
          activity.type,
          command.command_id,
          activity.summary,
          JSON.stringify(activity),
          activity.occurred_at,
        ],
      );
      return CommandSubmissionResultSchema.parse({
        command_id: command.command_id,
        run_id: runId,
        replayed: false,
        queue_accepted: queueAccepted,
        result,
      });
    });
  }

  async listCommandActivity(runId: string) {
    const rows = await this.pool.query<{ payload: unknown }>(
      "select payload from run_activity_events where run_id=$1 order by sequence",
      [runId],
    );
    return rows.rows.map((row) => parseCommandActivity(row.payload));
  }

  async claimQueueJob(owner: string, leaseMs: number): Promise<QueueLease | null> {
    if (!owner.trim() || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
      throw new Error("Invalid queue lease request");
    return this.transaction(async (client) => {
      const selected = await client.query<{ id: string; run_id: string; state: string }>(
        `select q.id,q.run_id,q.state from pipeline_queue_jobs q join runs r on r.id=q.run_id
         where r.status<>'cancelled'
           and (r.status not in ('waiting','blocked','succeeded') or q.options='{"refresh_link_discovery":true}'::jsonb)
           and (q.state='ready' or (q.state='retry_wait' and q.available_at<=clock_timestamp()) or
                (q.state='leased' and q.lease_expires_at<=clock_timestamp()))
         order by q.available_at,q.created_at for update of q skip locked limit 1`,
      );
      const candidate = selected.rows[0];
      if (!candidate) return null;
      // A queue lease is only coordination. After a worker crash it may expire before the
      // independently fenced step lease. Wait for that owner rather than creating an unsafe
      // duplicate execution or charging this coordination poll to the retry budget.
      const activeStep = await client.query(
        `select 1 from step_executions where run_id=$1 and status in ('leased','running')
         and lease_expires_at>clock_timestamp() limit 1`,
        [candidate.run_id],
      );
      if (candidate.state === "leased" && activeStep.rowCount) {
        await client.query(
          `update pipeline_queue_jobs set state='retry_wait',available_at=clock_timestamp()+interval '1 second',
           lease_token=null,lease_owner=null,lease_expires_at=null,last_error_code='step_lease_coordination_wait',
           updated_at=clock_timestamp() where id=$1`,
          [candidate.id],
        );
        return null;
      }
      const id = candidate.id;
      const token = randomUUID();
      const claimed = await client.query<{
        id: string;
        run_id: string;
        attempt: number;
        phase: "pre_downstream" | "downstream_started";
        options: unknown;
      }>(
        `update pipeline_queue_jobs set state='leased',attempt=attempt+1,lease_token=$2,lease_owner=$3,
           lease_expires_at=clock_timestamp()+($4::text)::interval,last_error_code=null,updated_at=clock_timestamp()
         where id=$1 and attempt<3 returning id,run_id,attempt,phase,options`,
        [id, token, owner, `${leaseMs} milliseconds`],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query(
          `update pipeline_queue_jobs set state='operator_action',lease_token=null,lease_owner=null,
           lease_expires_at=null,last_error_code='retry_limit',updated_at=clock_timestamp() where id=$1`,
          [id],
        );
        return null;
      }
      return {
        id: row.id,
        run_id: row.run_id,
        token,
        attempt: row.attempt,
        phase: row.phase,
        options: QueueOptionsSchema.parse(row.options),
      };
    });
  }

  async heartbeatQueueJob(jobId: string, token: string, leaseMs: number): Promise<boolean> {
    const changed = await this.pool.query(
      `update pipeline_queue_jobs set lease_expires_at=clock_timestamp()+($3::text)::interval,updated_at=clock_timestamp()
       where id=$1 and state='leased' and lease_token=$2 and lease_expires_at>clock_timestamp() returning id`,
      [jobId, token, `${leaseMs} milliseconds`],
    );
    return changed.rowCount === 1;
  }

  async closeRefreshWindow(
    jobId: string,
    token: string,
  ): Promise<"refresh_promoted" | "downstream_started" | null> {
    const changed = await this.pool.query<{ outcome: "refresh_promoted" | "downstream_started" }>(
      `with owned as (
         select id,phase,pending_refresh from pipeline_queue_jobs
         where id=$1 and state='leased' and lease_token=$2 and lease_expires_at>clock_timestamp()
         for update
       ), changed as (
         update pipeline_queue_jobs q set
          state=case when o.pending_refresh then 'ready'::queue_job_state else q.state end,
          phase=case when o.pending_refresh then 'pre_downstream'::queue_job_phase else 'downstream_started'::queue_job_phase end,
          options=case when o.pending_refresh then '{"refresh_link_discovery":true}'::jsonb else q.options end,
          resume_after_refresh=case when o.pending_refresh then true else q.resume_after_refresh end,
          attempt=case when o.pending_refresh then 0 else q.attempt end,
          available_at=case when o.pending_refresh then clock_timestamp() else q.available_at end,
          lease_token=case when o.pending_refresh then null else q.lease_token end,
          lease_owner=case when o.pending_refresh then null else q.lease_owner end,
          lease_expires_at=case when o.pending_refresh then null else q.lease_expires_at + interval '1 microsecond' end,
          last_error_code=case when o.pending_refresh then null else q.last_error_code end,
          pending_refresh=false,updated_at=clock_timestamp()
         from owned o where q.id=o.id and o.phase='pre_downstream'
         returning case when state='ready' then 'refresh_promoted' else 'downstream_started' end outcome
       )
       select outcome from changed
       union all
       select 'downstream_started'::text outcome from owned where phase='downstream_started'
       limit 1`,
      [jobId, token],
    );
    return changed.rows[0]?.outcome ?? null;
  }

  async finishQueueJob(
    jobId: string,
    token: string,
    state: "parked" | "operator_action" | "completed" | "cancelled",
    errorCode?: string,
  ): Promise<boolean> {
    const changed = await this.pool.query(
      `update pipeline_queue_jobs set
       state=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then 'ready'::queue_job_state else $3::queue_job_state end,
       options=case when resume_after_refresh and $3<>'cancelled' then '{}'::jsonb when pending_refresh and $3<>'cancelled' then '{"refresh_link_discovery":true}'::jsonb when pending_options<>'{}'::jsonb and $3<>'cancelled' then pending_options else options end,
       phase=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then 'pre_downstream'::queue_job_phase else phase end,
       pending_refresh=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then false else pending_refresh end,
       resume_after_refresh=case when resume_after_refresh and $3<>'cancelled' then false else resume_after_refresh end,
       pending_options=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then '{}'::jsonb else pending_options end,
       attempt=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then 0 else attempt end,
       available_at=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then clock_timestamp() else available_at end,
       lease_token=null,lease_owner=null,lease_expires_at=null,
       last_error_code=case when (resume_after_refresh or pending_refresh or pending_options<>'{}'::jsonb) and $3<>'cancelled' then null else $4 end,
       updated_at=clock_timestamp() where id=$1 and state='leased' and lease_token=$2 and lease_expires_at>clock_timestamp() returning id`,
      [jobId, token, state, errorCode ?? null],
    );
    return changed.rowCount === 1;
  }

  async deferQueueJob(jobId: string, token: string, delayMs: number): Promise<boolean> {
    const changed = await this.pool.query(
      `update pipeline_queue_jobs set state='retry_wait',attempt=greatest(attempt-1,0),
       available_at=clock_timestamp()+($3::text)::interval,lease_token=null,lease_owner=null,
       lease_expires_at=null,last_error_code='step_lease_coordination_wait',updated_at=clock_timestamp()
       where id=$1 and state='leased' and lease_token=$2 and lease_expires_at>clock_timestamp() returning id`,
      [jobId, token, `${Math.max(0, Math.trunc(delayMs))} milliseconds`],
    );
    return changed.rowCount === 1;
  }

  async retryQueueJob(
    jobId: string,
    token: string,
    delayMs: number,
    errorCode: string,
  ): Promise<boolean> {
    const changed = await this.pool.query(
      `update pipeline_queue_jobs set state=case when attempt<3 then 'retry_wait'::queue_job_state else 'operator_action'::queue_job_state end,
       available_at=clock_timestamp()+($3::text)::interval,lease_token=null,lease_owner=null,lease_expires_at=null,
       last_error_code=$4,updated_at=clock_timestamp() where id=$1 and state='leased' and lease_token=$2 and lease_expires_at>clock_timestamp() returning id`,
      [jobId, token, `${Math.max(0, Math.trunc(delayMs))} milliseconds`, errorCode],
    );
    return changed.rowCount === 1;
  }

  async recoverQueueJobs(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `update pipeline_queue_jobs q set
         state=case when r.status='cancelled' then 'cancelled'::queue_job_state
                    when q.pending_refresh then 'ready'::queue_job_state
                    when r.status in ('waiting','blocked') then 'parked'::queue_job_state else 'completed'::queue_job_state end,
         options=case when q.pending_refresh and r.status<>'cancelled' then '{"refresh_link_discovery":true}'::jsonb else q.options end,
         phase=case when q.pending_refresh and r.status<>'cancelled' then 'pre_downstream'::queue_job_phase else q.phase end,
         pending_refresh=case when q.pending_refresh and r.status<>'cancelled' then false else q.pending_refresh end,
         attempt=case when q.pending_refresh and r.status<>'cancelled' then 0 else q.attempt end,
         available_at=case when q.pending_refresh and r.status<>'cancelled' then clock_timestamp() else q.available_at end,
         lease_token=null,lease_owner=null,lease_expires_at=null,
         last_error_code=case when q.pending_refresh and r.status<>'cancelled' then null else 'startup_run_terminal' end,
         updated_at=clock_timestamp()
         from runs r where r.id=q.run_id and q.state in ('ready','leased','retry_wait')
         and r.status in ('waiting','blocked','succeeded','cancelled')
         and (r.status='cancelled' or q.options<>'{"refresh_link_discovery":true}'::jsonb)`,
      );
      await client.query(
        `update pipeline_queue_jobs q set state='operator_action',lease_token=null,lease_owner=null,
         lease_expires_at=null,last_error_code='legacy_review_explicit_recovery',updated_at=clock_timestamp()
         from runs r where r.id=q.run_id and q.state in ('ready','leased','retry_wait')
         and r.status='retryable_failed'
         and r.current_step in ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
         and not exists(select 1 from review_operation_states o where o.run_id=r.id)
         and q.options->'authorise_legacy_review_recovery' is distinct from 'true'::jsonb`,
      );
      await client.query(
        `update pipeline_queue_jobs set state=case when attempt<3 then 'ready'::queue_job_state else 'operator_action'::queue_job_state end,
         available_at=clock_timestamp(),lease_token=null,lease_owner=null,lease_expires_at=null,
         last_error_code='startup_lease_expired',updated_at=clock_timestamp()
         where state='leased' and lease_expires_at<=clock_timestamp()`,
      );
      await client.query(
        `update step_executions e set status='retryable_failed',lease_token=null,lease_owner=null,
         lease_expires_at=null,error='{"message":"lease expired during startup recovery"}'::jsonb,
         updated_at=clock_timestamp()
         where e.status in ('leased','running') and e.lease_expires_at<=clock_timestamp()
           and not exists(select 1 from draft_operation_states d where d.producing_step_execution_id=e.id and d.status='provider_in_flight')
           and not exists(select 1 from review_operation_states w where w.producing_step_execution_id=e.id and w.status='provider_in_flight')
           and not exists(select 1 from revision_operation_states v where v.producing_step_execution_id=e.id and v.status='provider_in_flight')
           and not exists(select 1 from coherence_checkpoints c where c.producing_step_execution_id=e.id and c.status='provider_in_flight')`,
      );
      await client.query(
        `update runs r set status='retryable_failed',current_step=e.step,updated_at=clock_timestamp()
         from step_executions e where e.run_id=r.id and e.status='retryable_failed'
           and e.error->>'message'='lease expired during startup recovery'
           and r.status='running'`,
      );
      await client.query(
        `update pipeline_queue_jobs q set state='operator_action',lease_token=null,lease_owner=null,
         lease_expires_at=null,last_error_code='ambiguous_paid_operation',updated_at=clock_timestamp()
         where q.state in ('ready','leased','retry_wait') and (
           exists(select 1 from draft_operation_states d where d.run_id=q.run_id and d.status='provider_in_flight') or
           exists(select 1 from review_operation_states w where w.run_id=q.run_id and w.status='provider_in_flight') or
           exists(select 1 from revision_operation_states v where v.run_id=q.run_id and v.status='provider_in_flight') or
           exists(select 1 from coherence_checkpoints c where c.run_id=q.run_id and c.status='provider_in_flight') or
           exists(select 1 from export_operations x where x.run_id=q.run_id and x.status='pending' and x.external_document_id is not null))`,
      );
      await client.query(
        `with resolved_commands as (
           select c.*,r.id resolved_run_id
           from run_command_outbox c
           join runs r on r.id::text=c.terminal_result->>'run_id'
             and (c.run_id=r.id or (c.run_id is null and c.kind='create_run'))
           where c.status='succeeded'
             and c.kind in ('create_run','resume_run','submit_findings','authorise_exceptional_correction','retry_export')
             and jsonb_typeof(c.terminal_result)='object'
             and c.terminal_result ?& array['run_id','queue_accepted','result']
             and not c.terminal_result ?| array['command_id','replayed']
             and (select count(*) from jsonb_object_keys(c.terminal_result))=3
             and jsonb_typeof(c.terminal_result->'run_id')='string'
             and jsonb_typeof(c.terminal_result->'queue_accepted')='boolean'
             and (c.terminal_result->>'queue_accepted')::boolean=true
         )
         insert into pipeline_queue_jobs(run_id,state,last_error_code)
         select c.resolved_run_id,
           case when exists(select 1 from draft_operation_states d where d.run_id=c.resolved_run_id and d.status='provider_in_flight')
                  or exists(select 1 from review_operation_states w where w.run_id=c.resolved_run_id and w.status='provider_in_flight')
                  or exists(select 1 from revision_operation_states v where v.run_id=c.resolved_run_id and v.status='provider_in_flight')
                  or exists(select 1 from coherence_checkpoints h where h.run_id=c.resolved_run_id and h.status='provider_in_flight')
                  or exists(select 1 from export_operations x where x.run_id=c.resolved_run_id and x.status='pending' and x.external_document_id is not null)
                then 'operator_action'::queue_job_state else 'ready'::queue_job_state end,
           case when exists(select 1 from draft_operation_states d where d.run_id=c.resolved_run_id and d.status='provider_in_flight')
                  or exists(select 1 from review_operation_states w where w.run_id=c.resolved_run_id and w.status='provider_in_flight')
                  or exists(select 1 from revision_operation_states v where v.run_id=c.resolved_run_id and v.status='provider_in_flight')
                  or exists(select 1 from coherence_checkpoints h where h.run_id=c.resolved_run_id and h.status='provider_in_flight')
                  or exists(select 1 from export_operations x where x.run_id=c.resolved_run_id and x.status='pending' and x.external_document_id is not null)
                then 'ambiguous_paid_operation' else null end
         from resolved_commands c join runs r on r.id=c.resolved_run_id
         where r.status in ('running','retryable_failed')
           and not exists(select 1 from pipeline_queue_jobs q where q.run_id=c.resolved_run_id and q.state in ('ready','leased','retry_wait','parked','operator_action'))
         on conflict do nothing`,
      );
      // Serialise sequence allocation by run, then allocate all missing projections in one stable window.
      await client.query("select id from runs order by id for update");
      await client.query(
        `with resolved_commands as (
           select c.*,r.id resolved_run_id
           from run_command_outbox c
           join runs r on r.id::text=c.terminal_result->>'run_id'
             and (c.run_id=r.id or (c.run_id is null and c.kind='create_run'))
           where c.status='succeeded'
             and jsonb_typeof(c.terminal_result)='object'
             and c.terminal_result ?& array['run_id','queue_accepted','result']
             and not c.terminal_result ?| array['command_id','replayed']
             and (select count(*) from jsonb_object_keys(c.terminal_result))=3
             and jsonb_typeof(c.terminal_result->'run_id')='string'
             and jsonb_typeof(c.terminal_result->'queue_accepted')='boolean'
         ), missing as (
           select c.resolved_run_id run_id,'command:'||c.command_id||':accepted' activity_id,'command_accepted' type,
             c.command_id,'Command accepted.' summary,c.completed_at occurred_at
           from resolved_commands c
           where not exists(select 1 from run_activity_events a where a.command_id=c.command_id)
           union all
           select r.id,'run:'||r.id||':terminal',
             case when r.status='cancelled' then 'run_cancelled' else 'export_succeeded' end,
             null,case when r.status='cancelled' then 'Run cancelled.' else 'Export succeeded.' end,r.updated_at
           from runs r where r.status in ('cancelled','succeeded')
             and not exists(select 1 from run_activity_events a where a.activity_id='run:'||r.id||':terminal')
         ), numbered as (
           select m.*,(select coalesce(max(a.sequence),0) from run_activity_events a where a.run_id=m.run_id)
             + row_number() over(partition by m.run_id order by m.occurred_at,m.activity_id) sequence
           from missing m
         )
         insert into run_activity_events(activity_id,run_id,sequence,type,command_id,summary,payload,occurred_at)
         select activity_id,run_id,sequence,type,command_id,summary,
           jsonb_strip_nulls(jsonb_build_object('activity_id',activity_id,'run_id',run_id::text,
             'sequence',sequence,'type',type,'occurred_at',occurred_at,'command_id',command_id,'summary',summary)),
           occurred_at from numbered order by run_id,sequence`,
      );
    });
  }

  async queueExecutionState(runId: string): Promise<{
    run_status: string;
    current_step: PipelineStepId | null;
    ambiguous: boolean;
    coordination_wait: boolean;
  }> {
    const result = await this.pool.query<{
      status: string;
      current_step: PipelineStepId | null;
      ambiguous: boolean;
    }>(
      `select r.status,r.current_step,
       (exists(select 1 from draft_operation_states d where d.run_id=r.id and d.status='provider_in_flight') or
        exists(select 1 from review_operation_states w where w.run_id=r.id and w.status='provider_in_flight') or
        exists(select 1 from revision_operation_states v where v.run_id=r.id and v.status='provider_in_flight') or
        exists(select 1 from coherence_checkpoints c where c.run_id=r.id and c.status='provider_in_flight') or
        exists(select 1 from export_operations x where x.run_id=r.id and x.status='pending' and x.external_document_id is not null)
       ) ambiguous from runs r where r.id=$1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError("The run was not found.");
    const coordination = await this.pool.query(
      `select 1 from step_executions where run_id=$1 and status in ('leased','running')
       and lease_expires_at>clock_timestamp() limit 1`,
      [runId],
    );
    return {
      run_status: row.status,
      current_step: row.current_step,
      ambiguous: row.ambiguous,
      coordination_wait: coordination.rowCount === 1,
    };
  }

  private async enqueueRunClient(
    client: PoolClient,
    runId: string,
    options: QueueOptions,
  ): Promise<void> {
    const parsed = QueueOptionsSchema.parse(options);
    const run = await client.query<{ status: string; current_step: PipelineStepId | null }>(
      "select status,current_step from runs where id=$1 for update",
      [runId],
    );
    if (!run.rows[0]) throw new NotFoundError("The run was not found.");
    if (["succeeded", "cancelled", "waiting", "blocked"].includes(run.rows[0].status))
      throw new ConflictError("This run is not queueable in its current state.");
    const legacyReview =
      run.rows[0].status === "retryable_failed" &&
      [
        "review_writing_style",
        "review_information_gain",
        "review_fact_checking",
        "review_link_conversion",
      ].includes(run.rows[0].current_step ?? "");
    if (legacyReview && options.authorise_legacy_review_recovery !== true)
      throw new ConflictError(
        "This historical review failure requires explicit operator recovery authorisation.",
      );
    const active = await client.query<{
      id: string;
      state: string;
      options: QueueOptions;
      pending_refresh: boolean;
      pending_options: QueueOptions;
      phase: "pre_downstream" | "downstream_started";
    }>(
      `select id,state,options,pending_refresh,pending_options,phase from pipeline_queue_jobs where run_id=$1 and state in ('ready','leased','retry_wait','parked','operator_action') for update`,
      [runId],
    );
    if (active.rows[0]) {
      if (["ready", "leased", "retry_wait"].includes(active.rows[0].state)) {
        // Never mutate options observed by an active job. Refresh has no paid-step authority
        // and is isolated from every recovery signal, including under concurrent requests.
        const signal = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => value),
        ) as QueueOptions;
        if (!Object.keys(signal).length) return;
        const row = active.rows[0];
        const sameRefresh =
          signal.refresh_link_discovery === true &&
          (row.pending_refresh || row.options.refresh_link_discovery === true);
        const sameRecovery =
          signal.refresh_link_discovery !== true &&
          Object.keys(signal).every(
            (key) =>
              row.pending_options[key as keyof QueueOptions] ||
              row.options[key as keyof QueueOptions],
          );
        const hasAuthority =
          Object.values(row.options).some(Boolean) ||
          row.pending_refresh ||
          Object.keys(row.pending_options).length > 0;
        if (hasAuthority && !sameRefresh && !sameRecovery)
          throw new ConflictError("Queue authorities must be requested separately.");
        if (sameRefresh || sameRecovery) return;
        if (signal.refresh_link_discovery) {
          if (row.phase === "downstream_started")
            throw new ConflictError(
              "Link refresh cannot be accepted after paid downstream processing has started.",
            );
          await client.query(
            `update pipeline_queue_jobs set pending_refresh=true,updated_at=clock_timestamp()
             where id=$1 and phase='pre_downstream'`,
            [row.id],
          );
        } else
          await client.query(
            `update pipeline_queue_jobs set pending_options=$2::jsonb,updated_at=clock_timestamp() where id=$1`,
            [row.id, JSON.stringify(signal)],
          );
        return;
      }
      if (legacyReview && active.rows[0].state !== "operator_action")
        throw new ConflictError("Historical review recovery is not available for this queue job.");
      await client.query(
        `update pipeline_queue_jobs set state='ready',phase='pre_downstream',attempt=0,available_at=clock_timestamp(),options=$2::jsonb,
         pending_refresh=false,pending_options='{}'::jsonb,last_error_code=null,updated_at=clock_timestamp() where id=$1`,
        [active.rows[0].id, JSON.stringify(parsed)],
      );
      return;
    }
    await client.query(`insert into pipeline_queue_jobs(run_id,options) values($1,$2::jsonb)`, [
      runId,
      JSON.stringify(parsed),
    ]);
  }

  async hasActiveQueueJob(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from pipeline_queue_jobs where run_id=$1 and state in ('ready','leased','retry_wait') limit 1",
      [runId],
    );
    return result.rowCount === 1;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active) return operation(active);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await this.transactionContext.run(client, () => operation(client));
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

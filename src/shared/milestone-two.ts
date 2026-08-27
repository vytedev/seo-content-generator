import { z } from "zod";
import { sha256 } from "./sha256.js";
import {
  ArtifactSchema,
  DocumentVersionSchema,
  StructuredDraftSchema,
  type ArtifactRecord,
  type DocumentVersionRecord,
  type StructuredDraft,
} from "./contracts/content.js";
import {
  HandoffSchema,
  PipelineStepIdSchema,
  type Handoff,
  type PipelineStepId,
} from "./pipeline.js";
import { decideIdempotency, hashIdempotencyInput } from "./worker-contracts.js";
import type { QueueOptions } from "./queue.js";
import {
  IngestResultSchema,
  IngestWarningSchema,
  SerpCompositionSchema,
  type IngestResult,
  type SerpComposition,
} from "./ingest-contracts.js";
import {
  InternalLinkSchema,
  LinkDiscoveryMetadataSchema,
  type InternalLink,
  type LinkDiscoveryMetadata,
  type LinkDiscoveryMetadataInput,
} from "./contracts/link-discovery.js";

const text = z.string().trim().min(1);

export {
  IngestResultSchema,
  IngestWarningSchema,
  SerpCompositionSchema,
  type IngestResult,
  type SerpComposition,
} from "./ingest-contracts.js";

export {
  ArtifactSchema,
  DocumentVersionSchema,
  DraftClaimSchema,
  StructuredDraftSchema,
  assertExactImagePlacements,
  type ArtifactRecord,
  type DocumentVersionRecord,
  type StructuredDraft,
} from "./contracts/content.js";

export {
  InternalLinkSchema,
  LinkDiscoveryCountsSchema,
  LinkDiscoveryMetadataSchema,
  LiveInternalLinkSchema,
  type InternalLink,
  type LinkDiscoveryCounts,
  type LinkDiscoveryMetadata,
  type LinkDiscoveryMetadataInput,
} from "./contracts/link-discovery.js";

export interface IngestStore {
  findIngest(
    key: string,
  ): Promise<{ key: string; input_hash: string; result: IngestResult } | null>;
  createIngest(
    key: string,
    inputHash: string,
    handoff: Handoff,
    warnings: IngestResult["warnings"],
  ): Promise<IngestResult>;
  /** Atomic with ingest in PostgreSQL; replay never creates a second active job. */
  enqueueRun?(runId: string, options?: QueueOptions): Promise<void>;
}

export interface SerpCompositionProbe {
  inspect(handoff: Handoff): Promise<SerpComposition | null>;
}

/** Strict, deterministic step 1.1. The optional SERP probe can only add a warning. */
export async function ingestHandoff(
  input: unknown,
  key: string,
  store: IngestStore,
  probe?: SerpCompositionProbe,
): Promise<IngestResult> {
  const handoff = HandoffSchema.parse(input);
  const existing = await store.findIngest(key);
  const decision = decideIdempotency(key, handoff, existing);
  if (decision.kind === "replay") return IngestResultSchema.parse(decision.result);
  if (decision.kind === "conflict") throw new IdempotencyConflictError(key);

  const warnings: IngestResult["warnings"] = [];
  if (probe) {
    try {
      const rawComposition: unknown = await probe.inspect(handoff);
      const composition =
        rawComposition === null ? null : SerpCompositionSchema.parse(rawComposition);
      if (composition && composition.commercial > composition.informational) {
        warnings.push({
          code: "serp_composition_mismatch",
          message: "Search results appear predominantly commercial for this blog handoff.",
        });
      }
    } catch {
      warnings.push({
        code: "serp_probe_failed",
        message: "Search result composition could not be checked; ingest continued.",
      });
    }
  }
  return IngestResultSchema.parse(
    await store.createIngest(key, decision.input_hash, handoff, warnings),
  );
}

export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
  constructor(key: string) {
    super(`Idempotency key '${key}' was already used with different input`);
  }
}

export const InternalLinksArtifactSnapshotSchema = z
  .object({
    artifact_id: text,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    body_text: z.string(),
    body: z.array(InternalLinkSchema),
    metadata_artifact_id: text.nullable(),
    metadata_content_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    metadata_body_text: z.string().nullable(),
    metadata: LinkDiscoveryMetadataSchema.nullable(),
  })
  .strict();
export type InternalLinksArtifactSnapshot = z.infer<typeof InternalLinksArtifactSnapshotSchema>;

export function linkCandidateProvenance(
  link: InternalLink,
  metadata?: Pick<LinkDiscoveryMetadata, "availability" | "providerStatus">,
): Record<string, unknown> {
  return {
    provider_status: metadata?.providerStatus,
    availability: metadata?.availability,
    relevance: link.relevance,
    keyword_overlap: link.keyword_overlap,
    hierarchy_rank: link.hierarchy_rank,
    ...(link.gsc_clicks !== undefined ? { gsc_clicks: link.gsc_clicks } : {}),
    ...(link.gsc_impressions !== undefined ? { gsc_impressions: link.gsc_impressions } : {}),
    retrieval_timestamp: link.retrieved_at,
    verification: {
      method: link.verification_method,
      status: link.status,
      timestamp: link.verified_at,
    },
    app_retrieval_timestamp: link.retrieved_at,
    score_components: {
      topical_relevance: link.topical_score,
      hierarchy_conversion: link.hierarchy_score,
      gsc_performance: link.gsc_score,
      total: link.relevance,
    },
    ...(link.ghost_id
      ? { ghost: { id: link.ghost_id, content_type: link.ghost_content_type } }
      : {}),
    ...(link.sitemap_url
      ? {
          sitemap: {
            source_url: link.sitemap_url,
            last_modified: link.sitemap_last_modified,
          },
        }
      : {}),
    ...(link.gsc_property
      ? {
          gsc: {
            property: link.gsc_property,
            query_set: link.gsc_queries,
            start_date: link.gsc_start_date,
            end_date: link.gsc_end_date,
            clicks: link.gsc_clicks,
            impressions: link.gsc_impressions,
          },
        }
      : {}),
  };
}

export const DraftProviderRequestSchema = z
  .object({
    handoff: HandoffSchema,
    internal_links: z.array(InternalLinkSchema),
    model: text,
    /** Frozen active versions mapped to Step 1.3. Optional for historical/mock callers. */
    reference_snapshots: z
      .array(
        z
          .object({
            kind: text,
            version_id: text,
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
            immutable_pointer: text,
            content: text,
          })
          .strict(),
      )
      .optional(),
    /** Immutable prompt identity used for this draft operation. */
    prompt: z
      .object({ template_id: z.literal("mobelaris.draft"), template_version: text })
      .strict()
      .optional(),
  })
  .strict();
export type DraftProviderRequest = z.infer<typeof DraftProviderRequestSchema>;
export const DraftProviderResponseSchema = z
  .object({
    request_id: text,
    draft: StructuredDraftSchema,
    usage: z
      .object({
        input_units: z.number().int().nonnegative(),
        output_units: z.number().int().nonnegative(),
        cost_micros: z.number().int().nonnegative(),
        latency_ms: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type DraftProviderResponse = z.infer<typeof DraftProviderResponseSchema>;

export interface DraftOperationIdentity {
  operation_id: string;
  run_id: string;
  request_hash: string;
  provider: string;
  model: string;
  contract_identity: string;
  purpose: "initial" | "legacy_operator_recovery";
}

export interface DraftOperationCommand {
  run_id: string;
  execution_id: string;
  token: string;
  identity: DraftOperationIdentity;
}

export const ProviderUsageSchema = z
  .object({
    id: text,
    run_id: text,
    step_execution_id: text,
    provider: text,
    model: text,
    operation: text,
    request_id: text,
    input_units: z.number().int().nonnegative(),
    output_units: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ProviderUsageRecord = z.infer<typeof ProviderUsageSchema>;

export interface MilestoneRepository extends IngestStore {
  ensureStep(runId: string, step: PipelineStepId): Promise<void>;
  stepSucceeded(runId: string, step: PipelineStepId): Promise<boolean>;
  claimStep(
    runId: string,
    step: PipelineStepId,
    owner: string,
    replaySucceeded?: boolean,
  ): Promise<{ execution_id: string; token: string }>;
  /** Extends a live lease by the configured duration; false when no longer held. */
  heartbeatStep(executionId: string, token: string): Promise<boolean>;
  /** Operator stop: cancels a running run and revokes its in-flight leases. */
  cancelRun(runId: string): Promise<void>;
  completeStep(executionId: string, token: string, preserveRunProgress?: boolean): Promise<void>;
  failStep(
    executionId: string,
    token: string,
    error: string,
    preserveRunProgress?: boolean,
  ): Promise<void>;
  /** Appends safe Step 1.2 evidence without freezing an ineligible empty shortlist. */
  saveLinkDiscoveryEvidence(
    runId: string,
    executionId: string,
    token: string,
    metadata: LinkDiscoveryMetadataInput,
  ): Promise<void>;
  getHandoff(runId: string): Promise<Handoff>;
  getLinks(runId: string): Promise<InternalLink[] | null>;
  getLinksArtifact(runId: string): Promise<InternalLinksArtifactSnapshot | null>;
  snapshotReferences(
    runId: string,
    executionId: string,
    token: string,
  ): Promise<NonNullable<DraftProviderRequest["reference_snapshots"]>>;
  saveLinks(
    runId: string,
    executionId: string,
    token: string,
    links: InternalLink[],
    metadata?: LinkDiscoveryMetadataInput,
  ): Promise<void>;
  getDraft(runId: string): Promise<{
    draft: StructuredDraft;
    artifact: ArtifactRecord;
    version: DocumentVersionRecord;
  } | null>;
  /** Creates/replays the repository-derived immutable Step 1.3 identity. */
  beginDraftOperation(input: {
    run_id: string;
    execution_id: string;
    token: string;
    request: DraftProviderRequest;
    provider: string;
    model: string;
    contract_identity: string;
    purpose: "initial" | "legacy_operator_recovery";
    operator_authorised: boolean;
  }): Promise<{ identity: DraftOperationIdentity; response: DraftProviderResponse | null }>;
  markDraftProviderInFlight(input: DraftOperationCommand): Promise<void>;
  /** Narrow release for a provider failure proven to have occurred before HTTP dispatch. */
  releaseDraftProviderFailure(input: DraftOperationCommand): Promise<void>;
  checkpointDraftResponse(
    input: DraftOperationCommand & {
      response: DraftProviderResponse;
    },
  ): Promise<void>;
  saveDraft(
    runId: string,
    executionId: string,
    token: string,
    response: DraftProviderResponse,
    operation: DraftOperationIdentity,
  ): Promise<{ draft: StructuredDraft; artifact: ArtifactRecord; version: DocumentVersionRecord }>;
}

export const MILESTONE_STEPS = [
  "ingest_handoff",
  "internal_link_discovery",
  "draft",
] as const satisfies readonly PipelineStepId[];

export function contentHash(value: string | Uint8Array): string {
  return sha256(value);
}

/** Canonical identity is for conflicts/idempotency, never for stored-byte integrity. */
export function canonicalHash(value: unknown): string {
  return hashIdempotencyInput(value);
}
export function stableId(namespace: string, ...values: string[]): string {
  return `${namespace}_${sha256(values.join("\u0000")).slice(0, 24)}`;
}

export function deriveDraftOperationIdentity(input: {
  run_id: string;
  request: DraftProviderRequest;
  provider: string;
  model: string;
  contract_identity: string;
  purpose: DraftOperationIdentity["purpose"];
}): DraftOperationIdentity {
  const provider = input.provider.trim();
  const model = input.model.trim();
  const request = DraftProviderRequestSchema.parse(input.request);
  if (!provider || !model || !input.contract_identity.trim())
    throw new Error("Draft operation identity fields are required");
  const request_hash = canonicalHash({
    request,
    provider,
    model,
    contract_identity: input.contract_identity,
    purpose: input.purpose,
  });
  return {
    operation_id: stableId("draft-operation", input.run_id, request_hash),
    run_id: input.run_id,
    request_hash,
    provider,
    model,
    contract_identity: input.contract_identity,
    purpose: input.purpose,
  };
}
export function assertMilestoneStep(value: string): PipelineStepId {
  return PipelineStepIdSchema.parse(value);
}

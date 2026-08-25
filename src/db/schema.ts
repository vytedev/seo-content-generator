import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunBlockReason } from "../shared/contracts/run-detail.js";
import type { Handoff } from "../shared/pipeline.js";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

const stepIds = [
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
] as const;

export const pipelineStep = pgEnum("pipeline_step", stepIds);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "waiting",
  "retryable_failed",
  "blocked",
  "succeeded",
  "cancelled",
]);
export const stepStatus = pgEnum("step_status", [
  "queued",
  "leased",
  "running",
  "waiting",
  "retryable_failed",
  "blocked",
  "succeeded",
  "cancelled",
]);
export const findingSeverity = pgEnum("finding_severity", ["info", "warning", "blocker"]);
export const findingDisposition = pgEnum("finding_disposition", ["accepted", "rejected"]);
export const claimType = pgEnum("claim_type", [
  "dimension",
  "material",
  "price",
  "delivery",
  "statistic",
  "provenance",
  "general",
]);
export const verificationStatus = pgEnum("verification_status", [
  "verified",
  "unverified",
  "contradicted",
]);
export const referenceDocumentKind = pgEnum("reference_document_kind", [
  "blog_writing_guide",
  "writer_submission_sample",
  "keyword_placement_guidelines",
  "internal_linking_guidelines",
  "fact_checking_rules",
  "pipeline_workflow",
]);
export const exportStatus = pgEnum("export_status", ["pending", "succeeded", "failed"]);
export const editorialStatus = pgEnum("editorial_status", [
  "pending_editorial_approval",
  "approved",
  "replaced",
]);
export const calibrationStatus = pgEnum("calibration_status", [
  "provisional_local",
  "approved",
  "rejected",
]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    planeTicket: text("plane_ticket").notNull(),
    handoff: jsonb("handoff").$type<Handoff>().notNull(),
    status: runStatus("status").notNull().default("queued"),
    currentStep: pipelineStep("current_step"),
    coherenceReturnCycles: integer("coherence_return_cycles").notNull().default(0),
    deterministicRepairCycles: integer("deterministic_repair_cycles").notNull().default(0),
    blockReason: text("block_reason").$type<RunBlockReason>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("runs_idempotency_key_unique").on(t.idempotencyKey),
    uniqueIndex("runs_id_idempotency_hash_unique").on(t.id, t.inputHash),
    index("runs_plane_ticket_idx").on(t.planeTicket),
    check("runs_coherence_cycles_range", sql`${t.coherenceReturnCycles} between 0 and 2`),
    check(
      "runs_deterministic_repair_cycles_range",
      sql`${t.deterministicRepairCycles} between 0 and 2`,
    ),
    check(
      "runs_block_reason_value",
      sql`${t.blockReason} is null or ${t.blockReason} in ('deterministic_blockers','coherence_cycle_cap')`,
    ),
    check(
      "runs_block_reason_matches_status",
      sql`${t.blockReason} is null or ${t.status} = 'blocked'`,
    ),
    check(
      "runs_step_presence",
      sql`(${t.status} = 'queued' and ${t.currentStep} is null) or (${t.status} <> 'queued' and ${t.currentStep} is not null)`,
    ),
    check(
      "runs_success_at_final_step",
      sql`${t.status} <> 'succeeded' or ${t.currentStep} = 'final_coherence_export'`,
    ),
  ],
);

export const stepExecutions = pgTable(
  "step_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    step: pipelineStep("step").notNull(),
    attempt: integer("attempt").notNull(),
    status: stepStatus("status").notNull().default("queued"),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error").$type<Record<string, unknown>>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("step_executions_run_step_attempt_unique").on(t.runId, t.step, t.attempt),
    unique("step_executions_id_run_unique").on(t.id, t.runId),
    uniqueIndex("step_executions_one_active_per_run_unique")
      .on(t.runId)
      .where(sql`${t.status} in ('leased', 'running')`),
    index("step_executions_claimable_idx").on(t.status, t.leaseExpiresAt),
    check("step_executions_attempt_positive", sql`${t.attempt} > 0`),
    check(
      "step_executions_lease_matches_status",
      sql`
    (${t.status} in ('leased', 'running') and ${t.leaseToken} is not null and ${t.leaseOwner} is not null and ${t.leaseExpiresAt} is not null)
    or (${t.status} not in ('leased', 'running') and ${t.leaseToken} is null and ${t.leaseOwner} is null and ${t.leaseExpiresAt} is null)
  `,
    ),
    check(
      "step_executions_completion_matches_status",
      sql`
    (${t.status} = 'succeeded' and ${t.completedAt} is not null)
    or (${t.status} <> 'succeeded' and ${t.completedAt} is null)
  `,
    ),
  ],
);

/** Append-only content stored in PostgreSQL for the local phase. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id").notNull(),
    parentId: uuid("parent_id"),
    kind: text("kind").notNull(),
    mediaType: text("media_type").notNull(),
    bodyText: text("body_text"),
    bodyJson: jsonb("body_json").$type<unknown>(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt,
  },
  (t) => [
    unique("artifacts_id_run_unique").on(t.id, t.runId),
    uniqueIndex("artifacts_step_kind_hash_unique").on(t.stepExecutionId, t.kind, t.contentHash),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    foreignKey({ columns: [t.parentId, t.runId], foreignColumns: [t.id, t.runId] }).onDelete(
      "restrict",
    ),
    check("artifacts_exactly_one_body", sql`num_nonnulls(${t.bodyText}, ${t.bodyJson}) = 1`),
    check("artifacts_size_range", sql`${t.sizeBytes} between 0 and 10485760`),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    artifactId: uuid("artifact_id").notNull(),
    parentId: uuid("parent_id"),
    revision: integer("revision").notNull(),
    contentHash: text("content_hash").notNull(),
    revisionSource: text("revision_source"),
    createdAt,
  },
  (t) => [
    unique("document_versions_id_run_unique").on(t.id, t.runId),
    uniqueIndex("document_versions_run_revision_unique").on(t.runId, t.revision),
    foreignKey({
      columns: [t.artifactId, t.runId],
      foreignColumns: [artifacts.id, artifacts.runId],
    }).onDelete("restrict"),
    foreignKey({ columns: [t.parentId, t.runId], foreignColumns: [t.id, t.runId] }).onDelete(
      "restrict",
    ),
    check("document_versions_revision_positive", sql`${t.revision} > 0`),
    check(
      "document_versions_revision_source",
      sql`(${t.revision} = 1 and ${t.revisionSource} is null) or (${t.revision} > 1 and ${t.revisionSource} in ('operator_findings','deterministic_repair','coherence_repair','operator_authorised_repair'))`,
    ),
  ],
);

export const stepOutputs = pgTable(
  "step_outputs",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    step: pipelineStep("step").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.documentVersionId, t.step] }),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
  ],
);

export const deterministicManifests = pgTable(
  "deterministic_manifests",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    resultHash: text("result_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("deterministic_manifests_execution_unique").on(t.stepExecutionId),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "deterministic_manifests_hashes",
      sql`length(${t.manifestHash}) = 64 and length(${t.resultHash}) = 64`,
    ),
    check(
      "deterministic_manifests_build_hash",
      sql`(${t.manifest}->>'build_id') ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "deterministic_manifests_embedded_hash_links",
      sql`${t.manifestHash}=${t.manifest}->>'manifest_hash' and ${t.resultHash}=${t.result}->>'result_hash' and ${t.manifestHash}=${t.result}->>'baseline_manifest_hash' and ${t.manifest}->>'config_hash'=${t.result}->>'config_hash' and ${t.manifest}->>'build_id'=${t.result}->>'runner_build_id'`,
    ),
  ],
);

export const deterministicReruns = pgTable(
  "deterministic_reruns",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    baselineManifestHash: text("baseline_manifest_hash").notNull(),
    resultHash: text("result_hash").notNull(),
    result: jsonb("result").notNull(),
    retainedBlockers: integer("retained_blockers").notNull(),
    introducedBlockers: integer("introduced_blockers").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.documentVersionId] }),
    uniqueIndex("deterministic_reruns_execution_unique").on(t.stepExecutionId),
    uniqueIndex("deterministic_reruns_result_identity_unique").on(
      t.runId,
      t.documentVersionId,
      t.resultHash,
    ),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "deterministic_reruns_counts",
      sql`${t.retainedBlockers} >= 0 and ${t.introducedBlockers} >= 0`,
    ),
    check(
      "deterministic_reruns_hashes",
      sql`length(${t.baselineManifestHash}) = 64 and length(${t.resultHash}) = 64`,
    ),
    check(
      "deterministic_reruns_embedded_hash_links",
      sql`${t.resultHash}=${t.result}->>'result_hash' and ${t.baselineManifestHash}=${t.result}->>'baseline_manifest_hash' and ${t.retainedBlockers}=jsonb_array_length(${t.result}#>'{comparison,retained_blockers}') and ${t.introducedBlockers}=jsonb_array_length(${t.result}#>'{comparison,introduced_blockers}')`,
    ),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    stableKey: text("stable_key").notNull(),
    category: text("category").notNull(),
    ruleReference: text("rule_reference").notNull(),
    severity: findingSeverity("severity").notNull(),
    location: jsonb("location").$type<Record<string, unknown>>().notNull(),
    issue: text("issue").notNull(),
    evidence: text("evidence"),
    suggestedFix: text("suggested_fix").notNull(),
    hardFlag: boolean("hard_flag").notNull().default(false),
    createdAt,
  },
  (t) => [
    unique("findings_id_run_unique").on(t.id, t.runId),
    uniqueIndex("findings_run_document_stable_key_unique").on(
      t.runId,
      t.documentVersionId,
      t.stableKey,
    ),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
  ],
);

/** Immutable Step 1.9 membership, frozen before the operator wait (including empty sets). */
export const findingReviewSets = pgTable(
  "finding_review_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    findingsStepExecutionId: uuid("findings_step_execution_id").notNull(),
    membershipHash: text("membership_hash").notNull(),
    findingCount: integer("finding_count").notNull(),
    /**
     * Review round for this document version. Round 1 is the ordinary Step 1.9
     * freeze; a controlled editorial correction adds the next round. Prior
     * rounds stay immutable and queryable, and the active round is the highest
     * one, never "the first row" or an undefined ordering.
     */
    round: integer("round").notNull().default(1),
    createdAt,
  },
  (t) => [
    uniqueIndex("finding_review_sets_run_round_unique").on(t.runId, t.round),
    uniqueIndex("finding_review_sets_execution_unique").on(t.findingsStepExecutionId),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.findingsStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check("finding_review_sets_count", sql`${t.findingCount} >= 0`),
    check("finding_review_sets_round", sql`${t.round} >= 1`),
  ],
);

export const findingReviewSetMembers = pgTable(
  "finding_review_set_members",
  {
    reviewSetId: uuid("review_set_id")
      .notNull()
      .references(() => findingReviewSets.id, { onDelete: "restrict" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.reviewSetId, t.ordinal] }),
    uniqueIndex("finding_review_set_members_finding_unique").on(t.reviewSetId, t.findingId),
    check("finding_review_set_members_ordinal", sql`${t.ordinal} >= 0`),
  ],
);

/** Append-only audit record for a completed (including zero-finding) Step 1.9 submission. */
export const findingReviewSubmissions = pgTable(
  "finding_review_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewSetId: uuid("review_set_id")
      .notNull()
      .references(() => findingReviewSets.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    findingCount: integer("finding_count").notNull(),
    decisionCount: integer("decision_count").notNull(),
    createdAt,
  },
  (t) => [
    // One submission per frozen review set, not per run: a run may hold more
    // than one review round (see finding_review_sets.round), and each round is
    // decided exactly once. For a single-round run this is the same guarantee
    // the earlier run-scoped index gave.
    uniqueIndex("finding_review_submissions_review_set_unique").on(t.reviewSetId),
    uniqueIndex("finding_review_submissions_idempotency_unique").on(t.idempotencyKey),
    check(
      "finding_review_submissions_counts",
      sql`${t.findingCount} >= 0 and ${t.decisionCount} >= 0 and ${t.decisionCount} = ${t.findingCount}`,
    ),
  ],
);

export const findingDispositions = pgTable(
  "finding_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    findingId: uuid("finding_id").notNull(),
    revisionStepExecutionId: uuid("revision_step_execution_id").notNull(),
    decision: findingDisposition("decision").notNull(),
    rationale: text("rationale"),
    createdAt,
  },
  (t) => [
    uniqueIndex("finding_dispositions_finding_revision_unique").on(
      t.findingId,
      t.revisionStepExecutionId,
    ),
    foreignKey({
      columns: [t.findingId, t.runId],
      foreignColumns: [findings.id, findings.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.revisionStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
  ],
);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sourceType: text("source_type").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    publisher: text("publisher"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (t) => [
    unique("sources_id_run_unique").on(t.id, t.runId),
    uniqueIndex("sources_run_uri_hash_unique").on(t.runId, t.uri, t.contentHash),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    claimText: text("claim_text").notNull(),
    claimHash: text("claim_hash").notNull(),
    type: claimType("type").notNull(),
    status: verificationStatus("status").notNull(),
    location: jsonb("location").$type<Record<string, unknown>>().notNull(),
    hardFlag: boolean("hard_flag").notNull().default(false),
    createdAt,
  },
  (t) => [
    unique("claims_id_run_unique").on(t.id, t.runId),
    uniqueIndex("claims_document_hash_unique").on(t.documentVersionId, t.claimHash),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    check(
      "claims_provenance_always_flagged",
      sql`${t.type} <> 'provenance' or ${t.hardFlag} = true`,
    ),
  ],
);

export const claimSources = pgTable(
  "claim_sources",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    status: verificationStatus("status").notNull(),
    evidenceLocation: text("evidence_location"),
    evidence: text("evidence"),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.claimId, t.sourceId] }),
    foreignKey({
      columns: [t.claimId, t.runId],
      foreignColumns: [claims.id, claims.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.sourceId, t.runId],
      foreignColumns: [sources.id, sources.runId],
    }).onDelete("restrict"),
  ],
);

/** Six global, reusable reference slots. */
export const referenceDocuments = pgTable(
  "reference_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: referenceDocumentKind("kind").notNull(),
    title: text("title").notNull(),
    createdAt,
  },
  (t) => [uniqueIndex("reference_documents_kind_unique").on(t.kind)],
);

export const referenceVersions = pgTable(
  "reference_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referenceDocumentId: uuid("reference_document_id")
      .notNull()
      .references(() => referenceDocuments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    editorialStatus: editorialStatus("editorial_status")
      .notNull()
      .default("pending_editorial_approval"),
    createdAt,
  },
  (t) => [
    unique("reference_versions_id_document_unique").on(t.id, t.referenceDocumentId),
    uniqueIndex("reference_versions_document_version_unique").on(t.referenceDocumentId, t.version),
    uniqueIndex("reference_versions_document_hash_unique").on(t.referenceDocumentId, t.contentHash),
    check("reference_versions_version_positive", sql`${t.version} > 0`),
    check("reference_versions_size_range", sql`${t.sizeBytes} between 1 and 1048576`),
  ],
);

/** Append-only evidence that a real person approved an immutable reference version. */
export const referenceApprovalAttestations = pgTable(
  "reference_approval_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referenceVersionId: uuid("reference_version_id")
      .notNull()
      .references(() => referenceVersions.id, { onDelete: "restrict" }),
    recorderIdentity: text("recorder_identity").notNull(),
    approverIdentity: text("approver_identity").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    note: text("note"),
    authorityState: text("authority_state").notNull().default("pending_unverified"),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reference_approval_attestations_version_unique").on(t.referenceVersionId),
    check(
      "reference_approval_attestations_recorder_present",
      sql`length(btrim(${t.recorderIdentity})) >= 3`,
    ),
    check(
      "reference_approval_attestations_approver_present",
      sql`length(btrim(${t.approverIdentity})) >= 3`,
    ),
    check(
      "reference_approval_attestations_evidence_present",
      sql`length(btrim(${t.evidenceReference})) >= 1`,
    ),
    check(
      "reference_approval_attestations_authority_pending",
      sql`${t.authorityState} = 'pending_unverified'`,
    ),
  ],
);

/** Append-only trusted-actor verification event. No unauthenticated API creates these records. */
export const referenceAttestationVerifications = pgTable(
  "reference_attestation_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attestationId: uuid("attestation_id")
      .notNull()
      .references(() => referenceApprovalAttestations.id, { onDelete: "restrict" }),
    verifierIdentity: text("verifier_identity").notNull(),
    authorityState: text("authority_state").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reference_attestation_verifications_attestation_unique").on(t.attestationId),
    check(
      "reference_attestation_verifications_verifier_present",
      sql`length(btrim(${t.verifierIdentity})) >= 3`,
    ),
    check(
      "reference_attestation_verifications_evidence_present",
      sql`length(btrim(${t.evidenceReference})) >= 1`,
    ),
    check(
      "reference_attestation_verifications_authority_trusted",
      sql`${t.authorityState} = 'trusted_verified'`,
    ),
  ],
);

/** Mutable pointer; non-provisional activation requires a separately verified attestation. */
export const referenceActivations = pgTable(
  "reference_activations",
  {
    referenceDocumentId: uuid("reference_document_id")
      .primaryKey()
      .references(() => referenceDocuments.id, { onDelete: "restrict" }),
    referenceVersionId: uuid("reference_version_id").notNull(),
    provisionalLocal: boolean("provisional_local").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.referenceVersionId, t.referenceDocumentId],
      foreignColumns: [referenceVersions.id, referenceVersions.referenceDocumentId],
    }).onDelete("restrict"),
  ],
);

export const substepReferenceMap = pgTable(
  "substep_reference_map",
  {
    referenceDocumentId: uuid("reference_document_id")
      .notNull()
      .references(() => referenceDocuments.id, { onDelete: "restrict" }),
    step: pipelineStep("step").notNull(),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.referenceDocumentId, t.step] })],
);

/** Immutable record of the exact versions loaded by an individual attempt. */
export const stepReferenceSnapshots = pgTable(
  "step_reference_snapshots",
  {
    stepExecutionId: uuid("step_execution_id")
      .notNull()
      .references(() => stepExecutions.id, { onDelete: "restrict" }),
    referenceDocumentId: uuid("reference_document_id")
      .notNull()
      .references(() => referenceDocuments.id, { onDelete: "restrict" }),
    referenceVersionId: uuid("reference_version_id").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.stepExecutionId, t.referenceVersionId] }),
    uniqueIndex("step_reference_snapshots_execution_document_unique").on(
      t.stepExecutionId,
      t.referenceDocumentId,
    ),
    foreignKey({
      columns: [t.referenceVersionId, t.referenceDocumentId],
      foreignColumns: [referenceVersions.id, referenceVersions.referenceDocumentId],
    }).onDelete("restrict"),
  ],
);

export const calibrationSnapshots = pgTable(
  "calibration_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slot: integer("slot").notNull(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    httpStatus: integer("http_status").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    metaDescription: text("meta_description").notNull(),
    publishedTime: timestamp("published_time", { withTimezone: true }).notNull(),
    articleMarkdown: text("article_markdown").notNull(),
    contentHash: text("content_hash").notNull(),
    safeMetadata: jsonb("safe_metadata").$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("calibration_snapshots_slot_hash_unique").on(t.slot, t.contentHash),
    check("calibration_snapshots_slot_range", sql`${t.slot} between 1 and 2`),
    check("calibration_snapshots_http_ok", sql`${t.httpStatus} = 200`),
  ],
);

export const calibrationRuns = pgTable(
  "calibration_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").notNull().default("queued"),
    checkpoint: text("checkpoint").notNull().default("created"),
    error: text("error"),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("calibration_runs_idempotency_key_unique").on(t.idempotencyKey),
    check(
      "calibration_runs_status_check",
      sql`${t.status} in ('queued','retrieving','comparing','reporting','retryable_failed','succeeded')`,
    ),
    check(
      "calibration_runs_checkpoint_check",
      sql`${t.checkpoint} in ('created','snapshots','post_1','post_2','combined')`,
    ),
  ],
);

export const calibrationRunSnapshots = pgTable(
  "calibration_run_snapshots",
  {
    calibrationRunId: uuid("calibration_run_id")
      .notNull()
      .references(() => calibrationRuns.id, { onDelete: "restrict" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => calibrationSnapshots.id, { onDelete: "restrict" }),
    slot: integer("slot").notNull(),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    finalDocumentVersionId: uuid("final_document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    exportId: uuid("export_id").references(() => exports.id, { onDelete: "restrict" }),
    pipelineOutcome: text("pipeline_outcome").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.calibrationRunId, t.slot] }),
    unique("calibration_run_snapshots_run_snapshot_slot_unique").on(
      t.calibrationRunId,
      t.snapshotId,
      t.slot,
    ),
    uniqueIndex("calibration_run_snapshots_run_snapshot_unique").on(
      t.calibrationRunId,
      t.snapshotId,
    ),
    check("calibration_run_snapshots_slot_range", sql`${t.slot} between 1 and 2`),
    check(
      "calibration_run_snapshots_pipeline_outcome",
      sql`${t.pipelineOutcome} in ('succeeded','blocked')`,
    ),
    foreignKey({
      columns: [t.finalDocumentVersionId, t.pipelineRunId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
  ],
);

export const calibrationResults = pgTable(
  "calibration_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calibrationRunId: uuid("calibration_run_id")
      .notNull()
      .references(() => calibrationRuns.id, { onDelete: "restrict" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => calibrationSnapshots.id, { onDelete: "restrict" }),
    slot: integer("slot").notNull(),
    resultHash: text("result_hash").notNull(),
    report: jsonb("report").$type<unknown>().notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("calibration_results_run_slot_unique").on(t.calibrationRunId, t.slot),
    uniqueIndex("calibration_results_run_hash_unique").on(t.calibrationRunId, t.resultHash),
    check("calibration_results_slot_range", sql`${t.slot} between 1 and 2`),
    foreignKey({
      columns: [t.calibrationRunId, t.snapshotId, t.slot],
      foreignColumns: [
        calibrationRunSnapshots.calibrationRunId,
        calibrationRunSnapshots.snapshotId,
        calibrationRunSnapshots.slot,
      ],
    }).onDelete("restrict"),
  ],
);

export const calibrationReports = pgTable(
  "calibration_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calibrationRunId: uuid("calibration_run_id")
      .notNull()
      .references(() => calibrationRuns.id, { onDelete: "restrict" }),
    reportHash: text("report_hash").notNull(),
    report: jsonb("report").$type<unknown>().notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("calibration_reports_run_unique").on(t.calibrationRunId),
    uniqueIndex("calibration_reports_hash_unique").on(t.calibrationRunId, t.reportHash),
  ],
);

export const calibrationReferenceProposals = pgTable(
  "calibration_reference_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calibrationRunId: uuid("calibration_run_id")
      .notNull()
      .references(() => calibrationRuns.id, { onDelete: "restrict" }),
    referenceDocumentId: uuid("reference_document_id")
      .notNull()
      .references(() => referenceDocuments.id, { onDelete: "restrict" }),
    referenceVersionId: uuid("reference_version_id")
      .notNull()
      .references(() => referenceVersions.id, { onDelete: "restrict" }),
    proposalHash: text("proposal_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("calibration_reference_proposals_run_hash_unique").on(
      t.calibrationRunId,
      t.proposalHash,
    ),
  ],
);

export const calibrationPosts = pgTable(
  "calibration_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slot: integer("slot").notNull(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    httpStatus: integer("http_status").notNull(),
    selectionReason: text("selection_reason").notNull(),
    status: calibrationStatus("status").notNull().default("provisional_local"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("calibration_posts_slot_unique").on(t.slot),
    uniqueIndex("calibration_posts_canonical_unique").on(t.canonicalUrl),
    check("calibration_posts_slot_range", sql`${t.slot} between 1 and 2`),
    check("calibration_posts_http_ok", sql`${t.httpStatus} = 200`),
  ],
);

export const linkDiscoveryCache = pgTable(
  "link_discovery_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cacheKey: text("cache_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseHash: text("response_hash").notNull(),
    provider: text("provider").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("link_discovery_cache_key_request_unique").on(t.cacheKey, t.requestHash),
    check(
      "link_discovery_cache_ttl_bound",
      sql`${t.expiresAt} > ${t.retrievedAt} and ${t.expiresAt} <= ${t.retrievedAt} + interval '24 hours'`,
    ),
  ],
);

export const linkDiscoveryAttempts = pgTable(
  "link_discovery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id")
      .notNull()
      .references(() => stepExecutions.id, { onDelete: "restrict" }),
    eligibility: text("eligibility").notNull(),
    reason: text("reason"),
    sourceHealth: jsonb("source_health").$type<Record<string, unknown>>().notNull(),
    counts: jsonb("counts").$type<Record<string, unknown>>().notNull(),
    cacheState: text("cache_state").notNull(),
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    metadataHash: text("metadata_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("link_discovery_attempts_execution_unique").on(t.stepExecutionId),
    index("link_discovery_attempts_run_created_idx").on(t.runId, t.createdAt),
    check("link_discovery_attempts_eligibility", sql`${t.eligibility} in ('eligible','blocked')`),
    check("link_discovery_attempts_metadata_hash", sql`length(${t.metadataHash}) = 64`),
  ],
);

export const linkCandidates = pgTable(
  "link_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    cacheId: uuid("cache_id").references(() => linkDiscoveryCache.id, { onDelete: "restrict" }),
    targetUrl: text("target_url").notNull(),
    title: text("title").notNull(),
    primaryTopic: text("primary_topic"),
    source: text("source").notNull(),
    hierarchy: text("hierarchy").notNull(),
    rank: integer("rank").notNull(),
    httpStatus: integer("http_status").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("link_candidates_run_target_unique").on(t.runId, t.targetUrl),
    check("link_candidates_rank_positive", sql`${t.rank} > 0`),
  ],
);

export const providerUsage = pgTable(
  "provider_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    operation: text("operation").notNull(),
    requestId: text("request_id"),
    inputUnits: integer("input_units").notNull().default(0),
    outputUnits: integer("output_units").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** Measured end-to-end provider call latency (all HTTP attempts combined). */
    latencyMs: integer("latency_ms"),
    createdAt,
  },
  (t) => [
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    uniqueIndex("provider_usage_run_provider_request_unique").on(t.runId, t.provider, t.requestId),
    check(
      "provider_usage_nonnegative",
      sql`${t.inputUnits} >= 0 and ${t.outputUnits} >= 0 and ${t.costMicros} >= 0 and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`,
    ),
  ],
);

/** Mutable coordination state committed before any external export side effect. */
export const providerOperations = pgTable(
  "provider_operations",
  {
    operationId: text("operation_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    operation: text("operation").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("provider_operations_run_operation_document_unique").on(
      t.runId,
      t.operation,
      t.documentVersionId,
    ),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "provider_operations_kind_check",
      sql`${t.operation} in ('revision_pass','final_coherence_export')`,
    ),
  ],
);

/** Immutable one-row-per-accepted-finding Step 1.10 application audit. */
export const revisionFindingAudits = pgTable(
  "revision_finding_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    operationId: text("operation_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    sourceDocumentVersionId: uuid("source_document_version_id").notNull(),
    resultDocumentVersionId: uuid("result_document_version_id").notNull(),
    findingId: uuid("finding_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    location: text("location").notNull(),
    locationJson: jsonb("location_json").notNull(),
    hunks: jsonb("hunks").notNull().default([]),
    manifestHash: text("manifest_hash").notNull(),
    changed: boolean("changed").notNull(),
    beforeHash: text("before_hash").notNull(),
    afterHash: text("after_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("revision_finding_audits_operation_ordinal_unique").on(t.operationId, t.ordinal),
    uniqueIndex("revision_finding_audits_operation_finding_unique").on(t.operationId, t.findingId),
    foreignKey({
      columns: [t.operationId, t.runId],
      foreignColumns: [revisionOperationStates.operationId, revisionOperationStates.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.findingId, t.runId],
      foreignColumns: [findings.id, findings.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.sourceDocumentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.resultDocumentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    check("revision_finding_audits_ordinal", sql`${t.ordinal} >= 0`),
    check("revision_finding_audits_status", sql`${t.status} in ('applied','unable')`),
  ],
);

export const revisionOperationStates = pgTable(
  "revision_operation_states",
  {
    operationId: text("operation_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    producingStepExecutionId: uuid("producing_step_execution_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    responseHash: text("response_hash"),
    status: text("status").notNull().default("started"),
    createdAt,
    checkpointedAt: timestamp("checkpointed_at", { withTimezone: true }),
  },
  (t) => [
    unique("revision_operation_states_operation_run_unique").on(t.operationId, t.runId),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.producingStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "revision_operation_states_status",
      sql`${t.status} in ('started','provider_in_flight','response_validated')`,
    ),
  ],
);

export const revisionProviderFailures = pgTable(
  "revision_provider_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id").notNull(),
    operationId: text("operation_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    planningVersion: text("planning_version").notNull(),
    failureCategory: text("failure_category").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("revision_provider_failures_execution_unique").on(t.stepExecutionId),
    index("revision_provider_failures_lock_identity_idx").on(
      t.runId,
      t.provider,
      t.model,
      t.promptVersion,
      t.planningVersion,
      t.failureCategory,
    ),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "revision_provider_failures_category",
      sql`${t.failureCategory} in ('configuration','malformed_response','transient_exhausted','timeout','guard_rejected')`,
    ),
  ],
);

export const revisionNoopCompletions = pgTable(
  "revision_noop_completions",
  {
    operationId: text("operation_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    revisionSource: text("revision_source").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("revision_noop_completions_execution_unique").on(t.stepExecutionId),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    check(
      "revision_noop_completions_source",
      sql`${t.revisionSource} in ('operator_findings','deterministic_repair','coherence_repair','operator_authorised_repair')`,
    ),
  ],
);

export const coherenceRecoveries = pgTable(
  "coherence_recoveries",
  {
    operationId: text("operation_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    producingStepExecutionId: uuid("producing_step_execution_id").notNull(),
    recoveryStepExecutionId: uuid("recovery_step_execution_id").notNull(),
    outcome: text("outcome").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.operationId, t.recoveryStepExecutionId] }),
    foreignKey({
      columns: [t.operationId],
      foreignColumns: [providerOperations.operationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.producingStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.recoveryStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check("coherence_recoveries_outcome_check", sql`${t.outcome} in ('revise','blocked','export')`),
  ],
);

/** One immutable exceptional authorisation, bound to the exact blocked document and rerun. */
export const exceptionalCorrectionAuthorisations = pgTable(
  "exceptional_correction_authorisations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    deterministicRerunStepExecutionId: uuid("deterministic_rerun_step_execution_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    blockerSetHash: text("blocker_set_hash").notNull(),
    blockerBindings: jsonb("blocker_bindings").$type<unknown>().notNull(),
    explicitConfirmation: boolean("explicit_confirmation").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("exceptional_correction_authorisations_run_unique").on(t.runId),
    uniqueIndex("exceptional_correction_authorisations_idempotency_unique").on(t.idempotencyKey),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.deterministicRerunStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check("exceptional_correction_authorisations_confirmed", sql`${t.explicitConfirmation} = true`),
    check("exceptional_correction_authorisations_hash", sql`length(${t.blockerSetHash}) = 64`),
  ],
);

/** Append-only encrypted OAuth credential versions; disconnects are tombstone events. */
export const modelDiagnosticOperations = pgTable(
  "model_diagnostic_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("pending"),
    safeResult: jsonb("safe_result").$type<Record<string, unknown>>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex("model_diagnostic_operations_idempotency_unique").on(t.idempotencyKey),
    index("model_diagnostic_operations_active_idx").on(t.status, t.createdAt),
    check("model_diagnostic_operations_provider", sql`${t.provider} = 'openrouter'`),
    check(
      "model_diagnostic_operations_status",
      sql`${t.status} in ('pending','in_flight','succeeded','failed')`,
    ),
    check(
      "model_diagnostic_operations_result_state",
      sql`(${t.status} in ('pending','in_flight') and ${t.safeResult} is null and ${t.completedAt} is null)
          or (${t.status} in ('succeeded','failed') and ${t.safeResult} is not null and ${t.completedAt} is not null)`,
    ),
  ],
);

export const operatorSessions = pgTable(
  "operator_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex("operator_sessions_token_hash_unique").on(t.tokenHash),
    index("operator_sessions_expiry_idx").on(t.expiresAt),
    check("operator_sessions_token_hash_check", sql`length(${t.tokenHash}) = 64`),
    check("operator_sessions_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "operator_sessions_revocation_after_creation",
      sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.createdAt}`,
    ),
  ],
);

export const googleOauthTokenVersions = pgTable(
  "google_oauth_token_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: bigint("version", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    provider: text("provider").notNull(),
    event: text("event").notNull(),
    encryptedTokens: text("encrypted_tokens"),
    iv: text("iv"),
    authTag: text("auth_tag"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt,
  },
  (t) => [
    uniqueIndex("google_oauth_token_versions_version_unique").on(t.version),
    index("google_oauth_token_versions_latest_idx").on(t.provider, t.version),
    check("google_oauth_token_versions_version_positive", sql`${t.version} > 0`),
    check("google_oauth_token_versions_provider_check", sql`${t.provider} = 'google'`),
    check(
      "google_oauth_token_versions_event_check",
      sql`${t.event} in ('connected','disconnected')`,
    ),
    check(
      "google_oauth_token_versions_payload_check",
      sql`(${t.event} = 'connected' and num_nonnulls(${t.encryptedTokens},${t.iv},${t.authTag},${t.expiresAt},${t.scope}) = 5)
          or (${t.event} = 'disconnected' and num_nonnulls(${t.encryptedTokens},${t.iv},${t.authTag},${t.expiresAt},${t.scope}) = 0)`,
    ),
  ],
);

export const exportOperations = pgTable(
  "export_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    destination: text("destination").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerIdempotencyKey: text("provider_idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    status: exportStatus("status").notNull().default("pending"),
    externalDocumentId: text("external_document_id"),
    externalUrl: text("external_url"),
    lastError: text("last_error"),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("export_operations_idempotency_key_unique").on(t.idempotencyKey),
    uniqueIndex("export_operations_run_document_destination_unique").on(
      t.runId,
      t.documentVersionId,
      t.destination,
    ),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
  ],
);

/** Versioned, append-only templates. Pending is honest until separate approval evidence exists. */
export const contentTemplates = pgTable(
  "content_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: text("template_id").notNull(),
    version: text("version").notNull(),
    kind: text("kind").notNull(),
    status: editorialStatus("status").notNull().default("pending_editorial_approval"),
    body: jsonb("body").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("content_templates_identity_unique").on(t.templateId, t.version),
    check("content_templates_kind_check", sql`${t.kind} in ('writer_submission','blog_schema')`),
    check("content_templates_hash_length", sql`length(${t.contentHash}) = 64`),
  ],
);

/** Frozen Step 1.12 input identity; this is the authority for retries and export audit. */
export const exportManifests = pgTable(
  "export_manifests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    stepExecutionId: uuid("step_execution_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    renderHash: text("render_hash").notNull(),
    renderContentHash: text("render_content_hash").notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("export_manifests_run_document_unique").on(t.runId, t.documentVersionId),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    check(
      "export_manifests_hash_lengths",
      sql`length(${t.manifestHash}) = 64 and length(${t.renderHash}) = 64 and length(${t.renderContentHash}) = 64`,
    ),
  ],
);

export const coherenceCheckpoints = pgTable(
  "coherence_checkpoints",
  {
    operationId: text("operation_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").notNull(),
    producingStepExecutionId: uuid("producing_step_execution_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    responseHash: text("response_hash"),
    createdAt,
    checkpointedAt: timestamp("checkpointed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.producingStepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
  ],
);

export const exports = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    stepExecutionId: uuid("step_execution_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    exportArtifactId: uuid("export_artifact_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    destination: text("destination").notNull(),
    externalDocumentId: text("external_document_id"),
    externalUrl: text("external_url"),
    status: exportStatus("status").notNull().default("pending"),
    response: jsonb("response").$type<Record<string, unknown>>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("exports_idempotency_key_unique").on(t.idempotencyKey),
    uniqueIndex("exports_destination_document_unique").on(t.destination, t.externalDocumentId),
    foreignKey({
      columns: [t.stepExecutionId, t.runId],
      foreignColumns: [stepExecutions.id, stepExecutions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.documentVersionId, t.runId],
      foreignColumns: [documentVersions.id, documentVersions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.exportArtifactId, t.runId],
      foreignColumns: [artifacts.id, artifacts.runId],
    }).onDelete("restrict"),
  ],
);

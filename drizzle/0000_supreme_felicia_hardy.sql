CREATE TYPE "public"."calibration_status" AS ENUM('provisional_local', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('dimension', 'material', 'price', 'delivery', 'statistic', 'provenance', 'general');--> statement-breakpoint
CREATE TYPE "public"."editorial_status" AS ENUM('pending_editorial_approval', 'approved', 'replaced');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."finding_disposition" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('info', 'warning', 'blocker');--> statement-breakpoint
CREATE TYPE "public"."pipeline_step" AS ENUM('ingest_handoff', 'internal_link_discovery', 'draft', 'automated_checks', 'review_writing_style', 'review_information_gain', 'review_fact_checking', 'review_link_conversion', 'findings_review', 'revision_pass', 'automated_checks_rerun', 'final_coherence_export');--> statement-breakpoint
CREATE TYPE "public"."reference_document_kind" AS ENUM('blog_writing_guide', 'writer_submission_sample', 'keyword_placement_guidelines', 'internal_linking_guidelines', 'fact_checking_rules', 'pipeline_workflow');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting', 'retryable_failed', 'blocked', 'succeeded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('queued', 'leased', 'running', 'waiting', 'retryable_failed', 'blocked', 'succeeded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('verified', 'unverified', 'contradicted');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"body_text" text,
	"body_json" jsonb,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_id_run_unique" UNIQUE("id","run_id"),
	CONSTRAINT "artifacts_exactly_one_body" CHECK (num_nonnulls("artifacts"."body_text", "artifacts"."body_json") = 1),
	CONSTRAINT "artifacts_size_range" CHECK ("artifacts"."size_bytes" between 0 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "calibration_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" integer NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"http_status" integer NOT NULL,
	"selection_reason" text NOT NULL,
	"status" "calibration_status" DEFAULT 'provisional_local' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_posts_slot_range" CHECK ("calibration_posts"."slot" between 1 and 2),
	CONSTRAINT "calibration_posts_http_ok" CHECK ("calibration_posts"."http_status" = 200)
);
--> statement-breakpoint
CREATE TABLE "claim_sources" (
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "verification_status" NOT NULL,
	"evidence_location" text,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_sources_claim_id_source_id_pk" PRIMARY KEY("claim_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"claim_hash" text NOT NULL,
	"type" "claim_type" NOT NULL,
	"status" "verification_status" NOT NULL,
	"location" jsonb NOT NULL,
	"hard_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_id_run_unique" UNIQUE("id","run_id"),
	CONSTRAINT "claims_provenance_always_flagged" CHECK ("claims"."type" <> 'provenance' or "claims"."hard_flag" = true)
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"parent_id" uuid,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_id_run_unique" UNIQUE("id","run_id"),
	CONSTRAINT "document_versions_revision_positive" CHECK ("document_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"export_artifact_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"destination" text NOT NULL,
	"external_document_id" text,
	"external_url" text,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"revision_step_execution_id" uuid NOT NULL,
	"decision" "finding_disposition" NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"category" text NOT NULL,
	"rule_reference" text NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"location" jsonb NOT NULL,
	"issue" text NOT NULL,
	"evidence" text,
	"suggested_fix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_id_run_unique" UNIQUE("id","run_id")
);
--> statement-breakpoint
CREATE TABLE "link_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"cache_id" uuid,
	"target_url" text NOT NULL,
	"title" text NOT NULL,
	"primary_topic" text,
	"source" text NOT NULL,
	"hierarchy" text NOT NULL,
	"rank" integer NOT NULL,
	"http_status" integer NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_candidates_rank_positive" CHECK ("link_candidates"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "link_discovery_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_hash" text NOT NULL,
	"provider" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"operation" text NOT NULL,
	"request_id" text,
	"input_units" integer DEFAULT 0 NOT NULL,
	"output_units" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_nonnegative" CHECK ("provider_usage"."input_units" >= 0 and "provider_usage"."output_units" >= 0 and "provider_usage"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reference_activations" (
	"reference_document_id" uuid PRIMARY KEY NOT NULL,
	"reference_version_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "reference_document_kind" NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"editorial_status" "editorial_status" DEFAULT 'pending_editorial_approval' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_versions_id_document_unique" UNIQUE("id","reference_document_id"),
	CONSTRAINT "reference_versions_version_positive" CHECK ("reference_versions"."version" > 0),
	CONSTRAINT "reference_versions_size_range" CHECK ("reference_versions"."size_bytes" between 1 and 1048576)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"plane_ticket" text NOT NULL,
	"handoff" jsonb NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"current_step" "pipeline_step",
	"coherence_return_cycles" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_coherence_cycles_range" CHECK ("runs"."coherence_return_cycles" between 0 and 2),
	CONSTRAINT "runs_step_presence" CHECK (("runs"."status" = 'queued' and "runs"."current_step" is null) or ("runs"."status" <> 'queued' and "runs"."current_step" is not null)),
	CONSTRAINT "runs_success_at_final_step" CHECK ("runs"."status" <> 'succeeded' or "runs"."current_step" = 'final_coherence_export')
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"uri" text NOT NULL,
	"title" text,
	"publisher" text,
	"retrieved_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_id_run_unique" UNIQUE("id","run_id")
);
--> statement-breakpoint
CREATE TABLE "step_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"attempt" integer NOT NULL,
	"status" "step_status" DEFAULT 'queued' NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_executions_id_run_unique" UNIQUE("id","run_id"),
	CONSTRAINT "step_executions_attempt_positive" CHECK ("step_executions"."attempt" > 0),
	CONSTRAINT "step_executions_lease_matches_status" CHECK (
    ("step_executions"."status" in ('leased', 'running') and "step_executions"."lease_token" is not null and "step_executions"."lease_owner" is not null and "step_executions"."lease_expires_at" is not null)
    or ("step_executions"."status" not in ('leased', 'running') and "step_executions"."lease_token" is null and "step_executions"."lease_owner" is null and "step_executions"."lease_expires_at" is null)
  ),
	CONSTRAINT "step_executions_completion_matches_status" CHECK (
    ("step_executions"."status" = 'succeeded' and "step_executions"."completed_at" is not null)
    or ("step_executions"."status" <> 'succeeded' and "step_executions"."completed_at" is null)
  )
);
--> statement-breakpoint
CREATE TABLE "step_reference_snapshots" (
	"step_execution_id" uuid NOT NULL,
	"reference_document_id" uuid NOT NULL,
	"reference_version_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_reference_snapshots_step_execution_id_reference_version_id_pk" PRIMARY KEY("step_execution_id","reference_version_id")
);
--> statement-breakpoint
CREATE TABLE "substep_reference_map" (
	"reference_document_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "substep_reference_map_reference_document_id_step_pk" PRIMARY KEY("reference_document_id","step")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_parent_id_run_id_artifacts_id_run_id_fk" FOREIGN KEY ("parent_id","run_id") REFERENCES "public"."artifacts"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_claim_id_run_id_claims_id_run_id_fk" FOREIGN KEY ("claim_id","run_id") REFERENCES "public"."claims"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_source_id_run_id_sources_id_run_id_fk" FOREIGN KEY ("source_id","run_id") REFERENCES "public"."sources"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_artifact_id_run_id_artifacts_id_run_id_fk" FOREIGN KEY ("artifact_id","run_id") REFERENCES "public"."artifacts"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_parent_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("parent_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_export_artifact_id_run_id_artifacts_id_run_id_fk" FOREIGN KEY ("export_artifact_id","run_id") REFERENCES "public"."artifacts"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_dispositions" ADD CONSTRAINT "finding_dispositions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_dispositions" ADD CONSTRAINT "finding_dispositions_finding_id_run_id_findings_id_run_id_fk" FOREIGN KEY ("finding_id","run_id") REFERENCES "public"."findings"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_dispositions" ADD CONSTRAINT "finding_dispositions_revision_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("revision_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_candidates" ADD CONSTRAINT "link_candidates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_candidates" ADD CONSTRAINT "link_candidates_cache_id_link_discovery_cache_id_fk" FOREIGN KEY ("cache_id") REFERENCES "public"."link_discovery_cache"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_activations" ADD CONSTRAINT "reference_activations_reference_document_id_reference_documents_id_fk" FOREIGN KEY ("reference_document_id") REFERENCES "public"."reference_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_activations" ADD CONSTRAINT "reference_activations_reference_version_id_reference_document_id_reference_versions_id_reference_document_id_fk" FOREIGN KEY ("reference_version_id","reference_document_id") REFERENCES "public"."reference_versions"("id","reference_document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_versions" ADD CONSTRAINT "reference_versions_reference_document_id_reference_documents_id_fk" FOREIGN KEY ("reference_document_id") REFERENCES "public"."reference_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_reference_snapshots" ADD CONSTRAINT "step_reference_snapshots_step_execution_id_step_executions_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."step_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_reference_snapshots" ADD CONSTRAINT "step_reference_snapshots_reference_document_id_reference_documents_id_fk" FOREIGN KEY ("reference_document_id") REFERENCES "public"."reference_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_reference_snapshots" ADD CONSTRAINT "step_reference_snapshots_reference_version_id_reference_document_id_reference_versions_id_reference_document_id_fk" FOREIGN KEY ("reference_version_id","reference_document_id") REFERENCES "public"."reference_versions"("id","reference_document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substep_reference_map" ADD CONSTRAINT "substep_reference_map_reference_document_id_reference_documents_id_fk" FOREIGN KEY ("reference_document_id") REFERENCES "public"."reference_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_step_kind_hash_unique" ON "artifacts" USING btree ("step_execution_id","kind","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_posts_slot_unique" ON "calibration_posts" USING btree ("slot");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_posts_canonical_unique" ON "calibration_posts" USING btree ("canonical_url");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_document_hash_unique" ON "claims" USING btree ("document_version_id","claim_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_run_revision_unique" ON "document_versions" USING btree ("run_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_idempotency_key_unique" ON "exports" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_destination_document_unique" ON "exports" USING btree ("destination","external_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_dispositions_finding_revision_unique" ON "finding_dispositions" USING btree ("finding_id","revision_step_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_run_document_stable_key_unique" ON "findings" USING btree ("run_id","document_version_id","stable_key");--> statement-breakpoint
CREATE UNIQUE INDEX "link_candidates_run_target_unique" ON "link_candidates" USING btree ("run_id","target_url");--> statement-breakpoint
CREATE UNIQUE INDEX "link_discovery_cache_key_request_unique" ON "link_discovery_cache" USING btree ("cache_key","request_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_usage_provider_request_unique" ON "provider_usage" USING btree ("provider","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_documents_kind_unique" ON "reference_documents" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_versions_document_version_unique" ON "reference_versions" USING btree ("reference_document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_versions_document_hash_unique" ON "reference_versions" USING btree ("reference_document_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_key_unique" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_id_idempotency_hash_unique" ON "runs" USING btree ("id","input_hash");--> statement-breakpoint
CREATE INDEX "runs_plane_ticket_idx" ON "runs" USING btree ("plane_ticket");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_run_uri_hash_unique" ON "sources" USING btree ("run_id","uri","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "step_executions_run_step_attempt_unique" ON "step_executions" USING btree ("run_id","step","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "step_executions_one_active_per_run_unique" ON "step_executions" USING btree ("run_id") WHERE "step_executions"."status" in ('leased', 'running');--> statement-breakpoint
CREATE INDEX "step_executions_claimable_idx" ON "step_executions" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "step_reference_snapshots_execution_document_unique" ON "step_reference_snapshots" USING btree ("step_execution_id","reference_document_id");
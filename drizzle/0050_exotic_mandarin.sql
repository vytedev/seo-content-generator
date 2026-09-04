CREATE TABLE "application_schema_version" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"version" integer NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_schema_version_singleton" CHECK ("application_schema_version"."singleton"=true),
	CONSTRAINT "application_schema_version_current" CHECK ("application_schema_version"."version"=55)
);
--> statement-breakpoint
CREATE TABLE "run_activity_events" (
	"activity_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"command_id" text,
	"step" "pipeline_step",
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_activity_events_sequence" CHECK ("run_activity_events"."sequence" > 0),
	CONSTRAINT "run_activity_events_summary_bound" CHECK (length("run_activity_events"."summary") between 1 and 500),
	CONSTRAINT "run_activity_events_type" CHECK ("run_activity_events"."type" in ('command_accepted','command_rejected','step_started','step_waiting','step_failed','step_blocked','step_succeeded','run_cancelled','warning_recorded','warning_acknowledged','export_succeeded')),
	CONSTRAINT "run_activity_events_reference_shape" CHECK (("run_activity_events"."type" like 'command\_%' escape '\' and "run_activity_events"."command_id" is not null and "run_activity_events"."step" is null) or ("run_activity_events"."type" like 'step\_%' escape '\' and "run_activity_events"."step" is not null and "run_activity_events"."command_id" is null) or ("run_activity_events"."type" not like 'command\_%' escape '\' and "run_activity_events"."type" not like 'step\_%' escape '\' and "run_activity_events"."command_id" is null and "run_activity_events"."step" is null)),
	CONSTRAINT "run_activity_events_payload_identity" CHECK (coalesce(jsonb_typeof("run_activity_events"."payload")='object' and "run_activity_events"."payload"->>'activity_id'="run_activity_events"."activity_id" and "run_activity_events"."payload"->>'run_id'="run_activity_events"."run_id"::text and ("run_activity_events"."payload"->>'sequence')::integer="run_activity_events"."sequence" and "run_activity_events"."payload"->>'type'="run_activity_events"."type" and "run_activity_events"."payload"->>'summary'="run_activity_events"."summary" and ("run_activity_events"."payload"->>'occurred_at')::timestamptz="run_activity_events"."occurred_at" and coalesce("run_activity_events"."payload"->>'command_id','')=coalesce("run_activity_events"."command_id",'') and coalesce("run_activity_events"."payload"->>'step','')=coalesce("run_activity_events"."step"::text,''), false))
);
--> statement-breakpoint
CREATE TABLE "run_command_outbox" (
	"command_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"terminal_result" jsonb,
	"completed_at" timestamp with time zone,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_command_outbox_payload_hash" CHECK ("run_command_outbox"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "run_command_outbox_kind" CHECK ("run_command_outbox"."kind" in ('create_run','resume_run','cancel_run','submit_findings','open_editorial_correction','authorise_exceptional_correction','retry_export','acknowledge_warning','probe_serp')),
	CONSTRAINT "run_command_outbox_run_shape" CHECK (("run_command_outbox"."kind"='create_run' and "run_command_outbox"."run_id" is null) or ("run_command_outbox"."kind"<>'create_run' and "run_command_outbox"."run_id" is not null)),
	CONSTRAINT "run_command_outbox_payload_identity" CHECK (coalesce(jsonb_typeof("run_command_outbox"."payload")='object' and "run_command_outbox"."payload"->>'command_id'="run_command_outbox"."command_id" and "run_command_outbox"."payload"->>'kind'="run_command_outbox"."kind" and "run_command_outbox"."payload"->>'idempotency_key'="run_command_outbox"."idempotency_key" and "run_command_outbox"."payload"->>'payload_hash'="run_command_outbox"."payload_hash" and (("run_command_outbox"."kind"='create_run' and not ("run_command_outbox"."payload" ? 'run_id')) or ("run_command_outbox"."kind"<>'create_run' and "run_command_outbox"."payload"->>'run_id'="run_command_outbox"."run_id"::text)), false)),
	CONSTRAINT "run_command_outbox_status" CHECK ("run_command_outbox"."status" in ('pending','processing','succeeded','failed')),
	CONSTRAINT "run_command_outbox_terminal_result" CHECK (("run_command_outbox"."status" in ('pending','processing') and "run_command_outbox"."terminal_result" is null and "run_command_outbox"."completed_at" is null) or ("run_command_outbox"."status" in ('succeeded','failed') and "run_command_outbox"."terminal_result" is not null and "run_command_outbox"."completed_at" is not null)),
	CONSTRAINT "run_command_outbox_aux_lease_shape" CHECK (("run_command_outbox"."kind"='probe_serp' and "run_command_outbox"."status"='processing' and "run_command_outbox"."lease_owner" is not null and "run_command_outbox"."lease_token" is not null and "run_command_outbox"."lease_expires_at" is not null) or not ("run_command_outbox"."kind"='probe_serp' and "run_command_outbox"."status"='processing'))
);
--> statement-breakpoint
CREATE TABLE "serp_evidence" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"handoff_hash" text NOT NULL,
	"provider" text NOT NULL,
	"query" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"composition" jsonb,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serp_evidence_handoff_hash" CHECK ("serp_evidence"."handoff_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "serp_evidence_status" CHECK ("serp_evidence"."status" in ('matched','mismatch','no_results','failed')),
	CONSTRAINT "serp_evidence_result_shape" CHECK (("serp_evidence"."status" in ('matched','mismatch') and "serp_evidence"."composition" is not null and "serp_evidence"."failure_reason" is null) or ("serp_evidence"."status"='no_results' and "serp_evidence"."composition" is null and "serp_evidence"."failure_reason" is null) or ("serp_evidence"."status"='failed' and "serp_evidence"."composition" is null and "serp_evidence"."failure_reason" is not null and length(btrim("serp_evidence"."failure_reason")) between 1 and 500)),
	CONSTRAINT "serp_evidence_composition_shape" CHECK ("serp_evidence"."composition" is null or (jsonb_typeof("serp_evidence"."composition")='object' and "serp_evidence"."composition" ?& array['informational','commercial'] and "serp_evidence"."composition" - array['informational','commercial']::text[]='{}'::jsonb and jsonb_typeof("serp_evidence"."composition"->'informational')='number' and jsonb_typeof("serp_evidence"."composition"->'commercial')='number' and ("serp_evidence"."composition"->>'informational')::integer >= 0 and ("serp_evidence"."composition"->>'commercial')::integer >= 0))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_name" text PRIMARY KEY NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" DROP CONSTRAINT "coherence_checkpoints_response_pair";--> statement-breakpoint
ALTER TABLE "revision_operation_states" DROP CONSTRAINT "revision_operation_states_status";--> statement-breakpoint
ALTER TABLE "revision_operation_states" DROP CONSTRAINT "revision_operation_states_response_pair";--> statement-breakpoint
-- The legacy trigger rejects updates to completed rows. Remove it before the one-time
-- status normalisation; 0051 installs the final transition trigger.
DROP TRIGGER IF EXISTS revision_operation_states_identity_immutable ON revision_operation_states;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "hard_flag_reason" text;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD COLUMN "ambiguity_reason" text;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD COLUMN "ambiguity_reason" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "hard_flag_reason" text;--> statement-breakpoint
ALTER TABLE "review_operation_states" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "review_operation_states" ADD COLUMN "ambiguity_reason" text;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD COLUMN "ambiguity_reason" text;--> statement-breakpoint
ALTER TABLE "run_activity_events" ADD CONSTRAINT "run_activity_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_activity_events" ADD CONSTRAINT "run_activity_events_command_id_run_command_outbox_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."run_command_outbox"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_command_outbox" ADD CONSTRAINT "run_command_outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_evidence" ADD CONSTRAINT "serp_evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_activity_events_run_sequence_unique" ON "run_activity_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "run_activity_events_run_occurred_idx" ON "run_activity_events" USING btree ("run_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_command_outbox_idempotency_unique" ON "run_command_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "run_command_outbox_claim_idx" ON "run_command_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "run_command_outbox_aux_lease_idx" ON "run_command_outbox" USING btree ("kind","status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "serp_evidence_run_handoff_hash_unique" ON "serp_evidence" USING btree ("run_id","handoff_hash");--> statement-breakpoint
-- Prepare legacy rows before installing the generated final-state constraints below.
UPDATE "revision_operation_states"
SET "status"='checkpointed'
WHERE "status"='response_validated';--> statement-breakpoint
UPDATE "draft_operation_states"
SET "ambiguity_reason"='provider_in_flight_without_checkpoint'
WHERE "status"='provider_in_flight' AND "response" IS NULL;--> statement-breakpoint
UPDATE "review_operation_states"
SET "ambiguity_reason"='provider_in_flight_without_checkpoint'
WHERE "status"='provider_in_flight' AND "response" IS NULL;--> statement-breakpoint
UPDATE "revision_operation_states"
SET "ambiguity_reason"='provider_in_flight_without_checkpoint'
WHERE "status"='provider_in_flight' AND "response" IS NULL;--> statement-breakpoint
UPDATE "coherence_checkpoints"
SET "ambiguity_reason"='provider_in_flight_without_checkpoint'
WHERE "status"='provider_in_flight' AND "response" IS NULL;--> statement-breakpoint
-- These tables are append-only in normal operation. Temporarily remove only their
-- immutable-update guards for the one-time typed-reason backfill, then restore them.
DROP TRIGGER claims_immutable ON claims;--> statement-breakpoint
DROP TRIGGER findings_immutable ON findings;--> statement-breakpoint
UPDATE "claims"
SET "hard_flag_reason"=CASE WHEN "type"='provenance' THEN 'provenance' ELSE 'unknown_legacy' END
WHERE "hard_flag"=true;--> statement-breakpoint
UPDATE "findings"
SET "hard_flag_reason"=CASE
  WHEN "rule_reference" ILIKE '%designer%' THEN 'designer_attribution'
  WHEN "rule_reference" ILIKE '%provenance%' THEN 'provenance'
  ELSE 'unknown_legacy'
END
WHERE "hard_flag"=true;--> statement-breakpoint
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER findings_immutable BEFORE UPDATE OR DELETE ON findings FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_hard_flag_reason" CHECK (("claims"."hard_flag"=false and "claims"."hard_flag_reason" is null) or ("claims"."hard_flag"=true and "claims"."hard_flag_reason" in ('provenance','designer_attribution','unverified_figure','contradicted','policy','unknown_legacy')));--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_safety_reason" CHECK (("coherence_checkpoints"."release_reason" is null or ("coherence_checkpoints"."status"='started' and "coherence_checkpoints"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))) and ("coherence_checkpoints"."ambiguity_reason" is null or ("coherence_checkpoints"."status"='provider_in_flight' and "coherence_checkpoints"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown'))) and num_nonnulls("coherence_checkpoints"."release_reason","coherence_checkpoints"."ambiguity_reason") <= 1);--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_response_pair" CHECK ((("coherence_checkpoints"."status" in ('started','provider_in_flight') and "coherence_checkpoints"."response" is null and "coherence_checkpoints"."response_hash" is null and "coherence_checkpoints"."checkpointed_at" is null) or ("coherence_checkpoints"."status" = 'checkpointed' and "coherence_checkpoints"."response" is not null and "coherence_checkpoints"."response_hash" is not null and "coherence_checkpoints"."checkpointed_at" is not null)));--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_safety_reason" CHECK (("draft_operation_states"."release_reason" is null or ("draft_operation_states"."status"='started' and "draft_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))) and ("draft_operation_states"."ambiguity_reason" is null or ("draft_operation_states"."status"='provider_in_flight' and "draft_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown'))) and num_nonnulls("draft_operation_states"."release_reason","draft_operation_states"."ambiguity_reason") <= 1);--> statement-breakpoint
ALTER TABLE "export_operations" ADD CONSTRAINT "export_operations_terminal_result" CHECK (("export_operations"."status"='succeeded' and "export_operations"."external_document_id" is not null and "export_operations"."external_url" is not null and "export_operations"."last_error" is null) or ("export_operations"."status"='failed' and "export_operations"."last_error" is not null) or ("export_operations"."status"='pending'));--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_terminal_result" CHECK (("exports"."status"='succeeded' and "exports"."external_document_id" is not null and "exports"."external_url" is not null and "exports"."response" is not null) or ("exports"."status" in ('pending','failed') and "exports"."response" is null));--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_hard_flag_reason" CHECK (("findings"."hard_flag"=false and "findings"."hard_flag_reason" is null) or ("findings"."hard_flag"=true and "findings"."hard_flag_reason" in ('provenance','designer_attribution','unverified_figure','contradicted','policy','unknown_legacy')));--> statement-breakpoint
ALTER TABLE "review_operation_states" ADD CONSTRAINT "review_operation_states_safety_reason" CHECK (("review_operation_states"."release_reason" is null or ("review_operation_states"."status"='started' and "review_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))) and ("review_operation_states"."ambiguity_reason" is null or ("review_operation_states"."status"='provider_in_flight' and "review_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown'))) and num_nonnulls("review_operation_states"."release_reason","review_operation_states"."ambiguity_reason") <= 1);--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_response_pair" CHECK (("revision_operation_states"."status" in ('started','provider_in_flight') and "revision_operation_states"."response" is null and "revision_operation_states"."response_hash" is null and "revision_operation_states"."checkpointed_at" is null) or ("revision_operation_states"."status"='checkpointed' and "revision_operation_states"."response" is not null and "revision_operation_states"."response_hash" is not null and "revision_operation_states"."checkpointed_at" is not null));--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_safety_reason" CHECK (("revision_operation_states"."release_reason" is null or ("revision_operation_states"."status"='started' and "revision_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))) and ("revision_operation_states"."ambiguity_reason" is null or ("revision_operation_states"."status"='provider_in_flight' and "revision_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown'))) and num_nonnulls("revision_operation_states"."release_reason","revision_operation_states"."ambiguity_reason") <= 1);--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_status" CHECK ("revision_operation_states"."status" in ('started','provider_in_flight','checkpointed'));
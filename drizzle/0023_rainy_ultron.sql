CREATE TABLE "revision_operation_states" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"producing_step_execution_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"response_hash" text,
	"status" text DEFAULT 'started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpointed_at" timestamp with time zone,
	CONSTRAINT "revision_operation_states_status" CHECK ("revision_operation_states"."status" in ('started','response_validated')),
	CONSTRAINT "revision_operation_states_response_pair" CHECK (("status"='started' AND "response" IS NULL AND "response_hash" IS NULL) OR ("status"='response_validated' AND "response" IS NOT NULL AND "response_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD COLUMN "location_json" jsonb;--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD COLUMN "hunks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD COLUMN "manifest_hash" text;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_producing_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("producing_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER revision_operation_states_identity_immutable BEFORE UPDATE ON revision_operation_states FOR EACH ROW WHEN (OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.response IS NOT NULL) EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER revision_operation_states_no_delete BEFORE DELETE ON revision_operation_states FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
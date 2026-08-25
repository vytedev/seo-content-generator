CREATE TABLE "coherence_checkpoints" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"producing_step_execution_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"response_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpointed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "content_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" text NOT NULL,
	"version" text NOT NULL,
	"kind" text NOT NULL,
	"status" "editorial_status" DEFAULT 'pending_editorial_approval' NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_templates_kind_check" CHECK ("content_templates"."kind" in ('writer_submission','blog_schema'))
);
--> statement-breakpoint
CREATE TABLE "export_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"render_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_producing_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("producing_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_templates_identity_unique" ON "content_templates" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "export_manifests_run_document_unique" ON "export_manifests" USING btree ("run_id","document_version_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_step_1_12_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '% is immutable',TG_TABLE_NAME; END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER content_templates_immutable BEFORE UPDATE OR DELETE ON content_templates FOR EACH ROW EXECUTE FUNCTION forbid_step_1_12_mutation();--> statement-breakpoint
CREATE TRIGGER export_manifests_immutable BEFORE UPDATE OR DELETE ON export_manifests FOR EACH ROW EXECUTE FUNCTION forbid_step_1_12_mutation();--> statement-breakpoint
CREATE TRIGGER coherence_checkpoints_no_delete BEFORE DELETE ON coherence_checkpoints FOR EACH ROW EXECUTE FUNCTION forbid_step_1_12_mutation();
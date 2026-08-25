CREATE TABLE "step_outputs" (
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_outputs_run_id_document_version_id_step_pk" PRIMARY KEY("run_id","document_version_id","step")
);
--> statement-breakpoint
ALTER TABLE "step_outputs" ADD CONSTRAINT "step_outputs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_outputs" ADD CONSTRAINT "step_outputs_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_outputs" ADD CONSTRAINT "step_outputs_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER step_outputs_immutable BEFORE UPDATE OR DELETE ON step_outputs FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TABLE "coherence_recoveries" (
	"operation_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"producing_step_execution_id" uuid NOT NULL,
	"recovery_step_execution_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coherence_recoveries_operation_id_recovery_step_execution_id_pk" PRIMARY KEY("operation_id","recovery_step_execution_id"),
	CONSTRAINT "coherence_recoveries_outcome_check" CHECK ("coherence_recoveries"."outcome" in ('export'))
);
--> statement-breakpoint
ALTER TABLE "coherence_recoveries" ADD CONSTRAINT "coherence_recoveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_recoveries" ADD CONSTRAINT "coherence_recoveries_operation_id_provider_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."provider_operations"("operation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_recoveries" ADD CONSTRAINT "coherence_recoveries_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_recoveries" ADD CONSTRAINT "coherence_recoveries_producing_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("producing_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coherence_recoveries" ADD CONSTRAINT "coherence_recoveries_recovery_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("recovery_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER coherence_recoveries_immutable BEFORE UPDATE OR DELETE ON coherence_recoveries FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

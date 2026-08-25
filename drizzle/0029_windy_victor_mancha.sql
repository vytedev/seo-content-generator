CREATE TABLE "revision_provider_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"planning_version" text NOT NULL,
	"failure_category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_provider_failures_category" CHECK ("revision_provider_failures"."failure_category" in ('configuration','malformed_response','transient_exhausted','timeout','guard_rejected'))
);
--> statement-breakpoint
ALTER TABLE "revision_provider_failures" ADD CONSTRAINT "revision_provider_failures_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_provider_failures" ADD CONSTRAINT "revision_provider_failures_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_provider_failures_execution_unique" ON "revision_provider_failures" USING btree ("step_execution_id");--> statement-breakpoint
CREATE INDEX "revision_provider_failures_lock_identity_idx" ON "revision_provider_failures" USING btree ("run_id","provider","model","prompt_version","planning_version","failure_category");
--> statement-breakpoint
CREATE TRIGGER revision_provider_failures_immutable BEFORE UPDATE OR DELETE ON revision_provider_failures FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
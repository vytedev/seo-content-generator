CREATE TABLE "exceptional_correction_authorisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"deterministic_rerun_step_execution_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"blocker_set_hash" text NOT NULL,
	"blocker_bindings" jsonb NOT NULL,
	"explicit_confirmation" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptional_correction_authorisations_confirmed" CHECK ("exceptional_correction_authorisations"."explicit_confirmation" = true),
	CONSTRAINT "exceptional_correction_authorisations_hash" CHECK (length("exceptional_correction_authorisations"."blocker_set_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_revision_source";--> statement-breakpoint
ALTER TABLE "revision_noop_completions" DROP CONSTRAINT "revision_noop_completions_source";--> statement-breakpoint
ALTER TABLE "exceptional_correction_authorisations" ADD CONSTRAINT "exceptional_correction_authorisations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptional_correction_authorisations" ADD CONSTRAINT "exceptional_correction_authorisations_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptional_correction_authorisations" ADD CONSTRAINT "exceptional_correction_authorisations_deterministic_rerun_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("deterministic_rerun_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exceptional_correction_authorisations_run_unique" ON "exceptional_correction_authorisations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exceptional_correction_authorisations_idempotency_unique" ON "exceptional_correction_authorisations" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_revision_source" CHECK (("document_versions"."revision" = 1 and "document_versions"."revision_source" is null) or ("document_versions"."revision" > 1 and "document_versions"."revision_source" in ('operator_findings','deterministic_repair','coherence_repair','operator_authorised_repair')));--> statement-breakpoint
ALTER TABLE "revision_noop_completions" ADD CONSTRAINT "revision_noop_completions_source" CHECK ("revision_noop_completions"."revision_source" in ('operator_findings','deterministic_repair','coherence_repair','operator_authorised_repair'));--> statement-breakpoint
CREATE TRIGGER exceptional_correction_authorisations_immutable
BEFORE UPDATE OR DELETE ON exceptional_correction_authorisations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
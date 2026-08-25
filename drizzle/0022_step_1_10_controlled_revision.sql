CREATE TABLE "revision_finding_audits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "operation_id" text NOT NULL,
  "step_execution_id" uuid NOT NULL,
  "source_document_version_id" uuid NOT NULL,
  "result_document_version_id" uuid NOT NULL,
  "finding_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "location" text NOT NULL,
  "changed" boolean NOT NULL,
  "before_hash" text NOT NULL,
  "after_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "revision_finding_audits_ordinal" CHECK ("ordinal" >= 0),
  CONSTRAINT "revision_finding_audits_status" CHECK ("status" in ('applied','unable'))
);
--> statement-breakpoint
CREATE TABLE "revision_noop_completions" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL,
  "step_execution_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "revision_source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "revision_noop_completions_source" CHECK ("revision_source" in ('operator_findings','coherence_repair'))
);
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_step_run_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_source_run_fk" FOREIGN KEY ("source_document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_result_run_fk" FOREIGN KEY ("result_document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_noop_completions" ADD CONSTRAINT "revision_noop_completions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_noop_completions" ADD CONSTRAINT "revision_noop_completions_step_run_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "revision_noop_completions" ADD CONSTRAINT "revision_noop_completions_document_run_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "revision_finding_audits_operation_ordinal_unique" ON "revision_finding_audits" ("operation_id","ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "revision_finding_audits_operation_finding_unique" ON "revision_finding_audits" ("operation_id","finding_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "revision_noop_completions_execution_unique" ON "revision_noop_completions" ("step_execution_id");
--> statement-breakpoint
CREATE TRIGGER revision_finding_audits_immutable BEFORE UPDATE OR DELETE ON revision_finding_audits FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER revision_noop_completions_immutable BEFORE UPDATE OR DELETE ON revision_noop_completions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

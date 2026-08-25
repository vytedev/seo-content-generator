CREATE TABLE "provider_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE restrict,
  "document_version_id" uuid NOT NULL,
  "step_execution_id" uuid NOT NULL,
  "operation" text NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_operations_document_run_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "document_versions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "provider_operations_execution_run_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "step_executions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "provider_operations_kind_check" CHECK ("operation" in ('revision_pass','final_coherence_export'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operations_run_operation_document_unique" ON "provider_operations" ("run_id","operation","document_version_id");
--> statement-breakpoint
CREATE TRIGGER provider_operations_immutable BEFORE UPDATE OR DELETE ON provider_operations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

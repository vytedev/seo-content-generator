ALTER TABLE "revision_operation_states" DROP CONSTRAINT "revision_operation_states_status";--> statement-breakpoint
ALTER TABLE "revision_operation_states" DROP CONSTRAINT "revision_operation_states_response_pair";--> statement-breakpoint
ALTER TABLE "revision_finding_audits" DROP CONSTRAINT "revision_finding_audits_finding_id_findings_id_fk";
--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "revision_source" text;--> statement-breakpoint
-- This is a one-time lineage backfill for rows created before revision_source existed.
-- The table remains append-only in normal operation; disable only its immutable trigger
-- within the migration transaction, then restore it before adding the constraint.
ALTER TABLE "document_versions" DISABLE TRIGGER "document_versions_immutable";--> statement-breakpoint
UPDATE "document_versions" d SET "revision_source" = a.body_text::jsonb->>'revision_source'
FROM "artifacts" a
WHERE d.revision > 1 AND a.run_id=d.run_id AND a.step_execution_id=(
  SELECT produced.step_execution_id FROM artifacts produced
  WHERE produced.id=d.artifact_id AND produced.run_id=d.run_id
) AND a.kind='revision_request';--> statement-breakpoint
UPDATE "document_versions" d SET "revision_source" = n.revision_source
FROM "revision_noop_completions" n
WHERE d.id=n.document_version_id AND d.run_id=n.run_id
  AND d.revision > 1 AND d.revision_source IS NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ENABLE TRIGGER "document_versions_immutable";--> statement-breakpoint
INSERT INTO "revision_operation_states"(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash,status)
SELECT a.operation_id,a.run_id,a.source_document_version_id,a.step_execution_id,
       'legacy-audit:'||a.operation_id,'started'
FROM "revision_finding_audits" a
LEFT JOIN "revision_operation_states" s ON s.operation_id=a.operation_id
WHERE s.operation_id IS NULL
GROUP BY a.operation_id,a.run_id,a.source_document_version_id,a.step_execution_id;--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_operation_run_unique" UNIQUE("operation_id","run_id");--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_operation_id_run_id_revision_operation_states_operation_id_run_id_fk" FOREIGN KEY ("operation_id","run_id") REFERENCES "public"."revision_operation_states"("operation_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ADD CONSTRAINT "revision_finding_audits_finding_id_run_id_findings_id_run_id_fk" FOREIGN KEY ("finding_id","run_id") REFERENCES "public"."findings"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_revision_source" CHECK (("document_versions"."revision" = 1 and "document_versions"."revision_source" is null) or ("document_versions"."revision" > 1 and "document_versions"."revision_source" in ('operator_findings','deterministic_repair','coherence_repair')));--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_status" CHECK ("revision_operation_states"."status" in ('started','provider_in_flight','response_validated'));--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_response_pair" CHECK (("status" in ('started','provider_in_flight') AND "response" IS NULL AND "response_hash" IS NULL) OR ("status"='response_validated' AND "response" IS NOT NULL AND "response_hash" IS NOT NULL));
ALTER TABLE "calibration_run_snapshots" ADD COLUMN "pipeline_run_id" uuid;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD COLUMN "final_document_version_id" uuid;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD COLUMN "export_id" uuid;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD COLUMN "pipeline_outcome" text;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_run_snapshot_slot_unique" UNIQUE("calibration_run_id","snapshot_id","slot");--> statement-breakpoint
ALTER TABLE "calibration_results" ADD CONSTRAINT "calibration_results_bound_snapshot_fk" FOREIGN KEY ("calibration_run_id","snapshot_id","slot") REFERENCES "public"."calibration_run_snapshots"("calibration_run_id","snapshot_id","slot") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_pipeline_run_id_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_final_document_version_id_document_versions_id_fk" FOREIGN KEY ("final_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_export_id_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."exports"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_document_run_fk" FOREIGN KEY ("final_document_version_id","pipeline_run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_pipeline_outcome" CHECK ("pipeline_outcome" in ('succeeded','blocked'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_calibration_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_run_id IS NULL OR NEW.final_document_version_id IS NULL OR NEW.pipeline_outcome IS NULL THEN
    RAISE EXCEPTION 'calibration pipeline binding is required' USING ERRCODE='23514';
  END IF;
  IF NEW.pipeline_outcome='succeeded' AND NEW.export_id IS NULL THEN
    RAISE EXCEPTION 'successful calibration pipeline requires export' USING ERRCODE='23514';
  END IF;
  IF NEW.export_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM exports e WHERE e.id=NEW.export_id AND e.run_id=NEW.pipeline_run_id
      AND e.document_version_id=NEW.final_document_version_id AND e.status='succeeded'
  ) THEN RAISE EXCEPTION 'calibration export binding mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER calibration_binding_check BEFORE INSERT ON calibration_run_snapshots FOR EACH ROW EXECUTE FUNCTION enforce_calibration_binding();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_pending_calibration_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reference_versions v WHERE v.id=NEW.reference_version_id
      AND v.reference_document_id=NEW.reference_document_id
      AND v.editorial_status='pending_editorial_approval'
  ) THEN RAISE EXCEPTION 'calibration proposal must reference a pending version' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER calibration_proposal_pending_check BEFORE INSERT ON calibration_reference_proposals FOR EACH ROW EXECUTE FUNCTION enforce_pending_calibration_proposal();--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pending_reference_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM calibration_reference_proposals WHERE reference_version_id=NEW.reference_version_id) THEN
    RAISE EXCEPTION 'calibration proposal version cannot be activated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER reference_activation_approved_check BEFORE INSERT OR UPDATE ON reference_activations FOR EACH ROW EXECUTE FUNCTION prevent_pending_reference_activation();--> statement-breakpoint

CREATE TRIGGER calibration_run_snapshots_insert_only BEFORE UPDATE OR DELETE ON calibration_run_snapshots FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_runs_no_delete BEFORE DELETE ON calibration_runs FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();
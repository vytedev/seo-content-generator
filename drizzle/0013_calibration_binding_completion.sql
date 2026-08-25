-- Local provisional calibration records created before pipeline binding existed cannot be
-- reconstructed safely. Remove only incomplete calibration runs and their dependants; keep
-- reusable global snapshots and unrelated reference versions.
CREATE TEMP TABLE calibration_legacy_runs AS
SELECT DISTINCT calibration_run_id
FROM calibration_run_snapshots
WHERE pipeline_run_id IS NULL
   OR final_document_version_id IS NULL
   OR pipeline_outcome IS NULL;--> statement-breakpoint

CREATE TEMP TABLE calibration_legacy_proposal_versions AS
SELECT p.reference_version_id
FROM calibration_reference_proposals p
JOIN calibration_legacy_runs l ON l.calibration_run_id=p.calibration_run_id;--> statement-breakpoint

DROP TRIGGER IF EXISTS calibration_reference_proposals_immutable ON calibration_reference_proposals;--> statement-breakpoint
DROP TRIGGER IF EXISTS calibration_reports_immutable ON calibration_reports;--> statement-breakpoint
DROP TRIGGER IF EXISTS calibration_results_immutable ON calibration_results;--> statement-breakpoint
DROP TRIGGER IF EXISTS calibration_run_snapshots_immutable ON calibration_run_snapshots;--> statement-breakpoint
DROP TRIGGER IF EXISTS calibration_run_snapshots_insert_only ON calibration_run_snapshots;--> statement-breakpoint
DROP TRIGGER IF EXISTS calibration_runs_no_delete ON calibration_runs;--> statement-breakpoint

DELETE FROM calibration_reference_proposals p USING calibration_legacy_runs l
WHERE p.calibration_run_id=l.calibration_run_id;--> statement-breakpoint
DELETE FROM reference_versions v USING calibration_legacy_proposal_versions l
WHERE v.id=l.reference_version_id
  AND v.editorial_status='pending_editorial_approval'
  AND NOT EXISTS (SELECT 1 FROM calibration_reference_proposals p WHERE p.reference_version_id=v.id)
  AND NOT EXISTS (SELECT 1 FROM reference_activations a WHERE a.reference_version_id=v.id);--> statement-breakpoint
DELETE FROM calibration_reports p USING calibration_legacy_runs l
WHERE p.calibration_run_id=l.calibration_run_id;--> statement-breakpoint
DELETE FROM calibration_results r USING calibration_legacy_runs l
WHERE r.calibration_run_id=l.calibration_run_id;--> statement-breakpoint
DELETE FROM calibration_run_snapshots s USING calibration_legacy_runs l
WHERE s.calibration_run_id=l.calibration_run_id;--> statement-breakpoint
DELETE FROM calibration_runs r USING calibration_legacy_runs l WHERE r.id=l.calibration_run_id;--> statement-breakpoint

DROP TABLE calibration_legacy_proposal_versions;--> statement-breakpoint
DROP TABLE calibration_legacy_runs;--> statement-breakpoint

ALTER TABLE calibration_run_snapshots ALTER COLUMN pipeline_run_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE calibration_run_snapshots ALTER COLUMN final_document_version_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE calibration_run_snapshots ALTER COLUMN pipeline_outcome SET NOT NULL;--> statement-breakpoint
ALTER TABLE calibration_run_snapshots ADD CONSTRAINT calibration_run_snapshots_successful_export
CHECK (pipeline_outcome <> 'succeeded' OR export_id IS NOT NULL);--> statement-breakpoint

CREATE TRIGGER calibration_reference_proposals_immutable BEFORE UPDATE OR DELETE ON calibration_reference_proposals FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_reports_immutable BEFORE UPDATE OR DELETE ON calibration_reports FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_results_immutable BEFORE UPDATE OR DELETE ON calibration_results FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_run_snapshots_insert_only BEFORE UPDATE OR DELETE ON calibration_run_snapshots FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_runs_no_delete BEFORE DELETE ON calibration_runs FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();

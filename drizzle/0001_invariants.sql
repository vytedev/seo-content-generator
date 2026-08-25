CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER findings_immutable BEFORE UPDATE OR DELETE ON findings FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER finding_dispositions_immutable BEFORE UPDATE OR DELETE ON finding_dispositions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER sources_immutable BEFORE UPDATE OR DELETE ON sources FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER claim_sources_immutable BEFORE UPDATE OR DELETE ON claim_sources FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER reference_versions_immutable BEFORE UPDATE OR DELETE ON reference_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER step_reference_snapshots_immutable BEFORE UPDATE OR DELETE ON step_reference_snapshots FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER provider_usage_immutable BEFORE UPDATE OR DELETE ON provider_usage FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER exports_immutable BEFORE UPDATE OR DELETE ON exports FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_reference_snapshot() RETURNS trigger AS $$
DECLARE execution_step pipeline_step; expected_hash text;
BEGIN
 SELECT step INTO execution_step FROM step_executions WHERE id=NEW.step_execution_id;
 SELECT content_hash INTO expected_hash FROM reference_versions WHERE id=NEW.reference_version_id AND reference_document_id=NEW.reference_document_id;
 IF execution_step IS NULL OR expected_hash IS NULL THEN RAISE EXCEPTION 'snapshot references missing execution or version'; END IF;
 IF NEW.content_hash<>expected_hash THEN RAISE EXCEPTION 'snapshot hash does not match reference version'; END IF;
 IF NOT EXISTS(SELECT 1 FROM substep_reference_map WHERE reference_document_id=NEW.reference_document_id AND step=execution_step) THEN RAISE EXCEPTION 'reference is not mapped to execution step'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER step_reference_snapshots_validate BEFORE INSERT ON step_reference_snapshots FOR EACH ROW EXECUTE FUNCTION validate_reference_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_reference_snapshot_completeness() RETURNS trigger AS $$
DECLARE execution_step pipeline_step; expected_count integer; actual_count integer;
BEGIN
 SELECT step INTO execution_step FROM step_executions WHERE id=NEW.step_execution_id;
 SELECT count(*) INTO expected_count FROM substep_reference_map WHERE step=execution_step;
 SELECT count(*) INTO actual_count FROM step_reference_snapshots WHERE step_execution_id=NEW.step_execution_id;
 IF expected_count<>actual_count THEN RAISE EXCEPTION 'execution must snapshot every mapped reference'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER step_reference_snapshots_complete AFTER INSERT ON step_reference_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reference_snapshot_completeness();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_claim_source() RETURNS trigger AS $$
DECLARE claim_status verification_status; claim_type_value claim_type;
BEGIN
 SELECT status,type INTO claim_status,claim_type_value FROM claims WHERE id=NEW.claim_id;
 IF claim_status<>NEW.status THEN RAISE EXCEPTION 'claim source status must match claim status'; END IF;
 IF claim_type_value='provenance' AND nullif(btrim(coalesce(NEW.evidence,'')),'') IS NULL THEN RAISE EXCEPTION 'provenance claims require source evidence'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER claim_sources_validate BEFORE INSERT ON claim_sources FOR EACH ROW EXECUTE FUNCTION validate_claim_source();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_claim_evidence() RETURNS trigger AS $$
BEGIN
 IF NEW.status='verified' AND NOT EXISTS(SELECT 1 FROM claim_sources WHERE claim_id=NEW.id AND status='verified') THEN RAISE EXCEPTION 'verified claim requires a verified source'; END IF;
 IF NEW.type='provenance' AND NOT EXISTS(SELECT 1 FROM claim_sources WHERE claim_id=NEW.id) THEN RAISE EXCEPTION 'provenance claim requires a source record'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claims_evidence_required AFTER INSERT ON claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_claim_evidence();
--> statement-breakpoint
CREATE UNIQUE INDEX exports_run_document_destination_unique ON exports(run_id,document_version_id,destination);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_export_input() RETURNS trigger AS $$
DECLARE document_hash text; artifact_hash text;
BEGIN
 SELECT content_hash INTO document_hash FROM document_versions WHERE id=NEW.document_version_id;
 SELECT content_hash INTO artifact_hash FROM artifacts WHERE id=NEW.export_artifact_id;
 IF NEW.input_hash<>encode(digest(document_hash||':'||artifact_hash||':'||NEW.destination,'sha256'),'hex') THEN RAISE EXCEPTION 'export input hash does not match immutable inputs'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER exports_validate_input BEFORE INSERT ON exports FOR EACH ROW EXECUTE FUNCTION validate_export_input();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_step_execution(execution_id uuid,worker_owner text,lease_duration interval,new_token uuid) RETURNS SETOF step_executions AS $$
BEGIN RETURN QUERY UPDATE step_executions SET status='leased',lease_token=new_token,lease_owner=worker_owner,lease_expires_at=clock_timestamp()+lease_duration,updated_at=clock_timestamp() WHERE id=execution_id AND status IN('queued','retryable_failed','leased') AND(lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION start_step_execution(execution_id uuid,fencing_token uuid) RETURNS boolean AS $$
DECLARE changed integer; BEGIN UPDATE step_executions SET status='running',started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=execution_id AND lease_token=fencing_token AND status='leased' AND lease_expires_at>clock_timestamp(); GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION heartbeat_step_execution(execution_id uuid,fencing_token uuid,lease_duration interval) RETURNS boolean AS $$
DECLARE changed integer; BEGIN UPDATE step_executions SET lease_expires_at=clock_timestamp()+lease_duration,updated_at=clock_timestamp() WHERE id=execution_id AND lease_token=fencing_token AND status IN('leased','running') AND lease_expires_at>clock_timestamp(); GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1; END; $$ LANGUAGE plpgsql;

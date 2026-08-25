CREATE OR REPLACE FUNCTION complete_step_execution(execution_id uuid,fencing_token uuid) RETURNS boolean AS $$
DECLARE changed integer;
BEGIN
 UPDATE step_executions SET status='succeeded',completed_at=clock_timestamp(),lease_token=NULL,lease_owner=NULL,
 lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE id=execution_id AND lease_token=fencing_token AND status='running' AND lease_expires_at>clock_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fail_step_execution(execution_id uuid,fencing_token uuid,failure jsonb) RETURNS boolean AS $$
DECLARE changed integer;
BEGIN
 UPDATE step_executions SET status='retryable_failed',error=failure,lease_token=NULL,lease_owner=NULL,
 lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE id=execution_id AND lease_token=fencing_token AND status IN('leased','running') AND lease_expires_at>clock_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END; $$ LANGUAGE plpgsql;

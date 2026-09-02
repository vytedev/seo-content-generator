-- Classify every evidence-free historical review continuation conservatively, including
-- live/expired leases and previously parked jobs. The 0042 guard is dropped only inside this
-- migration transaction so the corrective update can cover transitions that were not part of
-- the runtime state machine; the lease-shape constraint remains satisfied by the same update.
DROP TRIGGER pipeline_queue_jobs_state_guard ON pipeline_queue_jobs;--> statement-breakpoint
UPDATE pipeline_queue_jobs q
SET state='operator_action',
    lease_token=null,
    lease_owner=null,
    lease_expires_at=null,
    last_error_code='legacy_review_explicit_recovery',
    updated_at=clock_timestamp()
FROM runs r
WHERE q.run_id=r.id
  AND q.state IN ('ready','leased','retry_wait','parked','operator_action')
  AND r.status='retryable_failed'
  AND r.current_step IN ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
  AND NOT EXISTS (SELECT 1 FROM review_operation_states o WHERE o.run_id=r.id)
  AND q.options->'authorise_legacy_review_recovery' IS DISTINCT FROM 'true'::jsonb;--> statement-breakpoint
CREATE TRIGGER pipeline_queue_jobs_state_guard BEFORE UPDATE ON pipeline_queue_jobs FOR EACH ROW EXECUTE FUNCTION protect_pipeline_queue_job();--> statement-breakpoint

-- Insert/backfill classification must also remove a supplied lease atomically so the queue
-- lease-shape constraint cannot reject the safe operator-action result.
CREATE OR REPLACE FUNCTION classify_pipeline_queue_insert() RETURNS trigger AS $$
DECLARE
  historical_review boolean;
BEGIN
  SELECT r.status='retryable_failed'
     AND r.current_step IN ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
     AND NOT EXISTS (SELECT 1 FROM review_operation_states o WHERE o.run_id=r.id)
  INTO historical_review
  FROM runs r WHERE r.id=NEW.run_id;
  IF historical_review AND NEW.options->'authorise_legacy_review_recovery' IS DISTINCT FROM 'true'::jsonb THEN
    NEW.state := 'operator_action';
    NEW.lease_token := null;
    NEW.lease_owner := null;
    NEW.lease_expires_at := null;
    NEW.last_error_code := 'legacy_review_explicit_recovery';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
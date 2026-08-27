-- Corrective queue migration. 0041 is applied history and intentionally unchanged.
CREATE TABLE "review_operation_states" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE restrict,
  "document_version_id" uuid NOT NULL,
  "producing_step_execution_id" uuid NOT NULL,
  "step" pipeline_step NOT NULL,
  "request_hash" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "status" text DEFAULT 'started' NOT NULL,
  "response" jsonb,
  "response_hash" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "checkpointed_at" timestamptz,
  CONSTRAINT "review_operation_states_document_fk" FOREIGN KEY("document_version_id","run_id") REFERENCES "document_versions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "review_operation_states_execution_fk" FOREIGN KEY("producing_step_execution_id","run_id") REFERENCES "step_executions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "review_operation_states_review_step" CHECK ("step" in ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')),
  CONSTRAINT "review_operation_states_status" CHECK ("status" in ('started','provider_in_flight','checkpointed')),
  CONSTRAINT "review_operation_states_response_pair" CHECK (("status" in ('started','provider_in_flight') and "response" is null and "response_hash" is null and "checkpointed_at" is null) or ("status"='checkpointed' and "response" is not null and "response_hash" is not null and "checkpointed_at" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "review_operation_states_identity_unique" ON "review_operation_states"("run_id","document_version_id","step","request_hash","provider","model");--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_review_operation_state() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.step IS DISTINCT FROM NEW.step OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.provider IS DISTINCT FROM NEW.provider OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'review operation identity is immutable';
  END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL THEN RETURN NEW; END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid review operation transition: % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER review_operation_states_guard BEFORE UPDATE ON review_operation_states FOR EACH ROW EXECUTE FUNCTION protect_review_operation_state();--> statement-breakpoint
CREATE TRIGGER review_operation_states_no_delete BEFORE DELETE ON review_operation_states FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint

-- One historical coordination row per run. Never auto-spend an earlier draft whose
-- provider outcome cannot be proved, including structured-invalid legacy Step 1.3 attempts.
INSERT INTO pipeline_queue_jobs(run_id,state,last_error_code)
SELECT r.id,
 CASE
  WHEN r.status='succeeded' THEN 'completed'::queue_job_state
  WHEN r.status='cancelled' THEN 'cancelled'::queue_job_state
  WHEN r.status IN ('waiting','blocked') THEN 'parked'::queue_job_state
  WHEN EXISTS(SELECT 1 FROM draft_operation_states d WHERE d.run_id=r.id AND d.status='provider_in_flight') THEN 'operator_action'::queue_job_state
  WHEN EXISTS(SELECT 1 FROM revision_operation_states v WHERE v.run_id=r.id AND v.status='provider_in_flight') THEN 'operator_action'::queue_job_state
  WHEN EXISTS(SELECT 1 FROM coherence_checkpoints c WHERE c.run_id=r.id AND c.status='provider_in_flight') THEN 'operator_action'::queue_job_state
  WHEN r.current_step='draft' AND r.status='retryable_failed' AND NOT EXISTS(SELECT 1 FROM draft_operation_states d WHERE d.run_id=r.id) THEN 'operator_action'::queue_job_state
  ELSE 'ready'::queue_job_state
 END,
 CASE
  WHEN r.current_step='draft' AND r.status='retryable_failed' AND NOT EXISTS(SELECT 1 FROM draft_operation_states d WHERE d.run_id=r.id) THEN 'legacy_draft_explicit_recovery'
  WHEN r.status IN ('waiting','blocked') THEN 'historical_operator_wait'
  WHEN r.status IN ('succeeded','cancelled') THEN 'historical_terminal'
  WHEN EXISTS(SELECT 1 FROM draft_operation_states d WHERE d.run_id=r.id AND d.status='provider_in_flight')
    OR EXISTS(SELECT 1 FROM revision_operation_states v WHERE v.run_id=r.id AND v.status='provider_in_flight')
    OR EXISTS(SELECT 1 FROM coherence_checkpoints c WHERE c.run_id=r.id AND c.status='provider_in_flight') THEN 'ambiguous_paid_operation'
  ELSE 'historical_safe_continuation'
 END
FROM runs r
WHERE NOT EXISTS(SELECT 1 FROM pipeline_queue_jobs q WHERE q.run_id=r.id);--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_pipeline_queue_job() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'queue job identity is immutable';
  END IF;
  IF OLD.options IS DISTINCT FROM NEW.options AND NOT (OLD.state IN ('parked','operator_action') AND NEW.state='ready') THEN
    RAISE EXCEPTION 'queue options may change only during explicit reactivation';
  END IF;
  IF (OLD.state,NEW.state) IN (
    ('ready','leased'),('retry_wait','leased'),('leased','leased'),('leased','ready'),
    ('leased','retry_wait'),('leased','parked'),('leased','operator_action'),
    ('leased','completed'),('leased','cancelled'),
    ('ready','parked'),('ready','operator_action'),('ready','completed'),
    ('retry_wait','parked'),('retry_wait','operator_action'),('retry_wait','completed'),
    ('parked','ready'),('operator_action','ready'),('ready','cancelled'),
    ('retry_wait','cancelled'),('parked','cancelled'),('operator_action','cancelled')
  ) OR OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid queue transition: % to %', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pipeline_queue_jobs_state_guard BEFORE UPDATE ON pipeline_queue_jobs FOR EACH ROW EXECUTE FUNCTION protect_pipeline_queue_job();

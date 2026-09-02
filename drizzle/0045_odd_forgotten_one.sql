ALTER TABLE "pipeline_queue_jobs" ADD COLUMN "pending_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_queue_jobs" ADD CONSTRAINT "pipeline_queue_jobs_pending_options_shape" CHECK (jsonb_typeof("pipeline_queue_jobs"."pending_options")='object' and "pipeline_queue_jobs"."pending_options" - array['refresh_link_discovery','authorise_legacy_draft_recovery','authorise_legacy_review_recovery']::text[] = '{}'::jsonb and ("pipeline_queue_jobs"."pending_options"->'refresh_link_discovery' is null or "pipeline_queue_jobs"."pending_options"->'refresh_link_discovery'='true'::jsonb) and ("pipeline_queue_jobs"."pending_options"->'authorise_legacy_draft_recovery' is null or "pipeline_queue_jobs"."pending_options"->'authorise_legacy_draft_recovery'='true'::jsonb) and ("pipeline_queue_jobs"."pending_options"->'authorise_legacy_review_recovery' is null or "pipeline_queue_jobs"."pending_options"->'authorise_legacy_review_recovery'='true'::jsonb));--> statement-breakpoint
-- Permit monotonic pending-signal accumulation while active and fenced consumption into a
-- fresh continuation, without mutating the options observed by the current lease.
CREATE OR REPLACE FUNCTION protect_pipeline_queue_job() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'queue job identity is immutable';
  END IF;
  IF OLD.options IS DISTINCT FROM NEW.options AND NOT (
    (OLD.state IN ('parked','operator_action') AND NEW.state='ready') OR
    (OLD.state='leased' AND NEW.state='ready' AND OLD.pending_options<>'{}'::jsonb
      AND NEW.options=OLD.pending_options AND NEW.pending_options='{}'::jsonb)
  ) THEN RAISE EXCEPTION 'queue options may change only during explicit reactivation or pending continuation consumption'; END IF;
  IF OLD.pending_options IS DISTINCT FROM NEW.pending_options AND NOT (
    (OLD.state IN ('ready','leased','retry_wait') AND NEW.state=OLD.state AND NEW.pending_options @> OLD.pending_options) OR
    (OLD.state='leased' AND NEW.state='ready' AND NEW.pending_options='{}'::jsonb)
  ) THEN RAISE EXCEPTION 'invalid pending queue continuation transition'; END IF;
  IF (OLD.state,NEW.state) IN (
    ('ready','leased'),('retry_wait','leased'),('leased','leased'),('leased','ready'),
    ('leased','retry_wait'),('leased','parked'),('leased','operator_action'),('leased','completed'),('leased','cancelled'),
    ('ready','parked'),('ready','operator_action'),('ready','completed'),('retry_wait','parked'),
    ('retry_wait','operator_action'),('retry_wait','completed'),('parked','ready'),('operator_action','ready'),
    ('ready','cancelled'),('retry_wait','cancelled'),('parked','cancelled'),('operator_action','cancelled')
  ) OR OLD IS NOT DISTINCT FROM NEW OR
    (OLD.state=NEW.state AND OLD.state IN ('ready','leased','retry_wait') AND NEW.pending_options @> OLD.pending_options)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid queue transition: % to %', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

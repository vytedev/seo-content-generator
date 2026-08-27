CREATE TYPE "public"."queue_job_phase" AS ENUM('pre_downstream', 'downstream_started');--> statement-breakpoint
ALTER TABLE "pipeline_queue_jobs" ADD COLUMN "phase" "queue_job_phase" DEFAULT 'pre_downstream' NOT NULL;--> statement-breakpoint
-- Phase is a narrow authority gate. The existing queue transition trigger validates every other
-- field; this companion trigger prevents phase changes from being smuggled through those branches.
CREATE OR REPLACE FUNCTION protect_pipeline_queue_phase() RETURNS trigger AS $$
BEGIN
  IF OLD.phase='downstream_started' AND NEW.pending_refresh IS DISTINCT FROM OLD.pending_refresh THEN
    RAISE EXCEPTION 'refresh window is closed after downstream start';
  END IF;
  IF OLD.phase = NEW.phase THEN RETURN NEW; END IF;

  -- The worker may close the refresh window only while retaining its exact active fence.
  IF OLD.phase='pre_downstream' AND NEW.phase='downstream_started'
     AND OLD.state='leased' AND NEW.state='leased'
     AND OLD.attempt=NEW.attempt AND OLD.available_at=NEW.available_at
     AND OLD.lease_token=NEW.lease_token AND OLD.lease_owner=NEW.lease_owner
     AND NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at AND OLD.options=NEW.options
     AND NOT OLD.pending_refresh AND NOT NEW.pending_refresh
     AND OLD.resume_after_refresh=NEW.resume_after_refresh
     AND OLD.pending_options=NEW.pending_options
     AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
  THEN RETURN NEW; END IF;

  -- A fully validated queue continuation or explicit settled-job reactivation opens a new window.
  IF OLD.phase='downstream_started' AND NEW.phase='pre_downstream'
     AND NEW.state='ready'
     AND ((OLD.state='leased' AND (OLD.resume_after_refresh OR OLD.pending_refresh OR OLD.pending_options<>'{}'::jsonb))
       OR OLD.state IN ('parked','operator_action'))
  THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'invalid queue phase transition: % to %', OLD.phase, NEW.phase;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pipeline_queue_phase_guard BEFORE UPDATE ON pipeline_queue_jobs
FOR EACH ROW EXECUTE FUNCTION protect_pipeline_queue_phase();
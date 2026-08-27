ALTER TABLE "pipeline_queue_jobs" ADD COLUMN "resume_after_refresh" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Corrective append-only queue guard for dedicated, crash-safe refresh passes.
CREATE OR REPLACE FUNCTION protect_pipeline_queue_job() RETURNS trigger AS $$
DECLARE
  identity_same boolean := OLD.id=NEW.id AND OLD.run_id=NEW.run_id AND OLD.kind=NEW.kind AND OLD.created_at=NEW.created_at;
  base_same boolean := identity_same AND OLD.updated_at IS DISTINCT FROM NEW.updated_at;
BEGIN
  IF NOT identity_same THEN RAISE EXCEPTION 'queue job identity is immutable'; END IF;

  -- Fenced promotion of a pending intent into a dedicated refresh-only pass.
  IF OLD.state='leased' AND NEW.state='ready' AND OLD.pending_refresh AND NOT OLD.resume_after_refresh
     AND NEW.resume_after_refresh AND NEW.options='{"refresh_link_discovery":true}'::jsonb
     AND NOT NEW.pending_refresh AND NEW.pending_options=OLD.pending_options AND NEW.attempt=0
     AND NEW.available_at IS DISTINCT FROM OLD.available_at AND NEW.lease_token IS NULL
     AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL AND NEW.last_error_code IS NULL
  THEN RETURN NEW; END IF;

  -- Safe refresh completion restores the original unprivileged continuation exactly once.
  IF OLD.state='leased' AND NEW.state='ready' AND OLD.resume_after_refresh AND NOT NEW.resume_after_refresh
     AND OLD.options='{"refresh_link_discovery":true}'::jsonb AND NEW.options='{}'::jsonb
     AND NOT OLD.pending_refresh AND NOT NEW.pending_refresh AND NEW.pending_options='{}'::jsonb
     AND NEW.attempt=0 AND NEW.available_at IS DISTINCT FROM OLD.available_at
     AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NEW.last_error_code IS NULL
  THEN RETURN NEW; END IF;

  -- Every other transition must preserve the refresh-resume marker.
  IF OLD.resume_after_refresh IS DISTINCT FROM NEW.resume_after_refresh THEN
    RAISE EXCEPTION 'invalid refresh resume mutation';
  END IF;

  -- Idempotent pending refresh or one isolated recovery authority; no lease/fence/state mutation.
  IF OLD.state=NEW.state AND OLD.state IN ('ready','leased','retry_wait')
     AND OLD.attempt=NEW.attempt AND OLD.available_at=NEW.available_at
     AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token AND OLD.lease_owner IS NOT DISTINCT FROM NEW.lease_owner
     AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at AND OLD.options=NEW.options
     AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
     AND ((NOT OLD.pending_refresh AND NEW.pending_refresh AND OLD.pending_options=NEW.pending_options AND NEW.pending_options='{}'::jsonb)
       OR (OLD.pending_refresh=NEW.pending_refresh AND NOT NEW.pending_refresh AND OLD.pending_options='{}'::jsonb AND NEW.pending_options<>'{}'::jsonb))
  THEN RETURN NEW; END IF;

  -- Claim or expired-lease reclaim: options and pending authorities are observational.
  IF OLD.state IN ('ready','retry_wait','leased') AND NEW.state='leased' AND NEW.attempt=OLD.attempt+1
     AND NEW.lease_token IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL
     AND OLD.available_at=NEW.available_at AND OLD.options=NEW.options
     AND OLD.pending_refresh=NEW.pending_refresh AND OLD.pending_options=NEW.pending_options
     AND NEW.last_error_code IS NULL
  THEN RETURN NEW; END IF;

  -- Heartbeat changes only the expiry and timestamp.
  IF OLD.state='leased' AND NEW.state='leased' AND OLD.attempt=NEW.attempt AND OLD.available_at=NEW.available_at
     AND OLD.lease_token=NEW.lease_token AND OLD.lease_owner=NEW.lease_owner
     AND OLD.lease_expires_at IS DISTINCT FROM NEW.lease_expires_at AND OLD.options=NEW.options
     AND OLD.pending_refresh=NEW.pending_refresh AND OLD.pending_options=NEW.pending_options
     AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
  THEN RETURN NEW; END IF;

  -- Fenced continuation consumption creates exactly one fresh isolated job.
  IF OLD.state='leased' AND NEW.state='ready' AND (OLD.pending_refresh OR OLD.pending_options<>'{}'::jsonb)
     AND NEW.attempt=0 AND NEW.available_at IS DISTINCT FROM OLD.available_at
     AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NEW.options=(CASE WHEN OLD.pending_refresh THEN '{"refresh_link_discovery":true}'::jsonb ELSE OLD.pending_options END)
     AND NOT NEW.pending_refresh AND NEW.pending_options='{}'::jsonb AND NEW.last_error_code IS NULL
  THEN RETURN NEW; END IF;

  -- Leased coordination defer/retry may alter only scheduling, fence, attempt and safe error.
  IF OLD.state='leased' AND NEW.state='retry_wait' AND NEW.attempt IN (OLD.attempt, greatest(OLD.attempt-1,0))
     AND NEW.available_at IS DISTINCT FROM OLD.available_at AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND OLD.options=NEW.options AND OLD.pending_refresh=NEW.pending_refresh AND OLD.pending_options=NEW.pending_options
     AND NEW.last_error_code IS NOT NULL
  THEN RETURN NEW; END IF;

  -- Terminal/parked completion clears only the fence and records a safe code.
  IF OLD.state='leased' AND NEW.state IN ('parked','operator_action','completed','cancelled')
     AND OLD.attempt=NEW.attempt AND OLD.available_at=NEW.available_at
     AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND OLD.options=NEW.options AND OLD.pending_refresh=NEW.pending_refresh AND OLD.pending_options=NEW.pending_options
  THEN RETURN NEW; END IF;

  -- Recovery classification of unleased work changes only state/error/timestamp.
  IF OLD.state IN ('ready','retry_wait') AND NEW.state IN ('parked','operator_action','completed','cancelled')
     AND OLD.attempt=NEW.attempt AND OLD.available_at=NEW.available_at
     AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token AND OLD.lease_owner IS NOT DISTINCT FROM NEW.lease_owner AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
     AND OLD.options=NEW.options AND OLD.pending_refresh=NEW.pending_refresh AND OLD.pending_options=NEW.pending_options
  THEN RETURN NEW; END IF;

  -- Explicit operator reactivation cannot combine or inherit a pending authority.
  IF OLD.state IN ('parked','operator_action') AND NEW.state='ready' AND NEW.attempt=0
     AND NEW.available_at IS DISTINCT FROM OLD.available_at AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NOT NEW.pending_refresh AND NEW.pending_options='{}'::jsonb AND NEW.last_error_code IS NULL
  THEN RETURN NEW; END IF;

  -- Startup expiry recovery preserves options/pending authority and may only clear the fence/schedule.
  IF OLD.state='leased' AND NEW.state IN ('ready','operator_action') AND OLD.pending_refresh=NEW.pending_refresh
     AND OLD.pending_options=NEW.pending_options AND OLD.options=NEW.options AND OLD.attempt=NEW.attempt
     AND NEW.lease_token IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND (NEW.state='operator_action' OR NEW.available_at IS DISTINCT FROM OLD.available_at)
  THEN RETURN NEW; END IF;

  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid queue update: % to %', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

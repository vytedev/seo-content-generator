-- Custom migration generated with drizzle-kit --custom.
-- Extend the review-operation transition guard for reason-aware provider reservations.

CREATE OR REPLACE FUNCTION protect_review_operation_state() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
     OR OLD.step IS DISTINCT FROM NEW.step OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.provider IS DISTINCT FROM NEW.provider OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'review operation identity is immutable';
  END IF;
  IF OLD.status='started' AND NEW.status='started'
     AND OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     AND EXISTS(SELECT 1 FROM review_operation_adoptions a
                WHERE a.operation_id=OLD.operation_id AND a.run_id=OLD.run_id
                  AND a.from_step_execution_id=OLD.producing_step_execution_id
                  AND a.to_step_execution_id=NEW.producing_step_execution_id)
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
  THEN RETURN NEW; END IF;
  IF OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id THEN
    RAISE EXCEPTION 'review operation producer change requires adoption';
  END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at
     AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight'
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started'
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed'
     AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid review operation transition: % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

-- Custom migration generated with drizzle-kit --custom.
-- Install behavioural database invariants that Drizzle's declarative schema cannot express.

CREATE OR REPLACE FUNCTION validate_revision_operation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'revision operation identity is immutable';
  END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at
     AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started' AND NEW.response IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed'
     AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid revision operation transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS revision_operation_states_identity_immutable ON revision_operation_states;--> statement-breakpoint
DROP TRIGGER IF EXISTS revision_operation_states_transition ON revision_operation_states;--> statement-breakpoint
CREATE TRIGGER revision_operation_states_transition BEFORE UPDATE ON revision_operation_states FOR EACH ROW EXECUTE FUNCTION validate_revision_operation_transition();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_run_activity_command_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.command_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM run_command_outbox command
    WHERE command.command_id=NEW.command_id
      AND (command.run_id=NEW.run_id OR (
        command.kind='create_run' AND command.run_id IS NULL
        AND command.status='succeeded'
        AND command.terminal_result->>'run_id'=NEW.run_id::text
      ))
  ) THEN
    RAISE EXCEPTION 'activity command must belong to the same run';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER run_activity_events_command_owner BEFORE INSERT ON run_activity_events FOR EACH ROW EXECUTE FUNCTION validate_run_activity_command_owner();--> statement-breakpoint

CREATE TRIGGER run_activity_events_immutable BEFORE UPDATE OR DELETE ON run_activity_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER serp_evidence_immutable BEFORE UPDATE OR DELETE ON serp_evidence FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_run_command_outbox() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'run commands cannot be deleted'; END IF;
  IF OLD.command_id IS DISTINCT FROM NEW.command_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'run command identity is immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed') AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'terminal run command is immutable';
  END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  IF OLD.status='pending' AND NEW.status='processing'
     AND NEW.terminal_result IS NULL AND NEW.completed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='processing' AND NEW.status='processing'
     AND OLD.kind='probe_serp' AND NEW.kind='probe_serp'
     AND OLD.terminal_result IS NULL AND NEW.terminal_result IS NULL
     AND OLD.completed_at IS NULL AND NEW.completed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status IN ('pending','processing') AND NEW.status IN ('succeeded','failed')
     AND NEW.terminal_result IS NOT NULL AND NEW.completed_at IS NOT NULL
     AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid run command transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER run_command_outbox_guard BEFORE UPDATE OR DELETE ON run_command_outbox FOR EACH ROW EXECUTE FUNCTION protect_run_command_outbox();

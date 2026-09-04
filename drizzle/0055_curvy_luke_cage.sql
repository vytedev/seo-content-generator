ALTER TABLE "coherence_checkpoints" DROP CONSTRAINT "coherence_checkpoints_safety_reason";--> statement-breakpoint
ALTER TABLE "draft_operation_states" DROP CONSTRAINT "draft_operation_states_safety_reason";--> statement-breakpoint
ALTER TABLE "review_operation_states" DROP CONSTRAINT "review_operation_states_safety_reason";--> statement-breakpoint
ALTER TABLE "revision_operation_states" DROP CONSTRAINT "revision_operation_states_safety_reason";--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_safety_reason" CHECK ((("coherence_checkpoints"."status"='started' and "coherence_checkpoints"."ambiguity_reason" is null) or ("coherence_checkpoints"."status"='provider_in_flight' and "coherence_checkpoints"."release_reason" is null and "coherence_checkpoints"."ambiguity_reason" is not null and "coherence_checkpoints"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown')) or ("coherence_checkpoints"."status"='checkpointed' and "coherence_checkpoints"."release_reason" is null and "coherence_checkpoints"."ambiguity_reason" is null)) and ("coherence_checkpoints"."release_reason" is null or ("coherence_checkpoints"."status"='started' and "coherence_checkpoints"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))));--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_safety_reason" CHECK ((("draft_operation_states"."status"='started' and "draft_operation_states"."ambiguity_reason" is null) or ("draft_operation_states"."status"='provider_in_flight' and "draft_operation_states"."release_reason" is null and "draft_operation_states"."ambiguity_reason" is not null and "draft_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown')) or ("draft_operation_states"."status"='checkpointed' and "draft_operation_states"."release_reason" is null and "draft_operation_states"."ambiguity_reason" is null)) and ("draft_operation_states"."release_reason" is null or ("draft_operation_states"."status"='started' and "draft_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))));--> statement-breakpoint
ALTER TABLE "review_operation_states" ADD CONSTRAINT "review_operation_states_safety_reason" CHECK ((("review_operation_states"."status"='started' and "review_operation_states"."ambiguity_reason" is null) or ("review_operation_states"."status"='provider_in_flight' and "review_operation_states"."release_reason" is null and "review_operation_states"."ambiguity_reason" is not null and "review_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown')) or ("review_operation_states"."status"='checkpointed' and "review_operation_states"."release_reason" is null and "review_operation_states"."ambiguity_reason" is null)) and ("review_operation_states"."release_reason" is null or ("review_operation_states"."status"='started' and "review_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))));--> statement-breakpoint
ALTER TABLE "revision_operation_states" ADD CONSTRAINT "revision_operation_states_safety_reason" CHECK ((("revision_operation_states"."status"='started' and "revision_operation_states"."ambiguity_reason" is null) or ("revision_operation_states"."status"='provider_in_flight' and "revision_operation_states"."release_reason" is null and "revision_operation_states"."ambiguity_reason" is not null and "revision_operation_states"."ambiguity_reason" in ('provider_in_flight_without_checkpoint','external_side_effect_without_checkpoint','legacy_dispatch_outcome_unknown')) or ("revision_operation_states"."status"='checkpointed' and "revision_operation_states"."release_reason" is null and "revision_operation_states"."ambiguity_reason" is null)) and ("revision_operation_states"."release_reason" is null or ("revision_operation_states"."status"='started' and "revision_operation_states"."release_reason" in ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch'))));--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_draft_operation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.model IS DISTINCT FROM NEW.model OR OLD.contract_identity IS DISTINCT FROM NEW.contract_identity
     OR OLD.purpose IS DISTINCT FROM NEW.purpose OR OLD.operator_authorised IS DISTINCT FROM NEW.operator_authorised
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'draft operation identity is immutable'; END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at
     AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL AND NEW.response_hash IS NULL
     AND NEW.checkpointed_at IS NULL AND NEW.release_reason IS NULL AND NEW.ambiguity_reason='provider_in_flight_without_checkpoint' THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started' AND NEW.response IS NULL AND NEW.response_hash IS NULL
     AND NEW.checkpointed_at IS NULL AND NEW.release_reason IN ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch')
     AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL
     AND NEW.checkpointed_at IS NOT NULL AND NEW.release_reason IS NULL AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid draft operation transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_revision_operation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'revision operation identity is immutable'; END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason='provider_in_flight_without_checkpoint' THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IN ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch') AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid revision operation transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_review_operation_state() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
     OR OLD.step IS DISTINCT FROM NEW.step OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.model IS DISTINCT FROM NEW.model OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'review operation identity is immutable'; END IF;
  IF OLD.status='started' AND NEW.status='started' AND OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     AND EXISTS(SELECT 1 FROM review_operation_adoptions a WHERE a.operation_id=OLD.operation_id AND a.run_id=OLD.run_id
       AND a.from_step_execution_id=OLD.producing_step_execution_id AND a.to_step_execution_id=NEW.producing_step_execution_id)
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id THEN RAISE EXCEPTION 'review operation producer change requires adoption'; END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason='provider_in_flight_without_checkpoint' THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IN ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch') AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid review operation transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_coherence_checkpoint_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'coherence checkpoint identity is immutable'; END IF;
  IF OLD.status=NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at AND OLD.release_reason IS NOT DISTINCT FROM NEW.release_reason
     AND OLD.ambiguity_reason IS NOT DISTINCT FROM NEW.ambiguity_reason THEN RETURN NEW; END IF;
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason='provider_in_flight_without_checkpoint' THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='started' AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL
     AND NEW.release_reason IN ('configuration_before_dispatch','authentication_before_dispatch','billing_before_dispatch','validation_before_dispatch') AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL
     AND NEW.release_reason IS NULL AND NEW.ambiguity_reason IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid coherence checkpoint transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;

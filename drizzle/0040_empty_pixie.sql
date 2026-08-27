ALTER TABLE "draft_operation_states" ADD COLUMN "contract_identity" text;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD COLUMN "operator_authorised" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "draft_operation_states"
SET "contract_identity" = 'legacy-0039-unknown', "purpose" = 'initial'
WHERE "contract_identity" IS NULL OR "purpose" IS NULL;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ALTER COLUMN "contract_identity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ALTER COLUMN "purpose" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_operation_states_run_request_purpose_unique" ON "draft_operation_states" USING btree ("run_id","request_hash","purpose");--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_purpose_check" CHECK ("draft_operation_states"."purpose" in ('initial','legacy_operator_recovery'));--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_authorisation_check" CHECK (("draft_operation_states"."purpose" = 'initial' and "draft_operation_states"."operator_authorised" = false) or ("draft_operation_states"."purpose" = 'legacy_operator_recovery' and "draft_operation_states"."operator_authorised" = true));--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_draft_operation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.contract_identity IS DISTINCT FROM NEW.contract_identity
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR OLD.operator_authorised IS DISTINCT FROM NEW.operator_authorised
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'draft operation identity is immutable';
  END IF;
  IF OLD.status = NEW.status AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND OLD.response_hash IS NOT DISTINCT FROM NEW.response_hash
     AND OLD.checkpointed_at IS NOT DISTINCT FROM NEW.checkpointed_at THEN RETURN NEW; END IF;
  IF OLD.status = 'started' AND NEW.status = 'provider_in_flight'
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status = 'provider_in_flight' AND NEW.status = 'started'
     AND NEW.response IS NULL AND NEW.response_hash IS NULL AND NEW.checkpointed_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status = 'provider_in_flight' AND NEW.status = 'checkpointed'
     AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid draft operation transition: % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;
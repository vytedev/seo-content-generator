CREATE TABLE "draft_operation_states" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"producing_step_execution_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response" jsonb,
	"response_hash" text,
	"status" text DEFAULT 'started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpointed_at" timestamp with time zone,
	CONSTRAINT "draft_operation_states_status_check" CHECK ("draft_operation_states"."status" in ('started','provider_in_flight','checkpointed')),
	CONSTRAINT "draft_operation_states_response_pair" CHECK ((("draft_operation_states"."status" in ('started','provider_in_flight') and "draft_operation_states"."response" is null and "draft_operation_states"."response_hash" is null and "draft_operation_states"."checkpointed_at" is null) or ("draft_operation_states"."status" = 'checkpointed' and "draft_operation_states"."response" is not null and "draft_operation_states"."response_hash" is not null and "draft_operation_states"."checkpointed_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_operation_states" ADD CONSTRAINT "draft_operation_states_producing_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("producing_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_draft_operation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.producing_step_execution_id IS DISTINCT FROM NEW.producing_step_execution_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.model IS DISTINCT FROM NEW.model
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER draft_operation_states_transition BEFORE UPDATE ON "draft_operation_states" FOR EACH ROW EXECUTE FUNCTION validate_draft_operation_transition();--> statement-breakpoint
CREATE TRIGGER draft_operation_states_no_delete BEFORE DELETE ON "draft_operation_states" FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

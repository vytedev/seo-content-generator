CREATE TABLE "review_operation_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"from_step_execution_id" uuid NOT NULL,
	"to_step_execution_id" uuid NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_operation_adoptions_distinct_executions" CHECK ("review_operation_adoptions"."from_step_execution_id" <> "review_operation_adoptions"."to_step_execution_id")
);
--> statement-breakpoint
ALTER TABLE "review_operation_adoptions" ADD CONSTRAINT "review_operation_adoptions_operation_id_review_operation_states_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."review_operation_states"("operation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_operation_adoptions" ADD CONSTRAINT "review_operation_adoptions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_operation_adoptions" ADD CONSTRAINT "review_operation_adoptions_from_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("from_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_operation_adoptions" ADD CONSTRAINT "review_operation_adoptions_to_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("to_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_operation_adoptions_source_unique" ON "review_operation_adoptions" USING btree ("operation_id","from_step_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_operation_adoptions_target_unique" ON "review_operation_adoptions" USING btree ("operation_id","to_step_execution_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_review_operation_adoption() RETURNS trigger AS $$
DECLARE
  operation review_operation_states%ROWTYPE;
  previous step_executions%ROWTYPE;
  replacement step_executions%ROWTYPE;
BEGIN
  -- The operation row serialises producer changes. Lock both execution rows afterwards in UUID
  -- order so direct/concurrent adoption attempts cannot observe mutable predecessor state or
  -- deadlock by requesting the same pair in opposite order.
  SELECT * INTO operation FROM review_operation_states WHERE operation_id=NEW.operation_id FOR UPDATE;
  PERFORM 1 FROM step_executions
    WHERE run_id=NEW.run_id AND id IN (NEW.from_step_execution_id,NEW.to_step_execution_id)
    ORDER BY id FOR UPDATE;
  SELECT * INTO previous FROM step_executions WHERE id=NEW.from_step_execution_id AND run_id=NEW.run_id;
  SELECT * INTO replacement FROM step_executions WHERE id=NEW.to_step_execution_id AND run_id=NEW.run_id;
  IF operation.operation_id IS NULL OR operation.run_id<>NEW.run_id OR operation.status<>'started'
     OR operation.producing_step_execution_id<>NEW.from_step_execution_id
     OR previous.id IS NULL OR replacement.id IS NULL
     OR previous.step<>operation.step OR replacement.step<>operation.step
     OR previous.status<>'retryable_failed'
     OR num_nonnulls(previous.lease_token,previous.lease_owner,previous.lease_expires_at)<>0
     OR replacement.status<>'running'
     OR num_nonnulls(replacement.lease_token,replacement.lease_owner,replacement.lease_expires_at)<>3
     OR replacement.lease_expires_at<=clock_timestamp()
     OR previous.attempt>=replacement.attempt THEN
    RAISE EXCEPTION 'invalid review operation adoption';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER review_operation_adoptions_validate BEFORE INSERT ON review_operation_adoptions
FOR EACH ROW EXECUTE FUNCTION protect_review_operation_adoption();--> statement-breakpoint
CREATE TRIGGER review_operation_adoptions_no_update BEFORE UPDATE ON review_operation_adoptions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER review_operation_adoptions_no_delete BEFORE DELETE ON review_operation_adoptions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint

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
  IF OLD.status='started' AND NEW.status='provider_in_flight' AND NEW.response IS NULL THEN RETURN NEW; END IF;
  IF OLD.status='provider_in_flight' AND NEW.status='checkpointed' AND NEW.response IS NOT NULL AND NEW.response_hash IS NOT NULL AND NEW.checkpointed_at IS NOT NULL THEN RETURN NEW; END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid review operation transition: % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;
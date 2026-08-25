CREATE TABLE "model_diagnostic_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"safe_result" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_diagnostic_operations_provider" CHECK ("model_diagnostic_operations"."provider" = 'openrouter'),
	CONSTRAINT "model_diagnostic_operations_status" CHECK ("model_diagnostic_operations"."status" in ('pending','in_flight','succeeded','failed')),
	CONSTRAINT "model_diagnostic_operations_result_state" CHECK (("model_diagnostic_operations"."status" in ('pending','in_flight') and "model_diagnostic_operations"."safe_result" is null and "model_diagnostic_operations"."completed_at" is null)
          or ("model_diagnostic_operations"."status" in ('succeeded','failed') and "model_diagnostic_operations"."safe_result" is not null and "model_diagnostic_operations"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_diagnostic_operations_idempotency_unique" ON "model_diagnostic_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "model_diagnostic_operations_active_idx" ON "model_diagnostic_operations" USING btree ("status","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_model_diagnostic_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model diagnostic operations cannot be deleted';
  END IF;
  IF OLD.id <> NEW.id
     OR OLD.idempotency_key <> NEW.idempotency_key
     OR OLD.provider <> NEW.provider
     OR OLD.model <> NEW.model
     OR OLD.created_at <> NEW.created_at
     OR OLD.status NOT IN ('pending','in_flight')
     OR NEW.status NOT IN ('succeeded','failed')
     OR NEW.safe_result IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'model diagnostic operations allow only one active-to-terminal completion';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_diagnostic_operations_guard
BEFORE UPDATE OR DELETE ON model_diagnostic_operations
FOR EACH ROW EXECUTE FUNCTION protect_model_diagnostic_operation();
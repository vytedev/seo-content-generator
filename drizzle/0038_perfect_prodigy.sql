ALTER TABLE "coherence_checkpoints" ADD COLUMN "status" text;--> statement-breakpoint
UPDATE "coherence_checkpoints"
SET "status" = CASE WHEN "response" IS NOT NULL THEN 'checkpointed' ELSE 'provider_in_flight' END
WHERE "status" IS NULL;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ALTER COLUMN "status" SET DEFAULT 'started';--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_status_check" CHECK ("coherence_checkpoints"."status" in ('started','provider_in_flight','checkpointed'));--> statement-breakpoint
ALTER TABLE "coherence_checkpoints" ADD CONSTRAINT "coherence_checkpoints_response_pair" CHECK (("status" in ('started','provider_in_flight') AND "response" IS NULL AND "response_hash" IS NULL) OR ("status"='checkpointed' AND "response" IS NOT NULL AND "response_hash" IS NOT NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_coherence_checkpoint_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF OLD.status = 'started' AND NEW.status = 'provider_in_flight' THEN RETURN NEW; END IF;
  IF OLD.status = 'provider_in_flight' AND NEW.status IN ('started','checkpointed') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid coherence checkpoint transition: % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER coherence_checkpoints_transition BEFORE UPDATE ON "coherence_checkpoints" FOR EACH ROW EXECUTE FUNCTION validate_coherence_checkpoint_transition();

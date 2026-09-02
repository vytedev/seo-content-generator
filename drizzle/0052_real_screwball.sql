ALTER TABLE "run_command_outbox" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "run_command_outbox" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "run_command_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "run_command_outbox_aux_lease_idx" ON "run_command_outbox" USING btree ("kind","status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "run_command_outbox" ADD CONSTRAINT "run_command_outbox_aux_lease_shape" CHECK (("run_command_outbox"."kind"='probe_serp' and "run_command_outbox"."status"='processing' and "run_command_outbox"."lease_owner" is not null and "run_command_outbox"."lease_token" is not null and "run_command_outbox"."lease_expires_at" is not null) or not ("run_command_outbox"."kind"='probe_serp' and "run_command_outbox"."status"='processing'));--> statement-breakpoint
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
     AND NEW.terminal_result IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status='processing' AND NEW.status='processing'
     AND OLD.kind='probe_serp' AND NEW.kind='probe_serp'
     AND OLD.terminal_result IS NULL AND NEW.terminal_result IS NULL
     AND OLD.completed_at IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('pending','processing') AND NEW.status IN ('succeeded','failed')
     AND NEW.terminal_result IS NOT NULL AND NEW.completed_at IS NOT NULL
     AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid run command transition: % to %',OLD.status,NEW.status;
END;
$$ LANGUAGE plpgsql;

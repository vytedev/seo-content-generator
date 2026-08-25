CREATE TABLE "operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_sessions_token_hash_check" CHECK (length("operator_sessions"."token_hash") = 64),
	CONSTRAINT "operator_sessions_expiry_after_creation" CHECK ("operator_sessions"."expires_at" > "operator_sessions"."created_at"),
	CONSTRAINT "operator_sessions_revocation_after_creation" CHECK ("operator_sessions"."revoked_at" is null or "operator_sessions"."revoked_at" >= "operator_sessions"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_sessions_token_hash_unique" ON "operator_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_sessions_expiry_idx" ON "operator_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE FUNCTION reject_operator_session_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operator session identity fields are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'operator session revocation is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER operator_sessions_immutable
BEFORE UPDATE ON operator_sessions
FOR EACH ROW EXECUTE FUNCTION reject_operator_session_identity_update();
CREATE TABLE "google_oauth_token_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event" text NOT NULL,
	"encrypted_tokens" text,
	"iv" text,
	"auth_tag" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_oauth_token_versions_provider_check" CHECK ("google_oauth_token_versions"."provider" = 'google'),
	CONSTRAINT "google_oauth_token_versions_event_check" CHECK ("google_oauth_token_versions"."event" in ('connected','disconnected')),
	CONSTRAINT "google_oauth_token_versions_payload_check" CHECK (("google_oauth_token_versions"."event" = 'connected' and num_nonnulls("google_oauth_token_versions"."encrypted_tokens","google_oauth_token_versions"."iv","google_oauth_token_versions"."auth_tag","google_oauth_token_versions"."expires_at","google_oauth_token_versions"."scope") = 5)
          or ("google_oauth_token_versions"."event" = 'disconnected' and num_nonnulls("google_oauth_token_versions"."encrypted_tokens","google_oauth_token_versions"."iv","google_oauth_token_versions"."auth_tag","google_oauth_token_versions"."expires_at","google_oauth_token_versions"."scope") = 0))
);
--> statement-breakpoint
CREATE INDEX "google_oauth_token_versions_latest_idx" ON "google_oauth_token_versions" USING btree ("provider","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_google_oauth_token_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'google OAuth token versions are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER google_oauth_token_versions_immutable BEFORE UPDATE OR DELETE ON google_oauth_token_versions FOR EACH ROW EXECUTE FUNCTION prevent_google_oauth_token_version_mutation();
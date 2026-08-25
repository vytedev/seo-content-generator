DROP INDEX "google_oauth_token_versions_latest_idx";--> statement-breakpoint
ALTER TABLE "google_oauth_token_versions" ADD COLUMN "version" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "google_oauth_token_versions_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE UNIQUE INDEX "google_oauth_token_versions_version_unique" ON "google_oauth_token_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "google_oauth_token_versions_latest_idx" ON "google_oauth_token_versions" USING btree ("provider","version");--> statement-breakpoint
ALTER TABLE "google_oauth_token_versions" ADD CONSTRAINT "google_oauth_token_versions_version_positive" CHECK ("google_oauth_token_versions"."version" > 0);
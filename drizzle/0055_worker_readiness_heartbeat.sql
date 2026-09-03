ALTER TABLE "application_schema_version" DROP CONSTRAINT "application_schema_version_current";--> statement-breakpoint
UPDATE "application_schema_version" SET "version"=55,"applied_at"=clock_timestamp() WHERE "singleton"=true;--> statement-breakpoint
ALTER TABLE "application_schema_version" ADD CONSTRAINT "application_schema_version_current" CHECK ("version"=55);--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
  "worker_name" text PRIMARY KEY NOT NULL,
  "heartbeat_at" timestamp with time zone NOT NULL
);

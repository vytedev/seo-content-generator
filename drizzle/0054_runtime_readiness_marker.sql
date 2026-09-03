CREATE TABLE "application_schema_version" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "version" integer NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "application_schema_version_singleton" CHECK ("singleton"=true),
  CONSTRAINT "application_schema_version_current" CHECK ("version"=54)
);--> statement-breakpoint
INSERT INTO "application_schema_version" ("singleton","version") VALUES (true,54);

CREATE TABLE "link_discovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"eligibility" text NOT NULL,
	"reason" text,
	"source_health" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"cache_state" text NOT NULL,
	"identity" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"metadata_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_discovery_attempts_eligibility" CHECK ("link_discovery_attempts"."eligibility" in ('eligible','blocked')),
	CONSTRAINT "link_discovery_attempts_metadata_hash" CHECK (length("link_discovery_attempts"."metadata_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "link_discovery_attempts" ADD CONSTRAINT "link_discovery_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_discovery_attempts" ADD CONSTRAINT "link_discovery_attempts_step_execution_id_step_executions_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."step_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_discovery_attempts_execution_unique" ON "link_discovery_attempts" USING btree ("step_execution_id");--> statement-breakpoint
CREATE INDEX "link_discovery_attempts_run_created_idx" ON "link_discovery_attempts" USING btree ("run_id","created_at");
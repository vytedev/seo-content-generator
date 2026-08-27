CREATE TYPE "public"."queue_job_kind" AS ENUM('continue_pipeline');--> statement-breakpoint
CREATE TYPE "public"."queue_job_state" AS ENUM('ready', 'leased', 'retry_wait', 'parked', 'operator_action', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "pipeline_queue_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "queue_job_kind" DEFAULT 'continue_pipeline' NOT NULL,
	"state" "queue_job_state" DEFAULT 'ready' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_queue_jobs_attempt_range" CHECK ("pipeline_queue_jobs"."attempt" between 0 and 3),
	CONSTRAINT "pipeline_queue_jobs_lease_shape" CHECK (("pipeline_queue_jobs"."state" = 'leased' and num_nonnulls("pipeline_queue_jobs"."lease_token","pipeline_queue_jobs"."lease_owner","pipeline_queue_jobs"."lease_expires_at") = 3) or ("pipeline_queue_jobs"."state" <> 'leased' and num_nonnulls("pipeline_queue_jobs"."lease_token","pipeline_queue_jobs"."lease_owner","pipeline_queue_jobs"."lease_expires_at") = 0)),
	CONSTRAINT "pipeline_queue_jobs_options_shape" CHECK (jsonb_typeof("pipeline_queue_jobs"."options")='object' and "pipeline_queue_jobs"."options" - array['refresh_link_discovery','authorise_legacy_draft_recovery']::text[] = '{}'::jsonb and ("pipeline_queue_jobs"."options"->'refresh_link_discovery' is null or jsonb_typeof("pipeline_queue_jobs"."options"->'refresh_link_discovery')='boolean') and ("pipeline_queue_jobs"."options"->'authorise_legacy_draft_recovery' is null or jsonb_typeof("pipeline_queue_jobs"."options"->'authorise_legacy_draft_recovery')='boolean'))
);
--> statement-breakpoint
ALTER TABLE "pipeline_queue_jobs" ADD CONSTRAINT "pipeline_queue_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_queue_jobs_one_active_run_unique" ON "pipeline_queue_jobs" USING btree ("run_id") WHERE "pipeline_queue_jobs"."state" in ('ready','leased','retry_wait','parked','operator_action');--> statement-breakpoint
CREATE INDEX "pipeline_queue_jobs_claim_idx" ON "pipeline_queue_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_pipeline_queue_payload() RETURNS trigger AS $$
BEGIN
  IF NEW.options ?| array['prompt','content','handoff','raw_output','secret','token','api_key'] THEN
    RAISE EXCEPTION 'queue options may contain coordination fields only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pipeline_queue_payload_guard BEFORE INSERT OR UPDATE ON pipeline_queue_jobs
FOR EACH ROW EXECUTE FUNCTION protect_pipeline_queue_payload();
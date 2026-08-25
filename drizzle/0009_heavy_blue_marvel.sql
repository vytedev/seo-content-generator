CREATE TABLE "calibration_reference_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calibration_run_id" uuid NOT NULL,
	"reference_document_id" uuid NOT NULL,
	"reference_version_id" uuid NOT NULL,
	"proposal_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calibration_run_id" uuid NOT NULL,
	"report_hash" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calibration_run_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"result_hash" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_results_slot_range" CHECK ("calibration_results"."slot" between 1 and 2)
);
--> statement-breakpoint
CREATE TABLE "calibration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"checkpoint" text DEFAULT 'created' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_runs_status_check" CHECK ("calibration_runs"."status" in ('queued','retrieving','comparing','reporting','retryable_failed','succeeded')),
	CONSTRAINT "calibration_runs_checkpoint_check" CHECK ("calibration_runs"."checkpoint" in ('created','snapshots','post_1','post_2','combined'))
);
--> statement-breakpoint
CREATE TABLE "calibration_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" integer NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"http_status" integer NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"meta_description" text NOT NULL,
	"published_time" timestamp with time zone NOT NULL,
	"article_markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_snapshots_slot_range" CHECK ("calibration_snapshots"."slot" between 1 and 2),
	CONSTRAINT "calibration_snapshots_http_ok" CHECK ("calibration_snapshots"."http_status" = 200)
);
--> statement-breakpoint
ALTER TABLE "calibration_reference_proposals" ADD CONSTRAINT "calibration_reference_proposals_calibration_run_id_calibration_runs_id_fk" FOREIGN KEY ("calibration_run_id") REFERENCES "public"."calibration_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reference_proposals" ADD CONSTRAINT "calibration_reference_proposals_reference_document_id_reference_documents_id_fk" FOREIGN KEY ("reference_document_id") REFERENCES "public"."reference_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reference_proposals" ADD CONSTRAINT "calibration_reference_proposals_reference_version_id_reference_versions_id_fk" FOREIGN KEY ("reference_version_id") REFERENCES "public"."reference_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reports" ADD CONSTRAINT "calibration_reports_calibration_run_id_calibration_runs_id_fk" FOREIGN KEY ("calibration_run_id") REFERENCES "public"."calibration_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_results" ADD CONSTRAINT "calibration_results_calibration_run_id_calibration_runs_id_fk" FOREIGN KEY ("calibration_run_id") REFERENCES "public"."calibration_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_results" ADD CONSTRAINT "calibration_results_snapshot_id_calibration_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."calibration_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reference_proposals_run_hash_unique" ON "calibration_reference_proposals" USING btree ("calibration_run_id","proposal_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reports_run_unique" ON "calibration_reports" USING btree ("calibration_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reports_hash_unique" ON "calibration_reports" USING btree ("calibration_run_id","report_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_results_run_slot_unique" ON "calibration_results" USING btree ("calibration_run_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_results_run_hash_unique" ON "calibration_results" USING btree ("calibration_run_id","result_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_runs_idempotency_key_unique" ON "calibration_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_snapshots_slot_hash_unique" ON "calibration_snapshots" USING btree ("slot","content_hash");--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_calibration_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;--> statement-breakpoint
CREATE TRIGGER calibration_snapshots_immutable BEFORE UPDATE OR DELETE ON calibration_snapshots FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_results_immutable BEFORE UPDATE OR DELETE ON calibration_results FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_reports_immutable BEFORE UPDATE OR DELETE ON calibration_reports FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();--> statement-breakpoint
CREATE TRIGGER calibration_reference_proposals_immutable BEFORE UPDATE OR DELETE ON calibration_reference_proposals FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();
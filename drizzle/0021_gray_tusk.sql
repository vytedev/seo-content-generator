CREATE TABLE "finding_review_set_members" (
	"review_set_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_review_set_members_review_set_id_ordinal_pk" PRIMARY KEY("review_set_id","ordinal"),
	CONSTRAINT "finding_review_set_members_ordinal" CHECK ("finding_review_set_members"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "finding_review_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"findings_step_execution_id" uuid NOT NULL,
	"membership_hash" text NOT NULL,
	"finding_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_review_sets_count" CHECK ("finding_review_sets"."finding_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "finding_review_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_set_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"finding_count" integer NOT NULL,
	"decision_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_review_submissions_counts" CHECK ("finding_review_submissions"."finding_count" >= 0 and "finding_review_submissions"."decision_count" >= 0 and "finding_review_submissions"."decision_count" = "finding_review_submissions"."finding_count")
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "hard_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_review_set_members" ADD CONSTRAINT "finding_review_set_members_review_set_id_finding_review_sets_id_fk" FOREIGN KEY ("review_set_id") REFERENCES "public"."finding_review_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_set_members" ADD CONSTRAINT "finding_review_set_members_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_sets" ADD CONSTRAINT "finding_review_sets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_sets" ADD CONSTRAINT "finding_review_sets_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_sets" ADD CONSTRAINT "finding_review_sets_findings_step_execution_id_run_id_step_executions_id_run_id_fk" FOREIGN KEY ("findings_step_execution_id","run_id") REFERENCES "public"."step_executions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_submissions" ADD CONSTRAINT "finding_review_submissions_review_set_id_finding_review_sets_id_fk" FOREIGN KEY ("review_set_id") REFERENCES "public"."finding_review_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review_submissions" ADD CONSTRAINT "finding_review_submissions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_set_members_finding_unique" ON "finding_review_set_members" USING btree ("review_set_id","finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_sets_run_unique" ON "finding_review_sets" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_sets_execution_unique" ON "finding_review_sets" USING btree ("findings_step_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_submissions_run_unique" ON "finding_review_submissions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_submissions_idempotency_unique" ON "finding_review_submissions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE TRIGGER finding_review_sets_immutable BEFORE UPDATE OR DELETE ON finding_review_sets FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER finding_review_set_members_immutable BEFORE UPDATE OR DELETE ON finding_review_set_members FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER finding_review_submissions_immutable BEFORE UPDATE OR DELETE ON finding_review_submissions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
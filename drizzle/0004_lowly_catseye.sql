CREATE TABLE "export_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"external_document_id" text,
	"external_url" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "export_operations" ADD CONSTRAINT "export_operations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_operations" ADD CONSTRAINT "export_operations_document_version_id_run_id_document_versions_id_run_id_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "public"."document_versions"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "export_operations_idempotency_key_unique" ON "export_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "export_operations_run_document_destination_unique" ON "export_operations" USING btree ("run_id","document_version_id","destination");
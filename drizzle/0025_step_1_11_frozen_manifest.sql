CREATE TABLE "deterministic_manifests" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "runs"("id") ON DELETE restrict,
  "document_version_id" uuid NOT NULL,
  "step_execution_id" uuid NOT NULL,
  "manifest_hash" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "result_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deterministic_manifests_document_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "document_versions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "deterministic_manifests_execution_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "step_executions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "deterministic_manifests_hashes" CHECK (length("manifest_hash")=64 AND length("result_hash")=64)
);--> statement-breakpoint
CREATE UNIQUE INDEX "deterministic_manifests_execution_unique" ON "deterministic_manifests" ("step_execution_id");--> statement-breakpoint
CREATE TABLE "deterministic_reruns" (
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE restrict,
  "document_version_id" uuid NOT NULL,
  "step_execution_id" uuid NOT NULL,
  "baseline_manifest_hash" text NOT NULL,
  "result_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "retained_blockers" integer NOT NULL,
  "introduced_blockers" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deterministic_reruns_pk" PRIMARY KEY ("run_id","document_version_id"),
  CONSTRAINT "deterministic_reruns_document_fk" FOREIGN KEY ("document_version_id","run_id") REFERENCES "document_versions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "deterministic_reruns_execution_fk" FOREIGN KEY ("step_execution_id","run_id") REFERENCES "step_executions"("id","run_id") ON DELETE restrict,
  CONSTRAINT "deterministic_reruns_counts" CHECK ("retained_blockers">=0 AND "introduced_blockers">=0),
  CONSTRAINT "deterministic_reruns_hashes" CHECK (length("baseline_manifest_hash")=64 AND length("result_hash")=64)
);--> statement-breakpoint
CREATE UNIQUE INDEX "deterministic_reruns_execution_unique" ON "deterministic_reruns" ("step_execution_id");--> statement-breakpoint
CREATE TRIGGER deterministic_manifests_immutable BEFORE UPDATE OR DELETE ON deterministic_manifests FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER deterministic_reruns_immutable BEFORE UPDATE OR DELETE ON deterministic_reruns FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_deterministic_record() RETURNS trigger AS $$
DECLARE execution_step pipeline_step; document_hash text;
BEGIN
  SELECT step INTO execution_step FROM step_executions WHERE id=NEW.step_execution_id AND run_id=NEW.run_id;
  SELECT content_hash INTO document_hash FROM document_versions WHERE id=NEW.document_version_id AND run_id=NEW.run_id;
  IF TG_TABLE_NAME='deterministic_manifests' THEN
    IF execution_step<>'automated_checks' THEN RAISE EXCEPTION 'manifest must be produced by Step 1.4'; END IF;
    IF NEW.manifest_hash<>NEW.manifest->>'manifest_hash' OR NEW.result_hash<>NEW.result->>'result_hash' THEN RAISE EXCEPTION 'manifest/result hash metadata mismatch'; END IF;
    IF NEW.document_version_id::text<>NEW.manifest#>>'{baseline_document,id}' OR document_hash<>NEW.manifest#>>'{baseline_document,content_hash}' THEN RAISE EXCEPTION 'manifest baseline document mismatch'; END IF;
  ELSE
    IF execution_step<>'automated_checks_rerun' THEN RAISE EXCEPTION 'rerun must be produced by Step 1.11'; END IF;
    IF NEW.result_hash<>NEW.result->>'result_hash' OR NEW.document_version_id::text<>NEW.result->>'document_id' OR document_hash<>NEW.result->>'document_hash' THEN RAISE EXCEPTION 'rerun exact document/hash mismatch'; END IF;
    IF NEW.baseline_manifest_hash<>(SELECT manifest_hash FROM deterministic_manifests WHERE run_id=NEW.run_id) THEN RAISE EXCEPTION 'rerun baseline manifest mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER deterministic_manifests_validate BEFORE INSERT ON deterministic_manifests FOR EACH ROW EXECUTE FUNCTION validate_deterministic_record();--> statement-breakpoint
CREATE TRIGGER deterministic_reruns_validate BEFORE INSERT ON deterministic_reruns FOR EACH ROW EXECUTE FUNCTION validate_deterministic_record();
CREATE UNIQUE INDEX "deterministic_reruns_result_identity_unique" ON "deterministic_reruns" USING btree ("run_id","document_version_id","result_hash");--> statement-breakpoint
ALTER TABLE "deterministic_manifests" ADD CONSTRAINT "deterministic_manifests_build_hash" CHECK (("deterministic_manifests"."manifest"->>'build_id') ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "deterministic_manifests" ADD CONSTRAINT "deterministic_manifests_embedded_hash_links" CHECK ("deterministic_manifests"."manifest_hash"="deterministic_manifests"."manifest"->>'manifest_hash' and "deterministic_manifests"."result_hash"="deterministic_manifests"."result"->>'result_hash' and "deterministic_manifests"."manifest_hash"="deterministic_manifests"."result"->>'baseline_manifest_hash' and "deterministic_manifests"."manifest"->>'config_hash'="deterministic_manifests"."result"->>'config_hash' and "deterministic_manifests"."manifest"->>'build_id'="deterministic_manifests"."result"->>'runner_build_id');--> statement-breakpoint
ALTER TABLE "deterministic_reruns" ADD CONSTRAINT "deterministic_reruns_embedded_hash_links" CHECK ("deterministic_reruns"."result_hash"="deterministic_reruns"."result"->>'result_hash' and "deterministic_reruns"."baseline_manifest_hash"="deterministic_reruns"."result"->>'baseline_manifest_hash' and "deterministic_reruns"."retained_blockers"=jsonb_array_length("deterministic_reruns"."result"#>'{comparison,retained_blockers}') and "deterministic_reruns"."introduced_blockers"=jsonb_array_length("deterministic_reruns"."result"#>'{comparison,introduced_blockers}'));CREATE OR REPLACE FUNCTION validate_deterministic_record() RETURNS trigger AS $$
DECLARE execution_step pipeline_step; document_hash text; baseline_config text;
BEGIN
  SELECT step INTO execution_step FROM step_executions WHERE id=NEW.step_execution_id AND run_id=NEW.run_id;
  SELECT content_hash INTO document_hash FROM document_versions WHERE id=NEW.document_version_id AND run_id=NEW.run_id;
  IF TG_TABLE_NAME='deterministic_manifests' THEN
    IF execution_step<>'automated_checks' THEN RAISE EXCEPTION 'manifest must be produced by Step 1.4'; END IF;
    IF NEW.manifest_hash<>NEW.manifest->>'manifest_hash' OR NEW.result_hash<>NEW.result->>'result_hash' THEN RAISE EXCEPTION 'manifest/result hash metadata mismatch'; END IF;
    IF NEW.document_version_id::text<>NEW.manifest#>>'{baseline_document,id}' OR document_hash<>NEW.manifest#>>'{baseline_document,content_hash}' THEN RAISE EXCEPTION 'manifest baseline document mismatch'; END IF;
    IF NEW.step_execution_id::text<>NEW.manifest->>'producing_execution_id' THEN RAISE EXCEPTION 'manifest producing execution mismatch'; END IF;
  ELSE
    IF execution_step<>'automated_checks_rerun' THEN RAISE EXCEPTION 'rerun must be produced by Step 1.11'; END IF;
    IF NEW.result_hash<>NEW.result->>'result_hash' OR NEW.document_version_id::text<>NEW.result->>'document_id' OR document_hash<>NEW.result->>'document_hash' THEN RAISE EXCEPTION 'rerun exact document/hash mismatch'; END IF;
    SELECT manifest->>'config_hash' INTO baseline_config FROM deterministic_manifests WHERE run_id=NEW.run_id AND manifest_hash=NEW.baseline_manifest_hash;
    IF baseline_config IS NULL OR baseline_config<>NEW.result->>'config_hash' THEN RAISE EXCEPTION 'rerun baseline manifest/config mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

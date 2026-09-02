-- Correct historical queue classification after 0042 introduced review operation evidence.
-- Steps 1.5-1.8 retryable failures predating that evidence are never safe to auto-spend.
UPDATE pipeline_queue_jobs q
SET state='operator_action',
    lease_token=null,
    lease_owner=null,
    lease_expires_at=null,
    last_error_code='legacy_review_explicit_recovery',
    updated_at=clock_timestamp()
FROM runs r
WHERE q.run_id=r.id
  AND q.state IN ('ready','retry_wait')
  AND r.status='retryable_failed'
  AND r.current_step IN ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
  AND NOT EXISTS (SELECT 1 FROM review_operation_states o WHERE o.run_id=r.id);--> statement-breakpoint

-- Keep future/partially-applied backfills conservative too: creating a queue row without
-- historical review evidence classifies the same legacy state for explicit recovery.
CREATE OR REPLACE FUNCTION classify_pipeline_queue_insert() RETURNS trigger AS $$
DECLARE
  historical_review boolean;
BEGIN
  SELECT r.status='retryable_failed'
     AND r.current_step IN ('review_writing_style','review_information_gain','review_fact_checking','review_link_conversion')
     AND NOT EXISTS (SELECT 1 FROM review_operation_states o WHERE o.run_id=r.id)
  INTO historical_review
  FROM runs r WHERE r.id=NEW.run_id;
  IF historical_review AND NEW.options->'authorise_legacy_review_recovery' IS DISTINCT FROM 'true'::jsonb THEN
    NEW.state := 'operator_action';
    NEW.last_error_code := 'legacy_review_explicit_recovery';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pipeline_queue_insert_classification
BEFORE INSERT ON pipeline_queue_jobs FOR EACH ROW EXECUTE FUNCTION classify_pipeline_queue_insert();--> statement-breakpoint

ALTER TABLE pipeline_queue_jobs DROP CONSTRAINT pipeline_queue_jobs_options_shape;--> statement-breakpoint
ALTER TABLE pipeline_queue_jobs ADD CONSTRAINT pipeline_queue_jobs_options_shape CHECK (
  jsonb_typeof(options)='object'
  AND options - array['refresh_link_discovery','authorise_legacy_draft_recovery','authorise_legacy_review_recovery']::text[] = '{}'::jsonb
  AND (options->'refresh_link_discovery' is null or jsonb_typeof(options->'refresh_link_discovery')='boolean')
  AND (options->'authorise_legacy_draft_recovery' is null or jsonb_typeof(options->'authorise_legacy_draft_recovery')='boolean')
  AND (options->'authorise_legacy_review_recovery' is null or options->'authorise_legacy_review_recovery'='true'::jsonb)
);
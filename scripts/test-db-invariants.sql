\set ON_ERROR_STOP on

DO $$
DECLARE
  run_id uuid;
  execution_id uuid;
  second_execution_id uuid;
  lease_token uuid := gen_random_uuid();
  artifact_id uuid;
  document_id uuid;
  export_artifact_id uuid;
  reference_document_id uuid;
  reference_version_id uuid;
  approval_id uuid;
  source_id uuid;
  claim_id uuid;
  claimed_count integer;
  operation_ok boolean;
  expected_export_hash text;
  session_id uuid;
  cache_id uuid;
  revision_noop_id text := 'db-test-revision-noop';
  revision_failure_id uuid;
  diagnostic_id uuid;
  revision_operation_id text := 'db-test-revision-operation';
  finding_id uuid;
BEGIN
  INSERT INTO operator_sessions(token_hash, expires_at)
  VALUES(repeat('a', 64), clock_timestamp() + interval '1 hour') RETURNING id INTO session_id;
  BEGIN
    UPDATE operator_sessions SET token_hash = repeat('b', 64) WHERE id = session_id;
    RAISE EXCEPTION 'operator session token hash update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'operator session token hash update unexpectedly succeeded' THEN RAISE; END IF;
  END;
  UPDATE operator_sessions SET revoked_at = clock_timestamp() WHERE id = session_id;

  INSERT INTO model_diagnostic_operations(idempotency_key,provider,model,status)
  VALUES(gen_random_uuid(),'openrouter','test/pinned-model','in_flight') RETURNING id INTO diagnostic_id;
  UPDATE model_diagnostic_operations
     SET status='succeeded',
         safe_result='{"provider":"openrouter","model":"test/pinned-model","status":"success","error_category":null,"message":"OpenRouter responded successfully.","input_tokens":1,"output_tokens":1,"cost_micros":0,"latency_ms":1}'::jsonb,
         completed_at=clock_timestamp()
   WHERE id=diagnostic_id;
  BEGIN
    UPDATE model_diagnostic_operations SET status='failed' WHERE id=diagnostic_id;
    RAISE EXCEPTION 'completed model diagnostic mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'completed model diagnostic mutation unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM model_diagnostic_operations WHERE id=diagnostic_id;
    RAISE EXCEPTION 'model diagnostic deletion unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'model diagnostic deletion unexpectedly succeeded' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO link_discovery_cache(cache_key,request_hash,response_hash,provider,retrieved_at,expires_at,payload)
    VALUES('invalid-cache','request','response','test',statement_timestamp(),statement_timestamp() + interval '24 hours 1 second','{}');
    RAISE EXCEPTION 'cache TTL over 24 hours unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO link_discovery_cache(cache_key,request_hash,response_hash,provider,retrieved_at,expires_at,payload)
  VALUES('valid-cache','request','response','test',statement_timestamp(),statement_timestamp() + interval '24 hours','{}')
  RETURNING id INTO cache_id;

  INSERT INTO runs (idempotency_key, input_hash, plane_ticket, handoff)
  VALUES (
    'db-test-run', 'input-hash', 'MOB-TEST',
    '{"plane_ticket":"MOB-TEST","primary_keyword":"chair","related_keywords":["seat"],"page_type":"blog","word_count_target":1200,"locales_for_translation":[]}'::jsonb
  ) RETURNING id INTO run_id;

  BEGIN
    UPDATE runs SET deterministic_repair_cycles=3 WHERE id=run_id;
    RAISE EXCEPTION 'invalid deterministic repair cycle count unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE runs SET block_reason='invalid_reason' WHERE id=run_id;
    RAISE EXCEPTION 'invalid run block reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE runs SET block_reason='deterministic_blockers' WHERE id=run_id;
    RAISE EXCEPTION 'non-blocked run accepted a block reason';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Nullable remains intentional for pre-migration blocked rows; API maps it to unknown.
  UPDATE runs SET status='blocked',current_step='final_coherence_export' WHERE id=run_id;
  UPDATE runs SET status='running',current_step='internal_link_discovery',block_reason=null WHERE id=run_id;

  INSERT INTO step_executions (run_id, step, attempt)
  VALUES (run_id, 'ingest_handoff', 1) RETURNING id INTO execution_id;
  INSERT INTO step_executions (run_id, step, attempt)
  VALUES (run_id, 'draft', 1) RETURNING id INTO second_execution_id;

  SELECT count(*) INTO claimed_count
  FROM claim_step_execution(execution_id, 'worker-a', interval '30 seconds', lease_token);
  IF claimed_count <> 1 THEN RAISE EXCEPTION 'atomic claim did not acquire execution'; END IF;

  SELECT start_step_execution(execution_id, lease_token) INTO operation_ok;
  IF NOT operation_ok THEN RAISE EXCEPTION 'fenced start failed'; END IF;
  SELECT heartbeat_step_execution(execution_id, gen_random_uuid(), interval '30 seconds') INTO operation_ok;
  IF operation_ok THEN RAISE EXCEPTION 'stale heartbeat token was accepted'; END IF;
  SELECT complete_step_execution(execution_id, lease_token) INTO operation_ok;
  IF NOT operation_ok THEN RAISE EXCEPTION 'fenced completion failed'; END IF;

  INSERT INTO artifacts (run_id, step_execution_id, kind, media_type, body_text, content_hash, size_bytes)
  VALUES (run_id, execution_id, 'handoff', 'application/json', '{}', 'artifact-hash', 2)
  RETURNING id INTO artifact_id;

  BEGIN
    UPDATE artifacts SET body_text = 'changed' WHERE id = artifact_id;
    RAISE EXCEPTION 'artifact update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'artifact update unexpectedly succeeded' THEN RAISE; END IF;
  END;

  INSERT INTO document_versions (run_id, artifact_id, revision, content_hash)
  VALUES (run_id, artifact_id, 1, 'document-hash') RETURNING id INTO document_id;

  INSERT INTO revision_noop_completions(operation_id,run_id,step_execution_id,document_version_id,revision_source)
  VALUES(revision_noop_id,run_id,second_execution_id,document_id,'operator_findings');
  BEGIN
    UPDATE revision_noop_completions SET revision_source='coherence_repair' WHERE operation_id=revision_noop_id;
    RAISE EXCEPTION 'revision no-op audit update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'revision no-op audit update unexpectedly succeeded' THEN RAISE; END IF;
  END;

  INSERT INTO revision_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,request_hash)
  VALUES(revision_operation_id,run_id,document_id,second_execution_id,'request-hash');
  INSERT INTO findings(run_id,document_version_id,step_execution_id,stable_key,category,rule_reference,severity,location,issue,suggested_fix)
  VALUES(run_id,document_id,second_execution_id,'db-audit-finding','deterministic','db.rule','blocker','{}','Issue','Fix')
  RETURNING id INTO finding_id;
  INSERT INTO revision_finding_audits(run_id,operation_id,step_execution_id,source_document_version_id,result_document_version_id,finding_id,ordinal,status,reason,location,location_json,hunks,manifest_hash,changed,before_hash,after_hash)
  VALUES(run_id,revision_operation_id,second_execution_id,document_id,document_id,finding_id,0,'unable','No change','{}','{}','[]','manifest',false,'before','after');
  BEGIN
    INSERT INTO revision_finding_audits(run_id,operation_id,step_execution_id,source_document_version_id,result_document_version_id,finding_id,ordinal,status,reason,location,location_json,hunks,manifest_hash,changed,before_hash,after_hash)
    VALUES(run_id,'missing-operation',second_execution_id,document_id,document_id,finding_id,1,'unable','Bad operation','{}','{}','[]','manifest',false,'before','after');
    RAISE EXCEPTION 'unlinked revision audit unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  INSERT INTO revision_provider_failures(run_id,step_execution_id,operation_id,provider,model,prompt_version,planning_version,failure_category)
  VALUES(run_id,second_execution_id,'db-test-revision-failure','test','model','2.0.0','1.0.0','malformed_response')
  RETURNING id INTO revision_failure_id;
  BEGIN
    UPDATE revision_provider_failures SET failure_category='configuration' WHERE id=revision_failure_id;
    RAISE EXCEPTION 'revision provider failure update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'revision provider failure update unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO revision_provider_failures(run_id,step_execution_id,operation_id,provider,model,prompt_version,planning_version,failure_category)
    VALUES(run_id,execution_id,'db-test-invalid-category','test','model','2.0.0','1.0.0','unsafe');
    RAISE EXCEPTION 'invalid revision failure category unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO reference_documents (kind, title)
    VALUES ('blog_writing_guide', 'Arbitrary guide') RETURNING id INTO reference_document_id;
    INSERT INTO reference_versions (reference_document_id, version, body_markdown, content_hash, size_bytes)
    VALUES (reference_document_id, 1, '# Arbitrary', repeat('f',64), 11)
    RETURNING id INTO reference_version_id;
    INSERT INTO reference_activations(reference_document_id,reference_version_id,provisional_local)
    VALUES(reference_document_id,reference_version_id,true);
    RAISE EXCEPTION 'arbitrary pending version 1 provisional activation unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO reference_documents (kind, title)
  VALUES ('blog_writing_guide', 'Blog writing guide') RETURNING id INTO reference_document_id;
  INSERT INTO reference_versions (reference_document_id, version, body_markdown, content_hash, size_bytes)
  VALUES (reference_document_id, 1, '# Guide', '6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c', 7)
  RETURNING id INTO reference_version_id;
  BEGIN
    INSERT INTO reference_activations(reference_document_id,reference_version_id)
    VALUES(reference_document_id,reference_version_id);
    RAISE EXCEPTION 'unapproved activation unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO reference_approval_attestations(reference_version_id,recorder_identity,approver_identity,evidence_reference)
  VALUES(reference_version_id,'Local DB operator','Claimed external reviewer','External evidence reference') RETURNING id INTO approval_id;
  BEGIN
    INSERT INTO reference_activations(reference_document_id,reference_version_id)
    VALUES(reference_document_id,reference_version_id);
    RAISE EXCEPTION 'pending attestation activated a non-provisional reference';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO reference_activations(reference_document_id,reference_version_id,provisional_local)
  VALUES(reference_document_id,reference_version_id,true);
  BEGIN
    UPDATE reference_approval_attestations SET evidence_reference='changed' WHERE id=approval_id;
    RAISE EXCEPTION 'approval attestation update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'approval attestation update unexpectedly succeeded' THEN RAISE; END IF;
  END;
  INSERT INTO substep_reference_map (reference_document_id, step)
  VALUES (reference_document_id, 'draft');
  INSERT INTO step_reference_snapshots (step_execution_id, reference_document_id, reference_version_id, content_hash)
  VALUES (second_execution_id, reference_document_id, reference_version_id, '6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c');

  INSERT INTO sources (run_id, source_type, uri, retrieved_at, content_hash, snapshot)
  VALUES (run_id, 'medusa', 'https://example.test/product', clock_timestamp(), 'source-hash', '{}'::jsonb)
  RETURNING id INTO source_id;
  INSERT INTO claims (run_id, document_version_id, claim_text, claim_hash, type, status, location, hard_flag)
  VALUES (run_id, document_id, 'Designed by Example', 'claim-hash', 'provenance', 'unverified', '{}'::jsonb, true)
  RETURNING id INTO claim_id;
  INSERT INTO claim_sources (run_id, claim_id, source_id, status, evidence)
  VALUES (run_id, claim_id, source_id, 'unverified', 'Product record contains no verified attribution');

  INSERT INTO artifacts (run_id, step_execution_id, kind, media_type, body_text, content_hash, size_bytes)
  VALUES (run_id, execution_id, 'google_docs_export', 'text/markdown', '# Export', 'export-artifact-hash', 8)
  RETURNING id INTO export_artifact_id;
  expected_export_hash := encode(digest('document-hash:export-artifact-hash:google_docs', 'sha256'), 'hex');
  INSERT INTO exports (
    run_id, step_execution_id, document_version_id, export_artifact_id,
    idempotency_key, input_hash, destination
  ) VALUES (
    run_id, execution_id, document_id, export_artifact_id,
    'export-test', expected_export_hash, 'google_docs'
  );

  BEGIN
    UPDATE exports SET destination = 'changed' WHERE idempotency_key = 'export-test';
    RAISE EXCEPTION 'export update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'export update unexpectedly succeeded' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE
  baseline record;
  baseline_document_id uuid;
  baseline_version_id uuid;
  activated_count integer := 0;
BEGIN
  FOR baseline IN
    SELECT * FROM (VALUES
      ('writer_submission_sample'::reference_document_kind,'c4e73031e2721c5450a258503ff3ee28a6110b35de5dffe97fe713d6f57b066c'),
      ('internal_linking_guidelines'::reference_document_kind,'979a802d9ad2c53e9cd91baaea56ccbcf092dfaef8ed2e98994bc7f21beb20ab'),
      ('fact_checking_rules'::reference_document_kind,'c257cd35e20526b8a7f08d5b2e0f38f7f46b1586134dd3376bfecd86f2d1dd71'),
      ('keyword_placement_guidelines'::reference_document_kind,'ffd731d8047ae25ceedab871f86cc8208a05de30abd1cee32ce431a033615ab4'),
      ('pipeline_workflow'::reference_document_kind,'97fe5c229a20c6334f4b6a4663bd3a59c8a48c49ecef1cb2763c6e537792fb00')
    ) AS allowed(kind,content_hash)
  LOOP
    INSERT INTO reference_documents(kind,title)
    VALUES(baseline.kind,baseline.kind::text) RETURNING id INTO baseline_document_id;
    INSERT INTO reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes)
    VALUES(baseline_document_id,1,'# Known task-derived baseline',baseline.content_hash,29)
    RETURNING id INTO baseline_version_id;
    INSERT INTO reference_activations(reference_document_id,reference_version_id,provisional_local)
    VALUES(baseline_document_id,baseline_version_id,true);
    activated_count := activated_count + 1;
  END LOOP;
  IF activated_count <> 5 THEN RAISE EXCEPTION 'not every remaining known baseline activated'; END IF;
END $$;

DO $$
DECLARE
  cal_run_id uuid;
  cal_snapshot_id uuid;
BEGIN
  INSERT INTO calibration_runs(idempotency_key,input_hash)
  VALUES ('db-calibration-test', repeat('a',64)) RETURNING id INTO cal_run_id;
  INSERT INTO calibration_snapshots(slot,url,canonical_url,http_status,retrieved_at,title,meta_description,published_time,article_markdown,content_hash,safe_metadata)
  VALUES (1,'https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences','https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences',200,clock_timestamp(),'Calibration','Description',clock_timestamp(),'# Article',repeat('b',64),'{}')
  RETURNING id INTO cal_snapshot_id;
  INSERT INTO calibration_reports(calibration_run_id,report_hash,report)
  VALUES(cal_run_id,repeat('d',64),'{}');

  BEGIN
    UPDATE calibration_snapshots SET article_markdown='changed' WHERE id=cal_snapshot_id;
    RAISE EXCEPTION 'calibration snapshot update unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'calibration snapshot update unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE calibration_reports SET report='{"changed":true}' WHERE calibration_run_id=cal_run_id;
    RAISE EXCEPTION 'calibration report update unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'calibration report update unexpectedly succeeded' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE
  nullable_columns integer;
  incomplete_rows integer;
BEGIN
  SELECT count(*) INTO nullable_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'revision_finding_audits'
    AND column_name IN ('location_json', 'manifest_hash')
    AND is_nullable <> 'NO';
  IF nullable_columns <> 0 THEN
    RAISE EXCEPTION 'revision audit required metadata columns remain nullable';
  END IF;

  SELECT count(*) INTO incomplete_rows
  FROM revision_finding_audits
  WHERE location_json IS NULL OR manifest_hash IS NULL;
  IF incomplete_rows <> 0 THEN
    RAISE EXCEPTION 'revision audit required metadata contains nulls';
  END IF;
END $$;

DO $$
DECLARE mutable_count integer;
BEGIN
  SELECT count(*) INTO mutable_count FROM pg_trigger
  WHERE tgname IN ('deterministic_manifests_immutable','deterministic_reruns_immutable') AND NOT tgisinternal;
  IF mutable_count <> 2 THEN RAISE EXCEPTION 'Step 1.4/1.11 immutable triggers missing'; END IF;
END $$;

DO $$
DECLARE immutable_count integer;
BEGIN
  SELECT count(*) INTO immutable_count FROM pg_trigger
  WHERE tgname IN ('content_templates_immutable','export_manifests_immutable','coherence_checkpoints_no_delete') AND NOT tgisinternal;
  IF immutable_count <> 3 THEN RAISE EXCEPTION 'Step 1.12 immutable triggers missing'; END IF;
END $$;

DO $$
DECLARE immutable_count integer;
BEGIN
  SELECT count(*) INTO immutable_count FROM pg_trigger
  WHERE tgname='exceptional_correction_authorisations_immutable' AND NOT tgisinternal;
  IF immutable_count <> 1 THEN RAISE EXCEPTION 'exceptional correction immutable trigger missing'; END IF;
  BEGIN
    INSERT INTO exceptional_correction_authorisations(run_id,document_version_id,deterministic_rerun_step_execution_id,idempotency_key,blocker_set_hash,blocker_bindings,explicit_confirmation)
    SELECT r.id,d.id,e.id,'db-invalid-unconfirmed',repeat('a',64),'[]'::jsonb,false
    FROM runs r JOIN document_versions d ON d.run_id=r.id JOIN step_executions e ON e.run_id=r.id LIMIT 1;
    RAISE EXCEPTION 'unconfirmed exceptional correction unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SELECT 'database invariants passed' AS result;

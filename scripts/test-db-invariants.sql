\set ON_ERROR_STOP on

DO $$
DECLARE
  run_id uuid;
  execution_id uuid;
  second_execution_id uuid;
  third_execution_id uuid;
  review_execution_id uuid;
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
  queue_id uuid;
  queue_token uuid;
  review_operation_id text := 'db-test-review-operation';
  test_command_id text := 'db-test-command';
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

  INSERT INTO run_command_outbox(command_id,run_id,kind,idempotency_key,payload_hash,payload)
  VALUES(test_command_id,run_id,'resume_run','db-test-command-key',repeat('a',64),
    jsonb_build_object('command_id',test_command_id,'idempotency_key','db-test-command-key','payload_hash',repeat('a',64),'requested_at','2026-09-02T12:00:00Z','kind','resume_run','run_id',run_id,'options','{}'::jsonb));
  BEGIN
    UPDATE run_command_outbox SET status='succeeded' WHERE run_command_outbox.command_id=test_command_id;
    RAISE EXCEPTION 'terminal command without result unexpectedly succeeded';
  EXCEPTION WHEN check_violation OR raise_exception THEN
    IF SQLERRM = 'terminal command without result unexpectedly succeeded' THEN RAISE; END IF;
  END;
  UPDATE run_command_outbox SET status='processing' WHERE run_command_outbox.command_id=test_command_id;
  UPDATE run_command_outbox SET status='succeeded',terminal_result='{"accepted":true}'::jsonb,
    completed_at=clock_timestamp() WHERE run_command_outbox.command_id=test_command_id;
  BEGIN
    UPDATE run_command_outbox SET terminal_result='{"changed":true}'::jsonb WHERE run_command_outbox.command_id=test_command_id;
    RAISE EXCEPTION 'terminal command mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'terminal command mutation unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO run_command_outbox(command_id,run_id,kind,idempotency_key,payload_hash,payload)
    VALUES('db-test-missing-payload',run_id,'resume_run','db-test-missing-payload',repeat('a',64),'{}'::jsonb);
    RAISE EXCEPTION 'command with incomplete payload unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO run_activity_events(activity_id,run_id,sequence,type,command_id,summary,payload,occurred_at)
  VALUES('db-test-activity',run_id,1,'command_accepted',test_command_id,'Command accepted.',
    jsonb_build_object('activity_id','db-test-activity','run_id',run_id,'sequence',1,'type','command_accepted','occurred_at',statement_timestamp(),'command_id',test_command_id,'summary','Command accepted.'),statement_timestamp());
  BEGIN
    INSERT INTO run_activity_events(activity_id,run_id,sequence,type,command_id,summary,payload,occurred_at)
    VALUES('db-test-activity-missing-payload',run_id,2,'command_accepted',test_command_id,'Command accepted.','{}'::jsonb,statement_timestamp());
    RAISE EXCEPTION 'activity with incomplete payload unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO runs(id,idempotency_key,input_hash,plane_ticket,handoff,status,current_step)
    VALUES(gen_random_uuid(),'db-invariant-second-run',repeat('e',64),'MOB-998','{}'::jsonb,'running','internal_link_discovery')
    RETURNING id INTO document_id;
    INSERT INTO run_activity_events(activity_id,run_id,sequence,type,command_id,summary,payload,occurred_at)
    VALUES('db-test-cross-run-activity',document_id,1,'command_accepted',test_command_id,'Command accepted.',
      jsonb_build_object('activity_id','db-test-cross-run-activity','run_id',document_id,'sequence',1,'type','command_accepted','occurred_at',statement_timestamp(),'command_id',test_command_id,'summary','Command accepted.'),statement_timestamp());
    RAISE EXCEPTION 'cross-run command activity unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'cross-run command activity unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM run_activity_events WHERE activity_id='db-test-activity';
    RAISE EXCEPTION 'activity deletion unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'activity deletion unexpectedly succeeded' THEN RAISE; END IF;
  END;
  INSERT INTO serp_evidence(evidence_id,run_id,handoff_hash,provider,query,retrieved_at,status,composition)
  VALUES('db-test-serp',run_id,repeat('b',64),'test-serp','chair',clock_timestamp(),'mismatch','{"informational":2,"commercial":8}'::jsonb);
  BEGIN
    INSERT INTO serp_evidence(evidence_id,run_id,handoff_hash,provider,query,retrieved_at,status,composition,failure_reason)
    VALUES('db-test-serp-failed-null',run_id,repeat('c',64),'test-serp','chair',clock_timestamp(),'failed',null,null);
    RAISE EXCEPTION 'failed SERP evidence without reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO serp_evidence(evidence_id,run_id,handoff_hash,provider,query,retrieved_at,status,composition)
    VALUES('db-test-serp-missing-key',run_id,repeat('d',64),'test-serp','chair',clock_timestamp(),'matched','{"informational":2}'::jsonb);
    RAISE EXCEPTION 'SERP evidence missing composition key unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE serp_evidence SET status='matched' WHERE evidence_id='db-test-serp';
    RAISE EXCEPTION 'SERP evidence mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'SERP evidence mutation unexpectedly succeeded' THEN RAISE; END IF;
  END;

  INSERT INTO pipeline_queue_jobs(run_id) VALUES(run_id) RETURNING id INTO queue_id;
  BEGIN
    INSERT INTO pipeline_queue_jobs(run_id) VALUES(run_id);
    RAISE EXCEPTION 'duplicate active queue job unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  queue_token := gen_random_uuid();
  UPDATE pipeline_queue_jobs SET state='leased',attempt=1,lease_token=queue_token,lease_owner='db-worker',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=queue_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'queue claim setup failed'; END IF;
  UPDATE pipeline_queue_jobs q SET state='completed',lease_token=null,lease_owner=null,lease_expires_at=null WHERE q.id=queue_id AND q.lease_token=gen_random_uuid();
  IF FOUND THEN RAISE EXCEPTION 'stale queue fence unexpectedly completed job'; END IF;
  UPDATE pipeline_queue_jobs q SET state='completed',lease_token=null,lease_owner=null,lease_expires_at=null WHERE q.id=queue_id AND q.lease_token=queue_token;
  BEGIN
    UPDATE pipeline_queue_jobs SET run_id=gen_random_uuid() WHERE id=queue_id;
    RAISE EXCEPTION 'queue immutable identity unexpectedly changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'queue immutable identity unexpectedly changed' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE pipeline_queue_jobs SET state='ready' WHERE id=queue_id;
    RAISE EXCEPTION 'completed queue job unexpectedly reactivated';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'completed queue job unexpectedly reactivated' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO pipeline_queue_jobs(run_id,options) VALUES(run_id,'{"prompt":"forbidden"}'::jsonb);
    RAISE EXCEPTION 'queue payload guard unexpectedly accepted prompt';
  EXCEPTION WHEN check_violation OR raise_exception THEN
    IF SQLERRM = 'queue payload guard unexpectedly accepted prompt' THEN RAISE; END IF;
  END;

  -- 0046: each authorised branch must reject smuggled attempt/fence/options/error changes.
  INSERT INTO pipeline_queue_jobs(run_id) VALUES(run_id) RETURNING id INTO queue_id;
  BEGIN
    UPDATE pipeline_queue_jobs SET pending_refresh=true,attempt=2 WHERE id=queue_id;
    RAISE EXCEPTION 'pending refresh smuggled an attempt change';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'pending refresh smuggled an attempt change' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE pipeline_queue_jobs SET pending_options='{"authorise_legacy_draft_recovery":true}'::jsonb,
      last_error_code='smuggled' WHERE id=queue_id;
    RAISE EXCEPTION 'pending recovery smuggled an error change';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'pending recovery smuggled an error change' THEN RAISE; END IF;
  END;
  queue_token := gen_random_uuid();
  UPDATE pipeline_queue_jobs SET state='leased',attempt=1,lease_token=queue_token,
    lease_owner='db-worker',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=queue_id;
  BEGIN
    UPDATE pipeline_queue_jobs SET lease_expires_at=clock_timestamp()+interval '2 minutes',
      options='{"refresh_link_discovery":true}'::jsonb WHERE id=queue_id;
    RAISE EXCEPTION 'queue heartbeat smuggled options authority';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'queue heartbeat smuggled options authority' THEN RAISE; END IF;
  END;
  UPDATE pipeline_queue_jobs SET state='completed',lease_token=null,lease_owner=null,
    lease_expires_at=null WHERE id=queue_id;

  -- 0048: downstream authority closes monotonically under the exact active fence.
  INSERT INTO pipeline_queue_jobs(run_id) VALUES(run_id) RETURNING id INTO queue_id;
  queue_token := gen_random_uuid();
  UPDATE pipeline_queue_jobs SET state='leased',attempt=1,lease_token=queue_token,
    lease_owner='phase-worker',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=queue_id;
  UPDATE pipeline_queue_jobs SET phase='downstream_started',
    lease_expires_at=lease_expires_at+interval '1 microsecond' WHERE id=queue_id;
  BEGIN
    UPDATE pipeline_queue_jobs SET pending_refresh=true WHERE id=queue_id;
    RAISE EXCEPTION 'refresh accepted after downstream boundary';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'refresh accepted after downstream boundary' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE pipeline_queue_jobs SET phase='pre_downstream' WHERE id=queue_id;
    RAISE EXCEPTION 'downstream phase reopened without continuation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'downstream phase reopened without continuation' THEN RAISE; END IF;
  END;
  UPDATE pipeline_queue_jobs SET state='completed',lease_token=null,lease_owner=null,
    lease_expires_at=null WHERE id=queue_id;

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

  INSERT INTO step_executions(run_id,step,attempt,status)
  VALUES(run_id,'review_writing_style',1,'retryable_failed') RETURNING id INTO review_execution_id;
  INSERT INTO review_operation_states(operation_id,run_id,document_version_id,producing_step_execution_id,step,request_hash,provider,model)
  VALUES(review_operation_id,run_id,document_id,review_execution_id,'review_writing_style','review-request-hash','test','model');
  INSERT INTO step_executions(run_id,step,attempt,status,lease_token,lease_owner,lease_expires_at,started_at)
  VALUES(run_id,'review_writing_style',2,'running',gen_random_uuid(),'db-review-worker',clock_timestamp()+interval '1 minute',clock_timestamp())
  RETURNING id INTO third_execution_id;
  INSERT INTO review_operation_adoptions(operation_id,run_id,from_step_execution_id,to_step_execution_id)
  VALUES(review_operation_id,run_id,review_execution_id,third_execution_id);
  UPDATE review_operation_states SET producing_step_execution_id=third_execution_id WHERE operation_id=review_operation_id;
  BEGIN
    DELETE FROM review_operation_adoptions WHERE operation_id=review_operation_id;
    RAISE EXCEPTION 'review adoption deletion unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'review adoption deletion unexpectedly succeeded' THEN RAISE; END IF;
  END;
  UPDATE review_operation_states SET status='provider_in_flight' WHERE operation_id=review_operation_id;
  UPDATE review_operation_states SET status='checkpointed',response='{"findings":[],"usage":{"input_tokens":1,"output_tokens":1,"cost_micros":0}}'::jsonb,response_hash='review-response-hash',checkpointed_at=clock_timestamp() WHERE operation_id=review_operation_id;
  BEGIN
    UPDATE review_operation_states SET status='provider_in_flight' WHERE operation_id=review_operation_id;
    RAISE EXCEPTION 'checkpointed review operation mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'checkpointed review operation mutation unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM review_operation_states WHERE operation_id=review_operation_id;
    RAISE EXCEPTION 'review operation deletion unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'review operation deletion unexpectedly succeeded' THEN RAISE; END IF;
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
  INSERT INTO claims (run_id, document_version_id, claim_text, claim_hash, type, status, location, hard_flag, hard_flag_reason)
  VALUES (run_id, document_id, 'Designed by Example', 'claim-hash', 'provenance', 'unverified', '{}'::jsonb, true, 'designer_attribution')
  RETURNING id INTO claim_id;
  BEGIN
    INSERT INTO claims (run_id,document_version_id,claim_text,claim_hash,type,status,location,hard_flag,hard_flag_reason)
    VALUES(run_id,document_id,'Invalid reason','invalid-reason','general','unverified','{}',false,'policy');
    RAISE EXCEPTION 'non-flagged claim reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
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
    INSERT INTO exports(run_id,step_execution_id,document_version_id,export_artifact_id,
      idempotency_key,input_hash,destination,status)
    VALUES(run_id,execution_id,document_id,export_artifact_id,
      'export-invalid-terminal',expected_export_hash,'google_docs','succeeded');
    RAISE EXCEPTION 'export terminal status without result unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

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
  WHERE tgname IN ('content_templates_immutable','export_manifests_immutable','coherence_checkpoints_no_delete','coherence_checkpoints_transition') AND NOT tgisinternal;
  IF immutable_count <> 4 THEN RAISE EXCEPTION 'Step 1.12 immutable/transition triggers missing'; END IF;
END $$;

DO $$
DECLARE trigger_count integer; constraint_count integer;
BEGIN
  SELECT count(*) INTO trigger_count FROM pg_trigger
  WHERE tgname IN ('draft_operation_states_transition','draft_operation_states_no_delete') AND NOT tgisinternal;
  SELECT count(*) INTO constraint_count FROM pg_constraint
  WHERE conname IN ('draft_operation_states_status_check','draft_operation_states_response_pair');
  IF trigger_count <> 2 OR constraint_count <> 2 THEN
    RAISE EXCEPTION 'Step 1.3 durable draft operation invariants missing';
  END IF;
END $$;

DO $$
DECLARE constraint_count integer;
BEGIN
  SELECT count(*) INTO constraint_count
  FROM pg_constraint
  WHERE conname IN ('coherence_checkpoints_status_check','coherence_checkpoints_response_pair');
  IF constraint_count <> 2 THEN RAISE EXCEPTION 'coherence checkpoint status constraints missing'; END IF;
END $$;

DO $$
DECLARE readiness_trigger_count integer; readiness_constraint_count integer;
BEGIN
  SELECT count(*) INTO readiness_trigger_count FROM pg_trigger
  WHERE tgname IN ('run_command_outbox_guard','run_activity_events_immutable','serp_evidence_immutable',
    'run_activity_events_allocate_sequence','step_executions_activity')
    AND NOT tgisinternal;
  SELECT count(*) INTO readiness_constraint_count FROM pg_constraint
  WHERE conname IN ('run_command_outbox_terminal_result','run_command_outbox_aux_lease_shape','claims_hard_flag_reason',
    'findings_hard_flag_reason','draft_operation_states_safety_reason',
    'review_operation_states_safety_reason','revision_operation_states_safety_reason',
    'coherence_checkpoints_safety_reason','export_operations_terminal_result','exports_terminal_result');
  IF readiness_trigger_count <> 5 OR readiness_constraint_count <> 10 THEN
    RAISE EXCEPTION 'production-readiness persistence invariants missing';
  END IF;
  IF EXISTS(SELECT 1 FROM revision_operation_states WHERE status='response_validated') THEN
    RAISE EXCEPTION 'legacy revision operation status remains after backfill';
  END IF;
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

DO $$
BEGIN
  IF (SELECT version FROM application_schema_version WHERE singleton=true) IS DISTINCT FROM 55 THEN
    RAISE EXCEPTION 'application schema readiness marker is missing or stale';
  END IF;
END $$;

SELECT 'database invariants passed' AS result;

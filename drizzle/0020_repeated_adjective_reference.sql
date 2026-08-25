CREATE OR REPLACE FUNCTION enforce_reference_activation_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_version integer;
  target_editorial_status editorial_status;
  target_content_hash text;
  target_kind text;
BEGIN
  SELECT v.version,v.editorial_status,v.content_hash,d.kind::text
  INTO target_version,target_editorial_status,target_content_hash,target_kind
  FROM reference_versions v
  JOIN reference_documents d ON d.id=v.reference_document_id
  WHERE v.id=NEW.reference_version_id;
  IF NEW.provisional_local THEN
    IF target_editorial_status<>'pending_editorial_approval'
       OR EXISTS (SELECT 1 FROM calibration_reference_proposals p WHERE p.reference_version_id=NEW.reference_version_id)
       OR (target_kind,target_version,target_content_hash) NOT IN (
         ('blog_writing_guide',1,'6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c'),
         ('writer_submission_sample',1,'c4e73031e2721c5450a258503ff3ee28a6110b35de5dffe97fe713d6f57b066c'),
         ('internal_linking_guidelines',1,'979a802d9ad2c53e9cd91baaea56ccbcf092dfaef8ed2e98994bc7f21beb20ab'),
         ('fact_checking_rules',1,'c257cd35e20526b8a7f08d5b2e0f38f7f46b1586134dd3376bfecd86f2d1dd71'),
         ('keyword_placement_guidelines',1,'ffd731d8047ae25ceedab871f86cc8208a05de30abd1cee32ce431a033615ab4'),
         ('keyword_placement_guidelines',2,'0d12db27ff5ba2d5c99432cab96fc8f091258c344d9303a9bff86073fd2edf1e'),
         ('pipeline_workflow',1,'97fe5c229a20c6334f4b6a4663bd3a59c8a48c49ecef1cb2763c6e537792fb00')
       ) THEN
      RAISE EXCEPTION 'provisional activation is restricted to an exact task-derived local baseline without calibration proposals' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF target_editorial_status='replaced' OR NOT EXISTS (
    SELECT 1 FROM reference_approval_attestations a
    JOIN reference_attestation_verifications v ON v.attestation_id=a.id
    WHERE a.reference_version_id=NEW.reference_version_id
      AND v.authority_state='trusted_verified'
  ) THEN
    RAISE EXCEPTION 'non-provisional reference activation requires trusted verified approval attestation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

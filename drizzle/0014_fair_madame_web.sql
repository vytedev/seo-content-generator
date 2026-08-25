CREATE TABLE "reference_approval_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_version_id" uuid NOT NULL,
	"recorder_identity" text NOT NULL,
	"approver_identity" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"note" text,
	"authority_state" text DEFAULT 'pending_unverified' NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_approval_attestations_recorder_present" CHECK (length(btrim("reference_approval_attestations"."recorder_identity")) >= 3),
	CONSTRAINT "reference_approval_attestations_approver_present" CHECK (length(btrim("reference_approval_attestations"."approver_identity")) >= 3),
	CONSTRAINT "reference_approval_attestations_evidence_present" CHECK (length(btrim("reference_approval_attestations"."evidence_reference")) >= 1),
	CONSTRAINT "reference_approval_attestations_authority_pending" CHECK ("reference_approval_attestations"."authority_state" = 'pending_unverified')
);
--> statement-breakpoint
CREATE TABLE "reference_attestation_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attestation_id" uuid NOT NULL,
	"verifier_identity" text NOT NULL,
	"authority_state" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_attestation_verifications_verifier_present" CHECK (length(btrim("reference_attestation_verifications"."verifier_identity")) >= 3),
	CONSTRAINT "reference_attestation_verifications_evidence_present" CHECK (length(btrim("reference_attestation_verifications"."evidence_reference")) >= 1),
	CONSTRAINT "reference_attestation_verifications_authority_trusted" CHECK ("reference_attestation_verifications"."authority_state" = 'trusted_verified')
);
--> statement-breakpoint
ALTER TABLE "reference_activations" ADD COLUMN "provisional_local" boolean;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reference_activations x
    JOIN reference_versions v ON v.id=x.reference_version_id
    JOIN reference_documents d ON d.id=v.reference_document_id
    WHERE v.version<>1 OR v.editorial_status<>'pending_editorial_approval'
       OR EXISTS (SELECT 1 FROM calibration_reference_proposals p WHERE p.reference_version_id=v.id)
       OR (d.kind::text,v.content_hash) NOT IN (
         ('blog_writing_guide','6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c'),
         ('writer_submission_sample','c4e73031e2721c5450a258503ff3ee28a6110b35de5dffe97fe713d6f57b066c'),
         ('internal_linking_guidelines','979a802d9ad2c53e9cd91baaea56ccbcf092dfaef8ed2e98994bc7f21beb20ab'),
         ('fact_checking_rules','c257cd35e20526b8a7f08d5b2e0f38f7f46b1586134dd3376bfecd86f2d1dd71'),
         ('keyword_placement_guidelines','ffd731d8047ae25ceedab871f86cc8208a05de30abd1cee32ce431a033615ab4'),
         ('pipeline_workflow','97fe5c229a20c6334f4b6a4663bd3a59c8a48c49ecef1cb2763c6e537792fb00')
       )
  ) THEN
    RAISE EXCEPTION 'existing reference activation is not an exact task-derived local baseline';
  END IF;
END $$;--> statement-breakpoint
UPDATE "reference_activations" SET "provisional_local"=true;--> statement-breakpoint
ALTER TABLE "reference_activations" ALTER COLUMN "provisional_local" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "reference_activations" ALTER COLUMN "provisional_local" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_approval_attestations" ADD CONSTRAINT "reference_approval_attestations_reference_version_id_reference_versions_id_fk" FOREIGN KEY ("reference_version_id") REFERENCES "public"."reference_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_attestation_verifications" ADD CONSTRAINT "reference_attestation_verifications_attestation_id_reference_approval_attestations_id_fk" FOREIGN KEY ("attestation_id") REFERENCES "public"."reference_approval_attestations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reference_approval_attestations_version_unique" ON "reference_approval_attestations" USING btree ("reference_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_attestation_verifications_attestation_unique" ON "reference_attestation_verifications" USING btree ("attestation_id");--> statement-breakpoint
CREATE TRIGGER reference_approval_attestations_immutable BEFORE UPDATE OR DELETE ON reference_approval_attestations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
CREATE TRIGGER reference_attestation_verifications_immutable BEFORE UPDATE OR DELETE ON reference_attestation_verifications FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();--> statement-breakpoint
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
    IF target_version<>1 OR target_editorial_status<>'pending_editorial_approval'
       OR EXISTS (SELECT 1 FROM calibration_reference_proposals p WHERE p.reference_version_id=NEW.reference_version_id)
       OR (target_kind,target_content_hash) NOT IN (
         ('blog_writing_guide','6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c'),
         ('writer_submission_sample','c4e73031e2721c5450a258503ff3ee28a6110b35de5dffe97fe713d6f57b066c'),
         ('internal_linking_guidelines','979a802d9ad2c53e9cd91baaea56ccbcf092dfaef8ed2e98994bc7f21beb20ab'),
         ('fact_checking_rules','c257cd35e20526b8a7f08d5b2e0f38f7f46b1586134dd3376bfecd86f2d1dd71'),
         ('keyword_placement_guidelines','ffd731d8047ae25ceedab871f86cc8208a05de30abd1cee32ce431a033615ab4'),
         ('pipeline_workflow','97fe5c229a20c6334f4b6a4663bd3a59c8a48c49ecef1cb2763c6e537792fb00')
       ) THEN
      RAISE EXCEPTION 'provisional activation is restricted to the exact pending version 1 task-derived local baselines without calibration proposals' USING ERRCODE='23514';
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
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS reference_activation_approved_check ON reference_activations;--> statement-breakpoint
CREATE TRIGGER reference_activation_approved_check BEFORE INSERT OR UPDATE ON reference_activations FOR EACH ROW EXECUTE FUNCTION enforce_reference_activation_approval();
import { createHash } from "node:crypto";
import type pg from "pg";
import {
  REFERENCE_DOCUMENT_SEED_MANIFEST,
  generateReferenceSeedSql,
} from "../../src/db/reference-seed.js";

/**
 * Seeds every reference slot with a trusted-verified, activated local fixture
 * version. The pipeline refuses to snapshot references that are not activated,
 * so an integration run cannot start without this.
 *
 * Shared by every suite that drives a real pipeline run, so the fixtures cannot
 * drift apart between suites.
 */
export async function seedReferenceFixtures(pool: pg.Pool): Promise<void> {
  await pool.query(generateReferenceSeedSql());
  for (const item of REFERENCE_DOCUMENT_SEED_MANIFEST) {
    const body = `# ${item.title}\n\nLocal integration fixture.`;
    const hash = createHash("sha256").update(body).digest("hex");
    await pool.query(
      `with d as (select id from reference_documents where kind=$1)
       insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes)
       select id,1,$2,$3,$4 from d on conflict(reference_document_id,version) do nothing`,
      [item.kind, body, hash, Buffer.byteLength(body)],
    );
    await pool.query(
      `insert into reference_approval_attestations(reference_version_id,recorder_identity,approver_identity,evidence_reference,authority_state)
       select v.id,'local-test-recorder','local-test-approver','local-test-evidence','pending_unverified' from reference_versions v
       join reference_documents d on d.id=v.reference_document_id where d.kind=$1
       on conflict (reference_version_id) do nothing`,
      [item.kind],
    );
    await pool.query(
      `insert into reference_attestation_verifications(attestation_id,verifier_identity,evidence_reference,authority_state)
       select a.id,'local-test-verifier','local-test-evidence','trusted_verified' from reference_approval_attestations a
       join reference_versions v on v.id=a.reference_version_id
       join reference_documents d on d.id=v.reference_document_id where d.kind=$1
       on conflict (attestation_id) do nothing`,
      [item.kind],
    );
    await pool.query(
      `insert into reference_activations(reference_document_id,reference_version_id)
       select d.id,v.id from reference_documents d join reference_versions v on v.reference_document_id=d.id and v.version=1 where d.kind=$1
       on conflict(reference_document_id) do update set reference_version_id=excluded.reference_version_id`,
      [item.kind],
    );
  }
}

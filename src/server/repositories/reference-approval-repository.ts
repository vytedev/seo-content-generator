import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ApprovalAttestationInputSchema,
  ApprovalAttestationSchema,
  type ApprovalAttestation,
  type ApprovalAttestationInput,
  type ApprovalRepository,
} from "../../shared/approval.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../../shared/errors.js";

const LOCAL_RECORDER = "local operator" as const;

export class PostgresReferenceApprovalRepository implements ApprovalRepository {
  constructor(private readonly pool: Pool) {}

  async listVersions() {
    const result = await this.pool.query(
      `select d.kind,d.title,v.id version_id,v.version,v.body_markdown,v.content_hash,
       v.editorial_status,
       case
         when ver.id is not null then 'trusted_verified'
         when a.id is not null then 'pending_unverified'
         else 'none'
       end attestation_state,
       case
         when x.reference_version_id=v.id and x.provisional_local then 'provisional_local_active'
         when x.reference_version_id=v.id and not x.provisional_local then 'trusted_verified_active'
         when ver.id is not null then 'trusted_verified_inactive'
         else 'not_approved'
       end effective_approval_status,
       a.id attestation_id,a.recorder_identity,a.approver_identity,a.evidence_reference,a.note,
       a.authority_state,a.attested_at,(ver.id is not null) trusted_verified,
       (x.reference_version_id=v.id) active,coalesce(x.provisional_local,false) provisional_local
       from reference_documents d join reference_versions v on v.reference_document_id=d.id
       left join reference_approval_attestations a on a.reference_version_id=v.id
       left join reference_attestation_verifications ver on ver.attestation_id=a.id
       left join reference_activations x on x.reference_document_id=d.id
       order by d.kind,v.version desc`,
    );
    return { versions: result.rows };
  }

  async recordPendingAttestation(
    referenceVersionId: string,
    rawInput: ApprovalAttestationInput,
  ): Promise<ApprovalAttestation> {
    const input = ApprovalAttestationInputSchema.parse(rawInput);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const version = await client.query<{ editorial_status: string; eligible: boolean }>(
        `select v.editorial_status,
           (p.reference_version_id is not null) eligible
         from reference_versions v
         left join calibration_reference_proposals p on p.reference_version_id=v.id
         where v.id=$1 for update of v`,
        [referenceVersionId],
      );
      const row = version.rows[0];
      if (!row) throw new NotFoundError("The reference version was not found.");
      if (row.editorial_status === "replaced")
        throw new UnprocessableError("A replaced reference version cannot be attested.");
      if (!row.eligible)
        throw new UnprocessableError(
          "The reference version is not an eligible calibration proposal.",
        );

      const inserted = await client.query<{
        id: string;
        reference_version_id: string;
        recorder_identity: typeof LOCAL_RECORDER;
        approver_identity: string;
        evidence_reference: string;
        note: string | null;
        authority_state: "pending_unverified";
        attested_at: Date;
      }>(
        `insert into reference_approval_attestations
         (id,reference_version_id,recorder_identity,approver_identity,evidence_reference,note)
         values($1,$2,$3,$4,$5,$6)
         on conflict(reference_version_id) do nothing
         returning id,reference_version_id,recorder_identity,approver_identity,evidence_reference,note,
                   authority_state,attested_at`,
        [
          randomUUID(),
          referenceVersionId,
          LOCAL_RECORDER,
          input.approver_identity,
          input.evidence_reference,
          input.note ?? null,
        ],
      );
      const attestation = inserted.rows[0];
      if (!attestation)
        throw new ConflictError("This reference version already has an approval attestation.");
      await client.query("commit");
      return ApprovalAttestationSchema.parse({
        ...attestation,
        note: attestation.note ?? undefined,
        attested_at: attestation.attested_at.toISOString(),
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

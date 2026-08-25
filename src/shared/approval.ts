import { z } from "zod";

const requiredText = z.string().trim().min(1).max(2000);

export const ApprovalAttestationInputSchema = z
  .object({
    approver_identity: z.string().trim().min(3).max(200),
    evidence_reference: requiredText,
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ApprovalAttestationInput = z.infer<typeof ApprovalAttestationInputSchema>;

export const ApprovalAttestationSchema = ApprovalAttestationInputSchema.extend({
  id: z.string().uuid(),
  reference_version_id: z.string().uuid(),
  recorder_identity: z.literal("local operator"),
  authority_state: z.literal("pending_unverified"),
  attested_at: z.string().datetime(),
}).strict();
export type ApprovalAttestation = z.infer<typeof ApprovalAttestationSchema>;

export interface ApprovalRepository {
  recordPendingAttestation(
    referenceVersionId: string,
    input: ApprovalAttestationInput,
  ): Promise<ApprovalAttestation>;
}

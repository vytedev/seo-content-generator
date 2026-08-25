import { z } from "zod";
import { runDetailErrorMessage } from "./run-detail-api.js";
import { apiFetch } from "./api.js";

const ReferenceVersionRowSchema = z.object({
  kind: z.string(),
  title: z.string(),
  version_id: z.string().uuid(),
  version: z.number().int(),
  editorial_status: z.enum(["pending_editorial_approval", "approved", "replaced"]),
  attestation_state: z.enum(["none", "pending_unverified", "trusted_verified"]),
  effective_approval_status: z.enum([
    "provisional_local_active",
    "trusted_verified_active",
    "trusted_verified_inactive",
    "not_approved",
  ]),
  attestation_id: z.string().uuid().nullable(),
  recorder_identity: z.string().nullable(),
  approver_identity: z.string().nullable(),
  evidence_reference: z.string().nullable(),
  note: z.string().nullable(),
  attested_at: z.string().nullable(),
  active: z.boolean(),
  provisional_local: z.boolean(),
});
export type ReferenceVersionRow = z.infer<typeof ReferenceVersionRowSchema>;

const ReferenceVersionsResponseSchema = z.object({
  versions: z.array(ReferenceVersionRowSchema),
});

export async function fetchReferenceVersions(): Promise<ReferenceVersionRow[]> {
  const response = await apiFetch("/api/reference-versions");
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(runDetailErrorMessage(body, "The writing guides could not be loaded."));
  const parsed = ReferenceVersionsResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new Error("The writing guides service returned an unexpected response.");
  return parsed.data.versions;
}

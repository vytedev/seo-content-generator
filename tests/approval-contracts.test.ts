import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApprovalAttestationInputSchema } from "../src/shared/approval.js";

const migration = readFileSync(
  new URL("../drizzle/0014_fair_madame_web.sql", import.meta.url),
  "utf8",
);
const repository = readFileSync(
  new URL("../src/server/repositories/reference-approval-repository.ts", import.meta.url),
  "utf8",
);

describe("reference approval foundation", () => {
  it("records only a claimed approver and external evidence reference", () => {
    expect(
      ApprovalAttestationInputSchema.safeParse({
        approver_identity: "",
        evidence_reference: "",
      }).success,
    ).toBe(false);
    expect(
      ApprovalAttestationInputSchema.parse({
        approver_identity: "Claimed external reviewer",
        evidence_reference: "Local note referencing an external approval record",
      }),
    ).toEqual({
      approver_identity: "Claimed external reviewer",
      evidence_reference: "Local note referencing an external approval record",
    });
  });

  it("separates pending attestations from trusted verification and tightly gates activation", () => {
    expect(migration).toContain("reference_approval_attestations_immutable");
    expect(migration).toContain("reference_attestation_verifications_immutable");
    expect(migration).toContain("authority_state\" = 'pending_unverified'");
    expect(migration).toContain("trusted_verified");
    expect(migration).toContain("target_version<>1");
    expect(migration).toContain("target_editorial_status<>'pending_editorial_approval'");
    expect(migration).toContain("calibration_reference_proposals");
    expect(migration).toContain("(target_kind,target_content_hash) NOT IN");
    expect(migration).toContain("exact pending version 1 task-derived local baselines");
    expect(migration).not.toContain("Aaron");
  });

  it("lists immutable editorial truth separately from attestation and effective approval", () => {
    expect(repository).toContain("v.editorial_status,");
    expect(repository).toContain("end attestation_state");
    expect(repository).toContain("'none'");
    expect(repository).toContain("'pending_unverified'");
    expect(repository).toContain("'trusted_verified'");
    expect(repository).toContain("end effective_approval_status");
    expect(repository).toContain("'provisional_local_active'");
    expect(repository).toContain("'trusted_verified_active'");
    expect(repository).toContain("'trusted_verified_inactive'");
    expect(repository).toContain("'not_approved'");
    expect(repository).not.toContain("when v.editorial_status='replaced' then 'replaced'");
    expect(repository).not.toContain("'trusted_approved_active'");
  });
});

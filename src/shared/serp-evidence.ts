import { z } from "zod";
import { SerpEvidenceSchema, type SerpEvidence } from "./ingest-contracts.js";
import { HandoffSchema, type Handoff } from "./pipeline.js";

export const SerpProbeWorkSchema = z
  .object({
    run_id: z.string().trim().min(1),
    handoff_hash: z.string().regex(/^[a-f0-9]{64}$/),
    command_id: z.string().trim().min(1),
    mode: z.enum(["dispatch", "recover_without_dispatch"]),
    lease_owner: z.string().trim().min(1),
    lease_token: z.string().uuid(),
    lease_expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SerpProbeWork = z.infer<typeof SerpProbeWorkSchema>;

export interface SerpEvidenceRepository {
  claimNextSerpWork(owner: string, leaseMs: number): Promise<SerpProbeWork | null>;
  heartbeatSerpWork(work: SerpProbeWork, leaseMs: number): Promise<void>;
  getSerpProbeHandoff(work: SerpProbeWork): Promise<Handoff>;
  recordSerpEvidence(work: SerpProbeWork, evidence: SerpEvidence): Promise<void>;
}

export function parseSerpEvidence(value: unknown): SerpEvidence {
  return SerpEvidenceSchema.parse(value);
}

export function parseSerpHandoff(value: unknown): Handoff {
  return HandoffSchema.parse(value);
}

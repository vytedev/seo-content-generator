import { ZodError } from "zod";
import { canonicalHash, stableId } from "../../shared/milestone-two.js";
import {
  SerpEvidenceSchema,
  type IngestWarning,
  type SerpEvidence,
} from "../../shared/ingest-contracts.js";
import type { SerpEvidenceRepository, SerpProbeWork } from "../../shared/serp-evidence.js";
import type { SerpProbe } from "../providers/serp-probe.js";

const safeFailure = (error: unknown) =>
  error instanceof ZodError
    ? "SERP provider returned a malformed response."
    : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
      ? "SERP provider timed out."
      : "SERP composition could not be checked.";

export class SerpProbeWorker {
  constructor(
    private readonly repository: SerpEvidenceRepository,
    private readonly probe: SerpProbe | null,
    private readonly owner = `serp-worker-${process.pid}`,
    private readonly leaseMs = 30_000,
  ) {}

  async runOnce(): Promise<boolean> {
    const work = await this.repository.claimNextSerpWork(this.owner, this.leaseMs);
    if (!work) return false;
    const handoff = await this.repository.getSerpProbeHandoff(work);
    const query = handoff.primary_keyword;
    let evidence: SerpEvidence;
    if (work.mode === "recover_without_dispatch") {
      evidence = this.failed(
        work,
        query,
        this.probe?.provider ?? "unknown",
        "SERP probe outcome is unknown after worker restart; it was not repeated.",
      );
    } else if (!this.probe) {
      evidence = this.failed(work, query, "disabled", "SERP probe is not configured.");
    } else {
      try {
        const composition = await this.probe.inspect(handoff);
        evidence = SerpEvidenceSchema.parse({
          evidence_id: stableId("serp-evidence", work.run_id, work.handoff_hash),
          handoff_hash: work.handoff_hash,
          provider: this.probe.provider,
          query,
          retrieved_at: new Date().toISOString(),
          status:
            composition === null
              ? "no_results"
              : composition.commercial > composition.informational
                ? "mismatch"
                : "matched",
          composition,
          failure_reason: null,
        });
      } catch (error) {
        evidence = this.failed(work, query, this.probe.provider, safeFailure(error));
      }
    }
    await this.repository.recordSerpEvidence(work, evidence);
    return true;
  }

  private failed(
    work: SerpProbeWork,
    query: string,
    provider: string,
    reason: string,
  ): SerpEvidence {
    return SerpEvidenceSchema.parse({
      evidence_id: stableId("serp-evidence", work.run_id, work.handoff_hash),
      handoff_hash: work.handoff_hash,
      provider,
      query,
      retrieved_at: new Date().toISOString(),
      status: "failed",
      composition: null,
      failure_reason: reason,
    });
  }
}

export function serpWarning(evidence: SerpEvidence): IngestWarning | null {
  if (evidence.status === "mismatch")
    return {
      code: "serp_composition_mismatch",
      message: "Search results appear predominantly commercial for this blog handoff.",
    };
  if (["failed", "no_results"].includes(evidence.status))
    return {
      code: "serp_probe_failed",
      message: "Search result composition could not be checked; the pipeline continued.",
    };
  return null;
}

export const serpHandoffHash = canonicalHash;

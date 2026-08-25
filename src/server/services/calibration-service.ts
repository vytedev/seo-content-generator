import { createHash } from "node:crypto";
import {
  CALIBRATION_POSTS,
  CalibrationCombinedReportSchema,
  CalibrationClassificationSchema,
  type CalibrationCombinedReport,
  type CalibrationPostResult,
} from "../../shared/contracts/calibration.js";
import type { PublicPageRetriever } from "../providers/public-page-retriever.js";
import type { CalibrationRepository } from "../repositories/calibration-repository.js";
import { compareCalibrationPost } from "./calibration-engine.js";
import type { CalibrationPipelineRunner } from "./calibration-pipeline.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const CALIBRATION_INPUT_HASH = hash({
  version: 2,
  posts: CALIBRATION_POSTS,
  providers: "pinned-local-mocks-only",
  policy: "CAL-ACCEPT-ALL-V1",
});
export class CalibrationService {
  constructor(
    private readonly repository: CalibrationRepository,
    private readonly retriever: PublicPageRetriever,
    private readonly pipeline: CalibrationPipelineRunner,
  ) {}
  async start(key: string) {
    const run = await this.repository.createOrReplay(key, CALIBRATION_INPUT_HASH);
    if (run.status !== "succeeded") await this.resume(run.id);
    return this.repository.getRun(run.id);
  }
  async resume(id: string) {
    const lease = await this.repository.claim(id, `calibration-worker-${process.pid}`);
    if (!lease) return this.repository.getRun(id);
    let checkpoint = (await this.repository.getRun(id)).checkpoint;
    try {
      let snapshots = await this.repository.getSnapshots(id);
      if (snapshots.length < 2) {
        await this.repository.setState(id, lease, "retrieving", checkpoint);
        for (const post of CALIBRATION_POSTS) {
          if (snapshots.some((s) => s.snapshot.slot === post.slot)) continue;
          const snapshot = await this.retriever.retrieve(post.url);
          const generated = await this.pipeline.execute(id, snapshot);
          await this.repository.saveSnapshot(id, lease, snapshot, {
            pipeline_run_id: generated.pipeline_run_id,
            final_document_version_id: generated.final_document_version_id,
            export_id: generated.export_id,
            pipeline_outcome: generated.pipeline_outcome,
          });
        }
        snapshots = await this.repository.getSnapshots(id);
        if (snapshots.length !== 2) throw new Error("CALIBRATION_SNAPSHOTS_INCOMPLETE");
        checkpoint = "snapshots";
        await this.repository.setState(id, lease, "comparing", checkpoint);
      }
      let results = await this.repository.getResults(id);
      for (const stored of snapshots) {
        if (results.some((r) => r.slot === stored.snapshot.slot)) continue;
        const generated = await this.pipeline.execute(id, stored.snapshot);
        if (generated.pipeline_run_id !== stored.binding.pipeline_run_id)
          throw new Error("CALIBRATION_PIPELINE_BINDING_MISMATCH");
        const result = compareCalibrationPost(stored.snapshot, generated);
        await this.repository.saveResult(id, lease, stored.id, result, hash(result));
        checkpoint = stored.snapshot.slot === 1 ? "post_1" : "post_2";
        await this.repository.setState(id, lease, "comparing", checkpoint);
        results = await this.repository.getResults(id);
      }
      if (results.length !== 2) throw new Error("CALIBRATION_RESULTS_INCOMPLETE");
      await this.repository.setState(id, lease, "reporting", "post_2");
      let combined: CalibrationCombinedReport;
      try {
        combined = await this.repository.getCombined(id);
      } catch {
        combined = this.combine(
          id,
          snapshots.map((s) => s.snapshot.content_hash),
          results,
        );
        await this.repository.saveCombined(id, lease, combined, hash(combined));
      }
      await this.repository.setState(id, lease, "succeeded", "combined");
      return this.repository.getRun(id);
    } catch (error) {
      try {
        await this.repository.setState(
          id,
          lease,
          "retryable_failed",
          checkpoint,
          "CALIBRATION_OPERATION_FAILED",
        );
      } catch {}
      throw error;
    }
  }
  private combine(
    id: string,
    snapshotHashes: string[],
    results: CalibrationPostResult[],
  ): CalibrationCombinedReport {
    const counts = Object.fromEntries(CalibrationClassificationSchema.options.map((k) => [k, 0]));
    for (const result of results)
      for (const o of result.observations) counts[o.classification]! += 1;
    return CalibrationCombinedReportSchema.parse({
      calibration_run_id: id,
      snapshot_hashes: snapshotHashes,
      result_hashes: results.map(hash),
      classification_counts: counts,
      shared_recommendations: this.repeatedRecommendations(results),
      rule_weakening_prohibited: true,
      provenance_remains_hard_flagged: true,
      unresolved_claims_remain_unverified: true,
      generated_at: new Date().toISOString(),
    });
  }
  private repeatedRecommendations(results: CalibrationPostResult[]): string[] {
    const repeated = new Map<string, Set<number>>();
    for (const result of results) {
      for (const observation of result.observations) {
        const key = `${observation.dimension}:${observation.classification}`;
        const slots = repeated.get(key) ?? new Set<number>();
        slots.add(result.slot);
        repeated.set(key, slots);
      }
    }
    const recommendations = [
      "Preserve provenance hard flags and unresolved claims.",
      "Treat pinned mock limits separately from demonstrated rule defects.",
    ];
    if (
      [...repeated.entries()].some(
        ([key, slots]) =>
          key.endsWith(":missing_or_ambiguous_reference_guidance") && slots.size > 1,
      )
    )
      recommendations.push(
        "Repeated cross-post ambiguity supports editorial review of the relevant reference guidance; deterministic rules remain unchanged pending approval.",
      );
    return recommendations;
  }
}

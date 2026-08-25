import { mapDeterministicInput } from "../../shared/milestone-three.js";
import type {
  DeterministicFixture,
  MilestoneThreeRepository,
} from "../../shared/milestone-three.js";
import {
  planEditorialCorrection,
  type EditorialCorrectionPlan,
} from "../../shared/editorial-correction.js";
import { ConflictError } from "../../shared/errors.js";
import { logger } from "../logger.js";

export type EditorialCorrectionOutcome =
  | { readonly status: "not_required"; readonly checker_version: string }
  | {
      readonly status: "opened" | "already_open";
      readonly checker_version: string;
      readonly finding_count: number;
      readonly newly_applicable_rule_ids: readonly string[];
      readonly round: number;
    };

/**
 * Opens a controlled editorial correction for a run whose deterministic
 * baseline was frozen under an earlier checker version.
 *
 * It reuses the ordinary pipeline primitives only: the frozen manifest is read,
 * never rewritten; the frozen document version is read, never mutated; the
 * newly applicable findings are persisted against that same version and the run
 * is parked at the normal Step 1.9 operator wait. Every correction then travels
 * the existing findings-review and controlled-revision path, which is what
 * creates the new immutable child version with lineage.
 */
export class EditorialCorrectionOrchestrator {
  constructor(
    private readonly repository: MilestoneThreeRepository,
    private readonly fixture: DeterministicFixture,
  ) {}

  async open(runId: string, owner = "local-operator"): Promise<EditorialCorrectionOutcome> {
    const step = "findings_review" as const;
    const draft = await this.repository.getDraft(runId);
    if (!draft) throw new ConflictError("The run has no immutable document version to correct.");
    const handoff = await this.repository.getHandoff(runId);
    const links = (await this.repository.getLinks(runId)) ?? [];
    const { manifest } = await this.repository.getDeterministicManifest(runId);

    // The frozen manifest supplies exactly one thing: which rules that run
    // actually evaluated. It does not decide which document to correct.
    //
    // Requiring the baseline document to still be the current version rejected
    // every run that had ever revised - and Step 1.12 cannot be reached without
    // a revised parent/current pair, so that guard excluded precisely the runs
    // this entry point exists for. The document under correction is therefore
    // the run's current immutable version, and the round is fenced on that
    // version's id and content hash instead. getDeterministicManifest validates
    // the manifest's run lineage, so the inventory cannot come from another run.
    const baselineIsCurrent = manifest.baseline_document.id === draft.version.id;
    logger.info("correction.baseline_resolved", {
      run_id: runId,
      baseline_version_id: manifest.baseline_document.id,
      baseline_checker_version: manifest.checker_version,
      baseline_rule_inventory_count: manifest.rule_inventory.length,
    });
    logger.info("correction.current_version_resolved", {
      run_id: runId,
      current_version_id: draft.version.id,
      current_parent_id: draft.version.parent_id,
      current_revision: draft.version.revision,
      baseline_equals_current: baselineIsCurrent,
      current_descends_from_baseline: !baselineIsCurrent,
    });

    const plan: EditorialCorrectionPlan = planEditorialCorrection({
      manifest,
      checkerInput: mapDeterministicInput({
        run_id: runId,
        document_version_id: draft.version.id,
        handoff,
        draft: draft.draft,
        persisted_links: links,
        fixture: this.fixture,
      }),
    });

    const safe = {
      run_id: runId,
      correction_checker_version: plan.checker_version,
      baseline_checker_version: manifest.checker_version,
      newly_applicable_rule_count: plan.newly_applicable_rule_ids.length,
      finding_count: plan.findings.length,
    };

    if (plan.findings.length === 0) {
      logger.info("editorial_correction.not_required", { ...safe, reason: "no_new_findings" });
      return { status: "not_required", checker_version: plan.checker_version };
    }

    // One atomic, fenced repository operation: it verifies the source version,
    // its content hash and the active round before any write, opens the next
    // round, and replays instead of duplicating when already open.
    let opened: Awaited<ReturnType<MilestoneThreeRepository["openEditorialCorrectionRound"]>>;
    try {
      opened = await this.repository.openEditorialCorrectionRound({
        run_id: runId,
        document_version_id: draft.version.id,
        expected_content_hash: draft.version.content_hash,
        checker_version: plan.checker_version,
        findings: [...plan.findings],
      });
    } catch (error) {
      logger.info("correction.open_rejected", {
        ...safe,
        correction_source_version_id: draft.version.id,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
    logger.info(`editorial_correction.${opened.status}`, { ...safe, round: opened.round });
    return {
      status: opened.status === "replayed" ? "already_open" : "opened",
      checker_version: plan.checker_version,
      finding_count: plan.findings.length,
      newly_applicable_rule_ids: plan.newly_applicable_rule_ids,
      round: opened.round,
    };
  }
}

import { canonicalHash } from "../../shared/milestone-two.js";
import {
  createDeterministicManifest,
  runVersionedDeterministicChecks,
} from "../../shared/deterministic-run.js";
import { inventoryFacts } from "../../shared/fact-inventory.js";
import { deriveFactHardFlagReason } from "../../shared/hard-flags.js";
import {
  auditDraftLinks,
  NoNetworkDraftLinkVerifier,
  type DraftLinkVerifier,
} from "../../shared/link-conversion-review.js";
import {
  REVIEW_STEPS,
  PersistedReviewFindingSchema,
  PersistedReviewResponseSchema,
  ReviewResponseSchema,
  mapDeterministicInput,
  type DeterministicFixture,
  type MilestoneThreeRepository,
  type PersistedReviewFinding,
  type PersistedReviewResponse,
  type ReviewStep,
} from "../../shared/milestone-three.js";
import type { PipelineStepId } from "../../shared/pipeline.js";
import type { ReviewProvider } from "../providers/review-provider.js";
import {
  NoNetworkFactVerifier,
  factFindingStableKey,
  type FactVerifier,
} from "../providers/fact-verifier.js";
import { withHeartbeat } from "./lease-heartbeat.js";
import { classifyError, logger } from "../logger.js";
import { executePaidOperation } from "../providers/paid-operation-lifecycle.js";

export type MilestoneThreeFailureBoundary =
  | "after_reference_snapshot"
  | "after_deterministic_persist"
  | "after_review_begin"
  | "after_review_provider"
  | "after_review_persist"
  | "after_wait";

const NEXT: Record<PipelineStepId, PipelineStepId> = {
  ingest_handoff: "internal_link_discovery",
  internal_link_discovery: "draft",
  draft: "automated_checks",
  automated_checks: "review_writing_style",
  review_writing_style: "review_information_gain",
  review_information_gain: "review_fact_checking",
  review_fact_checking: "review_link_conversion",
  review_link_conversion: "findings_review",
  findings_review: "revision_pass",
  revision_pass: "automated_checks_rerun",
  automated_checks_rerun: "final_coherence_export",
  final_coherence_export: "final_coherence_export",
};

/** Runs 1.4–1.9 in canonical order and stops at the operator wait. */
export class MilestoneThreeOrchestrator {
  constructor(
    private readonly repository: MilestoneThreeRepository,
    private readonly fixture: DeterministicFixture,
    private readonly reviews: ReviewProvider,
    private readonly failures?: {
      hit(boundary: MilestoneThreeFailureBoundary): void | Promise<void>;
    },
    private readonly factVerifier: FactVerifier = new NoNetworkFactVerifier(),
    private readonly linkVerifier: DraftLinkVerifier = new NoNetworkDraftLinkVerifier(),
  ) {}

  async run(runId: string, owner = "local-worker"): Promise<void> {
    if (!(await this.repository.stepSucceeded(runId, "draft")))
      throw new Error("Step 1.3 must be completed first");
    await this.runChecks(runId, owner);
    for (const step of REVIEW_STEPS) await this.runReview(runId, step, owner);
    await this.runWait(runId, owner);
  }

  private async context(runId: string) {
    const draft = await this.repository.getDraft(runId);
    if (!draft) throw new Error("Immutable draft document version is missing");
    return {
      draft,
      handoff: await this.repository.getHandoff(runId),
      links: (await this.repository.getLinks(runId)) ?? [],
    };
  }

  private async runChecks(runId: string, owner: string): Promise<void> {
    const step = "automated_checks" as const;
    if (await this.repository.stepSucceeded(runId, step)) return;
    const lease = await this.repository.claimStep(runId, step, owner);
    try {
      const snapshots = await this.repository.snapshotReferences(
        runId,
        lease.execution_id,
        lease.token,
      );
      await this.failures?.hit("after_reference_snapshot");
      const { draft, handoff, links } = await this.context(runId);
      const linksArtifact = await this.repository.getLinksArtifact(runId);
      if (!linksArtifact) throw new Error("Immutable Step 1.2 link artefact is missing");
      if (!(await this.repository.hasStepOutput(runId, draft.version.id, step))) {
        const checkerInput = mapDeterministicInput({
          run_id: runId,
          document_version_id: draft.version.id,
          handoff,
          draft: draft.draft,
          persisted_links: links,
          fixture: this.fixture,
        });
        const verification = new Map(
          checkerInput.verified_internal_links.map((link) => [link.url, link]),
        );
        links.forEach((link) => {
          if (!verification.has(link.url))
            throw new Error(`Frozen shortlist metadata is incomplete: ${link.url}`);
        });
        const fixtureContent = {
          internal_origins: this.fixture.internal_origins,
          link_verification: this.fixture.link_verification,
        };
        const manifest = createDeterministicManifest({
          run_id: runId,
          document: { id: draft.version.id, content_hash: draft.version.content_hash },
          handoff,
          checker_input: checkerInput,
          fixture: {
            source_identity: "application://deterministic-fixture/local-v1",
            content_hash: canonicalHash(fixtureContent),
            content: fixtureContent,
          },
          internal_links_artifact: linksArtifact,
          references: snapshots.map((snapshot) => ({ ...snapshot, executable: false as const })),
          producing_execution_id: lease.execution_id,
          executed_at: new Date().toISOString(),
        });
        const result = runVersionedDeterministicChecks(
          checkerInput,
          manifest.baseline_document,
          manifest,
        );
        const findings: PersistedReviewFinding[] = result.findings.map((finding) =>
          PersistedReviewFindingSchema.parse({
            stable_key: finding.id,
            category: "deterministic",
            rule_reference: finding.rule,
            severity: finding.severity,
            location: finding.location,
            issue: finding.issue,
            suggested_fix: finding.suggested_fix,
            hard_flag: false,
          }),
        );
        await this.repository.saveDeterministicBaseline({
          run_id: runId,
          document_version_id: draft.version.id,
          execution_id: lease.execution_id,
          token: lease.token,
          manifest,
          result,
          findings,
        });
        await this.failures?.hit("after_deterministic_persist");
      } else {
        throw new Error("Step output belongs to another producing attempt");
      }
    } catch (error) {
      await this.safeFail(lease.execution_id, lease.token, error);
      throw error;
    }
  }

  private async runReview(runId: string, step: ReviewStep, owner: string): Promise<void> {
    if (await this.repository.stepSucceeded(runId, step)) return;
    const lease = await this.repository.claimStep(runId, step, owner);
    try {
      const snapshots = await this.repository.snapshotReferences(
        runId,
        lease.execution_id,
        lease.token,
      );
      await this.failures?.hit("after_reference_snapshot");
      const { draft, handoff, links } = await this.context(runId);
      if (!(await this.repository.hasStepOutput(runId, draft.version.id, step))) {
        const factInventory = step === "review_fact_checking" ? inventoryFacts(draft.draft) : [];
        const linkAudit =
          step === "review_link_conversion"
            ? await withHeartbeat(this.repository, lease, () =>
                auditDraftLinks(
                  {
                    draft: draft.draft,
                    shortlist: links,
                    internal_origins: this.fixture.internal_origins,
                  },
                  this.linkVerifier,
                ),
              )
            : undefined;
        const request = {
          run_id: runId,
          step,
          document_version_id: draft.version.id,
          handoff,
          draft: draft.draft,
          internal_links: links,
          reference_snapshots: snapshots,
          fact_inventory: factInventory,
          ...(linkAudit ? { link_review_context: linkAudit.review_context } : {}),
          prompt: { template_id: `mobelaris.${step}`, template_version: "2.0.0" },
          temperature: 0,
          model: this.reviews.model,
        };
        const operation = await this.repository.beginReviewOperation({
          run_id: runId,
          document_version_id: draft.version.id,
          execution_id: lease.execution_id,
          token: lease.token,
          step,
          request,
          provider: this.reviews.provider,
          model: this.reviews.model,
        });
        await this.failures?.hit("after_review_begin");
        let response: PersistedReviewResponse | null = operation.response;
        if (response) {
          logger.info("provider.replayed", {
            run_id: runId,
            operation_id: operation.operation_id,
            provider: this.reviews.provider,
            context: "review",
            step,
            replayed: true,
          });
        }
        if (!response) {
          logger.info("provider.reserved", {
            run_id: runId,
            operation_id: operation.operation_id,
            provider: this.reviews.provider,
            context: "review",
            step,
            state: "reserved",
          });
          const command = {
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            operation_id: operation.operation_id,
          };
          try {
            response = await executePaidOperation<
              typeof command,
              Awaited<ReturnType<ReviewProvider["review"]>>,
              PersistedReviewResponse
            >({
              kind: "review",
              command,
              adapter: {
                markInFlight: (value) => this.repository.markReviewProviderInFlight(value),
                release: (value, reason) =>
                  this.repository.releaseReviewProviderFailure({ ...value, reason }),
                checkpoint: (value, checked) =>
                  this.repository.checkpointReviewResponse({ ...value, response: checked }),
              },
              dispatch: async () => {
                logger.info("provider.dispatch_started", {
                  run_id: runId,
                  operation_id: operation.operation_id,
                  provider: this.reviews.provider,
                  context: "review",
                  step,
                });
                const raw = await withHeartbeat(this.repository, lease, () =>
                  this.reviews.review(request),
                );
                logger.info("provider.returned", {
                  run_id: runId,
                  operation_id: operation.operation_id,
                  provider: this.reviews.provider,
                  context: "review",
                  step,
                });
                return raw;
              },
              validate: async (raw) => {
                const providerResponse = ReviewResponseSchema.parse(raw);
                const reviewed =
                  step === "review_fact_checking"
                    ? await withHeartbeat(this.repository, lease, async () => {
                        const verified = await this.factVerifier.verify(request, providerResponse);
                        return ReviewResponseSchema.parse(verified);
                      })
                    : providerResponse;
                const checked = {
                  ...reviewed,
                  findings: reviewed.findings.map((finding) => {
                    const hardFlagReason =
                      step === "review_fact_checking"
                        ? factInventory
                            .filter(
                              (item) =>
                                finding.stable_key ===
                                  factFindingStableKey(item.stable_key, "unverified") ||
                                finding.stable_key ===
                                  factFindingStableKey(item.stable_key, "contradicted"),
                            )
                            .map(deriveFactHardFlagReason)
                            .find((reason) => reason !== null)
                        : null;
                    return {
                      ...finding,
                      hard_flag: Boolean(hardFlagReason),
                      ...(hardFlagReason ? { hard_flag_reason: hardFlagReason } : {}),
                    };
                  }),
                };
                logger.info("provider.response_validated", {
                  run_id: runId,
                  operation_id: operation.operation_id,
                  provider: this.reviews.provider,
                  context: "review",
                  step,
                });
                await this.failures?.hit("after_review_provider");
                return checked;
              },
            });
          } catch (error) {
            logger.warn("provider.dispatch_failed", {
              run_id: runId,
              operation_id: operation.operation_id,
              provider: this.reviews.provider,
              context: "review",
              step,
              ...classifyError(error),
            });
            throw error;
          }
          logger.info("provider.checkpointed", {
            run_id: runId,
            operation_id: operation.operation_id,
            provider: this.reviews.provider,
            context: "review",
            step,
          });
        }
        if (!response) throw new Error("Review operation did not produce a response");
        const checkpointResponse = response;
        const finalResponse =
          step === "review_link_conversion" && linkAudit
            ? PersistedReviewResponseSchema.parse({
                ...checkpointResponse,
                findings: [
                  ...linkAudit.findings.map((finding) => ({ ...finding, hard_flag: false })),
                  ...checkpointResponse.findings,
                ],
              })
            : checkpointResponse;
        await this.repository.saveReview(
          runId,
          draft.version.id,
          lease.execution_id,
          lease.token,
          step,
          request,
          finalResponse,
          this.reviews.provider,
          this.reviews.model,
          step === "review_link_conversion" ? checkpointResponse : undefined,
        );
        logger.info("provider.persistence_completed", {
          run_id: runId,
          operation_id: operation.operation_id,
          provider: this.reviews.provider,
          context: "review",
          step,
        });
        await this.failures?.hit("after_review_persist");
      } else {
        throw new Error("Step output belongs to another producing attempt");
      }
    } catch (error) {
      await this.safeFail(lease.execution_id, lease.token, error);
      throw error;
    }
  }

  private async runWait(runId: string, owner: string): Promise<void> {
    const step = "findings_review" as const;
    if (
      (await this.repository.stepSucceeded(runId, step)) ||
      (await this.repository.stepWaiting(runId, step))
    )
      return;
    const lease = await this.repository.claimStep(runId, step, owner);
    try {
      await this.repository.snapshotReferences(runId, lease.execution_id, lease.token);
      await this.failures?.hit("after_reference_snapshot");
      await this.repository.waitForFindings(runId, lease.execution_id, lease.token);
      await this.failures?.hit("after_wait");
    } catch (error) {
      // Waiting has intentionally released its lease; only running attempts can be failed.
      if (!(await this.repository.stepSucceeded(runId, step)))
        await this.safeFail(lease.execution_id, lease.token, error);
      throw error;
    }
  }

  private async safeFail(executionId: string, token: string, error: unknown): Promise<void> {
    try {
      await this.repository.failStep(
        executionId,
        token,
        error instanceof Error ? error.message : "Unknown failure",
      );
    } catch {
      // The meaningful side effect may already have atomically released the lease.
    }
  }
}

export { NEXT as MILESTONE_THREE_NEXT_STEP };

import {
  DraftProviderResponseSchema,
  InternalLinkSchema,
  type DraftProviderResponse,
  type InternalLink,
  type LinkDiscoveryMetadata,
  type MilestoneRepository,
} from "../../shared/milestone-two.js";
import type { DraftProvider } from "../providers/contracts.js";
import { withHeartbeat } from "./lease-heartbeat.js";
import { classifyError, logger } from "../logger.js";
import { executePaidOperation } from "../providers/paid-operation-lifecycle.js";

export type FailureBoundary =
  | "after_link_persist"
  | "after_draft_reservation"
  | "after_provider_return"
  | "after_provider"
  | "after_draft_persist";

export interface FailureInjector {
  hit(boundary: FailureBoundary): void | Promise<void>;
}
export interface LinkDiscoveryResult extends Omit<LinkDiscoveryMetadata, "bypass"> {
  links: InternalLink[];
  /** Discoverers do not author bypass evidence; orchestration binds and persists it. */
  bypass?: LinkDiscoveryMetadata["bypass"];
}
export interface LinkDiscoverer {
  discover(
    primaryKeyword: string,
    options?: { refresh?: boolean },
  ): Promise<InternalLink[] | LinkDiscoveryResult>;
}

export class MockLinkDiscoverer implements LinkDiscoverer {
  constructor(private readonly links: InternalLink[] = []) {}
  async discover(_primaryKeyword: string): Promise<InternalLink[]> {
    return this.links.map((link) => InternalLinkSchema.parse(link));
  }
}

/** Resumes at the first incomplete step; persisted outputs prevent duplicate side effects. */
export class MilestoneTwoOrchestrator {
  constructor(
    private readonly repository: MilestoneRepository,
    private readonly links: LinkDiscoverer,
    private readonly drafts: DraftProvider,
    private readonly failures?: FailureInjector,
    /** Temporary local test-only capability; default false. */
    private readonly allowUnverifiedLinkBypass = false,
  ) {}

  async run(
    runId: string,
    owner = "local-worker",
    options: { refreshLinkDiscovery?: boolean; operatorAuthorisedDraftRecovery?: boolean } = {},
  ): Promise<void> {
    if (!(await this.repository.stepSucceeded(runId, "ingest_handoff")))
      throw new Error("Step 1.1 must be completed by ingestHandoff first");
    await this.runLinks(runId, owner, options.refreshLinkDiscovery ?? false);
    await this.runDraft(runId, owner, options.operatorAuthorisedDraftRecovery ?? false);
  }

  /** Isolated Step 1.2 refresh: never grants draft or any later-step authority. */
  async refreshLinks(runId: string, owner = "local-worker"): Promise<void> {
    if (!(await this.repository.stepSucceeded(runId, "ingest_handoff")))
      throw new Error("Step 1.1 must be completed by ingestHandoff first");
    await this.runLinks(runId, owner, true, true);
  }

  private async runLinks(
    runId: string,
    owner: string,
    refresh: boolean,
    preserveFailureProgress = false,
  ): Promise<void> {
    const alreadySucceeded = await this.repository.stepSucceeded(runId, "internal_link_discovery");
    if (alreadySucceeded && !refresh) return;
    const lease = await this.repository.claimStep(
      runId,
      "internal_link_discovery",
      owner,
      alreadySucceeded && refresh,
    );
    try {
      let links = await this.repository.getLinks(runId);
      if (!links || refresh) {
        const handoff = await this.repository.getHandoff(runId);
        const discovered = await withHeartbeat(this.repository, lease, () =>
          this.links.discover(handoff.primary_keyword, { refresh }),
        );
        const result = Array.isArray(discovered)
          ? { links: discovered, metadata: undefined }
          : {
              links: discovered.links,
              metadata: {
                availability: discovered.availability,
                eligibility: discovered.eligibility,
                ...(discovered.reason ? { reason: discovered.reason } : {}),
                providerStatus: discovered.providerStatus,
                counts: discovered.counts,
                cache: discovered.cache,
                identity: discovered.identity,
                ...(discovered.cacheId ? { cacheId: discovered.cacheId } : {}),
                ...(discovered.cacheWrite ? { cacheWrite: discovered.cacheWrite } : {}),
              },
            };
        links = result.links;
        const blocked =
          result.metadata?.eligibility === "blocked" ||
          Boolean(result.metadata && links.length === 0);
        const metadata = result.metadata
          ? {
              ...result.metadata,
              bypass: {
                enabled: this.allowUnverifiedLinkBypass,
                used: blocked && this.allowUnverifiedLinkBypass,
                reason:
                  blocked && this.allowUnverifiedLinkBypass
                    ? ("local_unverified_link_testing" as const)
                    : null,
              },
            }
          : undefined;
        if (blocked) {
          if (metadata && !this.allowUnverifiedLinkBypass)
            await this.repository.saveLinkDiscoveryEvidence(
              runId,
              lease.execution_id,
              lease.token,
              metadata,
            );
          if (!this.allowUnverifiedLinkBypass) throw new Error(linkDiscoveryBlockMessage(metadata));
          // Persist immutable evidence that the local-only bypass was used. The
          // honest empty shortlist and every downstream/export gate remain unchanged.
        }
        if (alreadySucceeded) {
          // Refresh cannot replace the shortlist already consumed by paid downstream steps.
          // Persist only this attempt's evidence and cache CAS; downstream steps remain replay-safe.
          if (metadata)
            await this.repository.saveLinkDiscoveryEvidence(
              runId,
              lease.execution_id,
              lease.token,
              metadata,
            );
        } else {
          await this.repository.saveLinks(runId, lease.execution_id, lease.token, links, metadata);
          await this.failures?.hit("after_link_persist");
        }
      }
      await this.repository.completeStep(lease.execution_id, lease.token, alreadySucceeded);
    } catch (error) {
      await this.repository.failStep(
        lease.execution_id,
        lease.token,
        error instanceof Error ? error.message : "Unknown failure",
        preserveFailureProgress,
      );
      throw error;
    }
  }

  private async runDraft(
    runId: string,
    owner: string,
    operatorAuthorisedDraftRecovery: boolean,
  ): Promise<void> {
    if (await this.repository.stepSucceeded(runId, "draft")) return;
    const lease = await this.repository.claimStep(runId, "draft", owner);
    try {
      let persisted = await this.repository.getDraft(runId);
      if (!persisted) {
        const handoff = await this.repository.getHandoff(runId);
        const links = (await this.repository.getLinks(runId)) ?? [];
        const referenceSnapshots = await this.repository.snapshotReferences(
          runId,
          lease.execution_id,
          lease.token,
        );
        const request = {
          handoff,
          internal_links: links,
          model: this.drafts.model,
          reference_snapshots: referenceSnapshots,
          prompt: this.drafts.prompt,
        };
        const operation = await this.repository.beginDraftOperation({
          run_id: runId,
          execution_id: lease.execution_id,
          token: lease.token,
          request,
          provider: this.drafts.provider,
          model: this.drafts.model,
          contract_identity: this.drafts.contractIdentity,
          purpose: operatorAuthorisedDraftRecovery ? "legacy_operator_recovery" : "initial",
          operator_authorised: operatorAuthorisedDraftRecovery,
        });
        let response: DraftProviderResponse | null = operation.response;
        if (response) {
          logger.info("provider.replayed", {
            run_id: runId,
            operation_id: operation.identity.operation_id,
            provider: this.drafts.provider,
            context: "draft",
            replayed: true,
          });
        }
        if (!response) {
          logger.info("provider.reserved", {
            run_id: runId,
            operation_id: operation.identity.operation_id,
            provider: this.drafts.provider,
            context: "draft",
            state: "reserved",
          });
          const command = {
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            identity: operation.identity,
          };
          try {
            response = await executePaidOperation<
              typeof command,
              Awaited<ReturnType<DraftProvider["generate"]>>,
              DraftProviderResponse
            >({
              kind: "draft",
              command,
              adapter: {
                markInFlight: async (value) => {
                  await this.repository.markDraftProviderInFlight(value);
                  await this.failures?.hit("after_draft_reservation");
                },
                release: (value, reason) =>
                  this.repository.releaseDraftProviderFailure({ ...value, reason }),
                checkpoint: (value, checked) =>
                  this.repository.checkpointDraftResponse({ ...value, response: checked }),
              },
              dispatch: async () => {
                logger.info("provider.dispatch_started", {
                  run_id: runId,
                  operation_id: operation.identity.operation_id,
                  provider: this.drafts.provider,
                  context: "draft",
                });
                const raw = await withHeartbeat(this.repository, lease, () =>
                  this.drafts.generate(request),
                );
                logger.info("provider.returned", {
                  run_id: runId,
                  operation_id: operation.identity.operation_id,
                  provider: this.drafts.provider,
                  context: "draft",
                });
                await this.failures?.hit("after_provider_return");
                return raw;
              },
              validate: (raw) => {
                const checked = DraftProviderResponseSchema.parse(raw);
                logger.info("provider.response_validated", {
                  run_id: runId,
                  operation_id: operation.identity.operation_id,
                  provider: this.drafts.provider,
                  context: "draft",
                });
                return checked;
              },
            });
          } catch (error) {
            logger.warn("provider.dispatch_failed", {
              run_id: runId,
              operation_id: operation.identity.operation_id,
              provider: this.drafts.provider,
              context: "draft",
              ...classifyError(error),
            });
            throw error;
          }
          logger.info("provider.checkpointed", {
            run_id: runId,
            operation_id: operation.identity.operation_id,
            provider: this.drafts.provider,
            context: "draft",
          });
        }
        if (!response) throw new Error("Draft operation did not produce a response");
        await this.failures?.hit("after_provider");
        persisted = await this.repository.saveDraft(
          runId,
          lease.execution_id,
          lease.token,
          response,
          operation.identity,
        );
        logger.info("provider.persistence_completed", {
          run_id: runId,
          operation_id: operation.identity.operation_id,
          provider: this.drafts.provider,
          context: "draft",
        });
        await this.failures?.hit("after_draft_persist");
      }
      void persisted;
      await this.repository.completeStep(lease.execution_id, lease.token);
    } catch (error) {
      await this.repository.failStep(
        lease.execution_id,
        lease.token,
        error instanceof Error ? error.message : "Unknown failure",
      );
      throw error;
    }
  }
}

function linkDiscoveryBlockMessage(metadata: LinkDiscoveryMetadata | undefined): string {
  const health = metadata
    ? `Sitemap ${metadata.providerStatus.sitemap ?? "historical_unknown"}; Search Console ${metadata.providerStatus.gsc}`
    : "source health unavailable";
  const reason = metadata?.reason ?? "no_candidates";
  const explanation = {
    source_unavailable: "required discovery sources are unavailable or not configured",
    no_candidates: "the sources returned no candidates",
    editorial_only: "the sources returned editorial pages only",
    verification_failed: "no commercial candidate returned a direct HTTP 200",
    verified_commercial_candidates: "no eligible shortlist was produced",
  }[reason];
  return `Link discovery blocked: ${explanation}. ${health}. Retry link discovery after checking the connection or configuration.`;
}

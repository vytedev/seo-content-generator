import {
  DraftProviderResponseSchema,
  InternalLinkSchema,
  type InternalLink,
  type LinkDiscoveryMetadata,
  type MilestoneRepository,
} from "../../shared/milestone-two.js";
import type { DraftProvider } from "../providers/contracts.js";
import { withHeartbeat } from "./lease-heartbeat.js";

export type FailureBoundary = "after_link_persist" | "after_provider" | "after_draft_persist";
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
    options: { refreshLinkDiscovery?: boolean } = {},
  ): Promise<void> {
    if (!(await this.repository.stepSucceeded(runId, "ingest_handoff")))
      throw new Error("Step 1.1 must be completed by ingestHandoff first");
    await this.runLinks(runId, owner, options.refreshLinkDiscovery ?? false);
    await this.runDraft(runId, owner);
  }

  private async runLinks(runId: string, owner: string, refresh: boolean): Promise<void> {
    if (await this.repository.stepSucceeded(runId, "internal_link_discovery")) return;
    const lease = await this.repository.claimStep(runId, "internal_link_discovery", owner);
    try {
      let links = await this.repository.getLinks(runId);
      if (!links) {
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
        await this.repository.saveLinks(runId, lease.execution_id, lease.token, links, metadata);
        await this.failures?.hit("after_link_persist");
      }
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

  private async runDraft(runId: string, owner: string): Promise<void> {
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
          prompt: { template_id: "mobelaris.draft" as const, template_version: "2.0.0" },
        };
        // Model generation can legitimately exceed the lease interval; renew
        // the fencing lease while the provider call is genuinely in flight.
        const response = DraftProviderResponseSchema.parse(
          await withHeartbeat(this.repository, lease, () => this.drafts.generate(request)),
        );
        await this.failures?.hit("after_provider");
        persisted = await this.repository.saveDraft(
          runId,
          lease.execution_id,
          lease.token,
          response,
          this.drafts.provider,
          this.drafts.model,
          request,
        );
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

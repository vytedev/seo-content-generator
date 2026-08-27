import { canonicalHash, stableId } from "../../shared/milestone-two.js";
import {
  checkerInputFromManifest,
  compareDeterministicResults,
  deterministicHash,
  runVersionedDeterministicChecks,
  validateDeterministicBaseline,
  validateDeterministicManifest,
} from "../../shared/deterministic-run.js";
import { renderExport } from "../../shared/export.js";
import { applyRevisionEnvelope } from "../../shared/revision-application.js";
import {
  READABILITY_SELECTOR_VERSION,
  REVISION_BINDING_VERSION,
  REVISION_PLANNING_VERSION,
  bindRevisionFindingsWithAuthority,
  mergeRevisionPlan,
  planRevisionRequest,
  readabilityTargetSetIdentity,
  revisionBindingExclusions,
} from "../../shared/revision-planning.js";
import {
  mapDeterministicInput,
  ReviewFindingSchema,
  type DeterministicFixture,
} from "../../shared/milestone-three.js";
import {
  CoherenceResponseSchema,
  RevisionGuardError,
  RevisionResponseSchema,
  assertSafeRevision,
  assertCoherenceBlockerEligibility,
  type FinalExportService,
  type MilestoneFourRepository,
  type RevisionSafeFailureCategory,
} from "../../shared/milestone-four.js";
import type { DeterministicManifest } from "../../shared/deterministic-run.js";
import type { StructuredDraft } from "../../shared/contracts/content.js";
import type { FindingLocation, FindingResult } from "../../shared/revision-application.js";
import type { RevisionFinding } from "../../shared/milestone-four.js";
import { RevisionProviderError } from "../providers/chat-completion-revision-provider.js";
import { CoherenceProviderError } from "../providers/chat-completion-coherence-provider.js";
import type { CoherenceProvider, RevisionProvider } from "../providers/milestone-four-providers.js";
import { classifyError, logger } from "../logger.js";
import { withHeartbeat } from "./lease-heartbeat.js";

// Version 2.2.0 starts a new immutable provider operation after the Step 1.8
// occurrence-scoped contract change. Earlier provider_in_flight reservations
// remain preserved and are never retried or overwritten.
export const REVISION_PROMPT_VERSION = "2.2.0";
const COHERENCE_PROMPT_VERSION = "2.3.0";

// Bounded operator-facing reasons for a correction the frozen candidate
// preflight refused to persist. They never quote provider prose.
const PREFLIGHT_INEFFECTIVE =
  "The correction did not resolve its deterministic blocker, so it was reverted before persistence.";
const PREFLIGHT_INTRODUCED =
  "The correction introduced a new deterministic blocker, so it was reverted before persistence.";
const PREFLIGHT_AMBIGUOUS =
  "A new deterministic blocker could not be attributed to one exact correction, so the candidate was reverted.";

/** Exported for the identity-stability tests; not part of the public surface. */
export function revisionOperationId(input: {
  runId: string;
  documentVersionId: string;
  source:
    | "operator_findings"
    | "deterministic_repair"
    | "coherence_repair"
    | "operator_authorised_repair";
  findingIds: string[];
  provider: string;
  model: string;
  /**
   * Identity of the selected readability target set. An unchanged ineffective
   * selection therefore resolves to the same operation and replays its
   * checkpoint instead of paying for the same edit again, while a genuinely
   * different selection forks a new operation.
   */
  readabilityTargets?: string;
}): string {
  return stableId(
    "revision-operation",
    input.runId,
    input.documentVersionId,
    input.source,
    ...input.findingIds,
    // A no-op has no provider operation or model contract, so it remains
    // configuration-independent. Non-empty operations bind every input that
    // can change planning or provider output while retaining source identity —
    // including the binding identity, because a binding change moves which
    // exact location each accepted finding authorises.
    ...(input.findingIds.length > 0
      ? [
          input.provider,
          input.model,
          REVISION_PROMPT_VERSION,
          REVISION_PLANNING_VERSION,
          REVISION_BINDING_VERSION,
          READABILITY_SELECTOR_VERSION,
          input.readabilityTargets ?? "",
        ]
      : []),
  );
}

/**
 * Configuration and request-validation failures raised before the coherence
 * provider issues its HTTP request. Transport, status, timeout and unparseable
 * outcomes are deliberately excluded: upstream may already have processed a
 * paid request, so those must stay ambiguous and fail closed.
 */
const UNDISPATCHED_COHERENCE_CODES = new Set([
  "COHERENCE_PROVIDER_TOKEN_MISSING",
  "COHERENCE_PROVIDER_MODEL_INVALID",
  "COHERENCE_PROVIDER_MODEL_MISMATCH",
]);

function provablyUndispatchedCoherenceFailure(error: unknown): boolean {
  return error instanceof CoherenceProviderError && UNDISPATCHED_COHERENCE_CODES.has(error.code);
}

function coherenceEligibilityReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (/disallowed field/i.test(message)) return "disallowed_field";
  if (/exactly one precise locator/i.test(message)) return "ambiguous_locator";
  if (/exact field locator/i.test(message)) return "structured_locator";
  if (/outside the current document/i.test(message)) return "outside_document";
  if (/does not intersect an exact persisted changed hunk/i.test(message))
    return "changed_hunk_mismatch";
  return undefined;
}

function coherenceEligibilityDiagnostics(
  request: import("../../shared/milestone-four.js").CoherenceRequest,
  response: import("../../shared/milestone-four.js").CoherenceResponse,
) {
  const markdownFields = new Set(["body_markdown", "markdown"]);
  return response.findings.map((finding, index) => {
    const location = finding.location;
    const isMarkdown = markdownFields.has(location.field);
    const sameFieldAudits = request.revision_audits.filter(
      (audit) => audit.changed && audit.location.field === location.field,
    );
    const lineStart = location.line_start ?? null;
    const lineEnd = location.line_end ?? location.line_start ?? null;
    const intersectingHunks =
      isMarkdown && lineStart !== null && lineEnd !== null
        ? sameFieldAudits.flatMap((audit) =>
            audit.hunks.filter(
              (hunk) => hunk.proposed_start <= lineEnd && hunk.proposed_end >= lineStart,
            ),
          ).length
        : 0;
    const exactStructuredAudits = isMarkdown
      ? 0
      : sameFieldAudits.filter(
          (audit) => JSON.stringify(audit.location) === JSON.stringify(location),
        ).length;
    return {
      index,
      stable_key: finding.stable_key,
      severity: finding.severity,
      rule_reference: finding.rule_reference,
      field: location.field,
      line_start: lineStart,
      line_end: lineEnd,
      has_section: location.section !== undefined,
      changed_audit_count: sameFieldAudits.length,
      intersecting_hunk_count: intersectingHunks,
      exact_structured_audit_count: exactStructuredAudits,
    };
  });
}

function finaliseFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/coherence provider outcome is ambiguous/i.test(message)) return "coherence_ambiguous";
  if (/coherence.*ambiguous|checkpoint/i.test(message)) return "coherence_checkpoint";
  if (/disallowed field|precise locator|outside the exact revision|blocker.*eligib/i.test(message))
    return "coherence_eligibility";
  if (/immutable coherence operation conflict/i.test(message)) return "coherence_identity";
  if (/coherence/i.test(message)) return "coherence_contract";
  if (/invalid input|validation|zod/i.test(message)) return "schema_validation";
  if (/deterministic|blocker gate/i.test(message)) return "deterministic_gate";
  if (/reference/i.test(message)) return "reference_integrity";
  if (/template/i.test(message)) return "template_integrity";
  if (/legacy draft image/i.test(message)) return "legacy_document";
  if (/google is not connected|google connection has expired|google did not grant/i.test(message))
    return "google_connection";
  if (/export idempotency conflict/i.test(message)) return "idempotency_conflict";
  // Google accepted the batch; only the structural verification of what came
  // back failed. Never classified as google_api, so the operator is not sent to
  // reconnect a connection that is working.
  if (/google docs export structure mismatch/i.test(message)) return "google_structure";
  if (/google docs export failed/i.test(message)) return "google_api";
  if (/export/i.test(message)) return "export";
  return "internal_preflight";
}

const safeFinaliseReasons = new Set([
  "missing_completion_marker_recoverable",
  "unsupported_document_structure",
  "completion_marker_mismatch",
  "canonical_operations_mismatch",
  "reserved_document_not_exact_prefix",
  "reserved_metadata_mismatch",
  "reserved_document_changed",
  "marker_recovery_verification_failed",
  "suffix_recovery_verification_failed",
  "reserved_document_conflict",
]);

function finaliseSafeReason(error: unknown): string | undefined {
  const reason =
    error instanceof Error ? (error as Error & { reason?: unknown }).reason : undefined;
  return typeof reason === "string" && safeFinaliseReasons.has(reason) ? reason : undefined;
}

function finaliseSafeFailure(stage: string, error: unknown): string {
  const category = finaliseFailureCategory(error);
  const reason =
    stage === "coherence_eligibility"
      ? coherenceEligibilityReason(error)
      : finaliseSafeReason(error);
  return [
    "STEP_1_12_FAILED",
    `stage=${stage}`,
    `category=${category}`,
    ...(reason ? [`reason=${reason}`] : []),
  ]
    .join(";")
    .slice(0, 160);
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown failure";
  // Provider errors are already redacted typed messages (never secrets), so
  // their safe prefixes are surfaced verbatim for operator diagnosis.
  const known = [
    "Revision removed the handoff primary keyword intent",
    "Revision introduced, removed or altered an unsupported factual claim",
    "Revision altered",
    "Duplicate accepted finding",
    "Coherence orchestration guard exceeded",
    "Revision provider outcome is ambiguous",
    "Revision provider",
    "Coherence provider",
    "Review provider",
    "Draft provider",
    "Step output belongs to another producing attempt",
  ].find((value) => message.includes(value));
  return (known ? message : "Pipeline operation failed safely").slice(0, 160);
}

export type MilestoneFourFailureBoundary =
  | "after_revision_provider_return"
  | "after_revision_provider"
  | "after_revision_persist"
  | "before_rerun_persist"
  | "after_rerun_persist"
  | "after_coherence_reservation"
  | "after_coherence_provider_return"
  | "after_coherence_provider"
  | "after_coherence_persist"
  | "after_export";

export class MilestoneFourOrchestrator {
  constructor(
    private readonly repository: MilestoneFourRepository,
    _fixture: DeterministicFixture,
    private readonly revisions: RevisionProvider,
    private readonly coherence: CoherenceProvider,
    private readonly exports: FinalExportService,
    private readonly failures?: {
      hit(boundary: MilestoneFourFailureBoundary): void | Promise<void>;
    },
  ) {
    // Step 1.11 deliberately ignores the process's current fixture and loads Step 1.4's frozen context.
    void _fixture;
  }

  async run(runId: string, owner = "local-m4-worker"): Promise<void> {
    if (!(await this.repository.stepSucceeded(runId, "findings_review")))
      throw new Error("Step 1.9 must be completed first");
    // At most five passes are possible: the initial pass, two deterministic repairs total,
    // and two coherence returns. Deterministic repair budget is never reset by coherence.
    for (let guard = 0; guard < 5; guard += 1) {
      const detail = await this.repository.getRunDetail(runId);
      if (detail.status === "succeeded" || detail.status === "blocked") return;
      if (
        detail.current_step === "revision_pass" ||
        !(await this.repository.stepSucceeded(runId, "revision_pass"))
      ) {
        await this.revise(runId, owner);
      }
      const rerunOutcome = await this.rerun(runId, owner);
      if (rerunOutcome === "repair") continue;
      if (rerunOutcome === "blocked") return;
      const outcome = await this.finalise(runId, owner);
      if (outcome !== "revise") return;
    }
    throw new Error("Coherence orchestration guard exceeded");
  }

  private async context(runId: string) {
    const current = await this.repository.getDraft(runId);
    if (!current) throw new Error("Current immutable document is missing");
    return {
      current,
      handoff: await this.repository.getHandoff(runId),
      links: (await this.repository.getLinks(runId)) ?? [],
    };
  }

  private async revise(runId: string, owner: string): Promise<void> {
    const lease = await this.repository.claimStep(runId, "revision_pass", owner);
    try {
      const snapshots = await this.repository.snapshotReferences(
        runId,
        lease.execution_id,
        lease.token,
      );
      const { current, handoff, links } = await this.context(runId);
      const revisionInput = await this.repository.getRevisionFindings(runId, current.version.id);
      // Rules the checker emits without a line range carry no exact authority,
      // so the planner, the model gate and the envelope would all refuse them.
      // Bind the supported ones to one precise application-owned location
      // before anything downstream reads the accepted set.
      // One frozen exclusion set for binding, block selection, the
      // provider-visible targets, the additional authority and the operation
      // identity. Recomputing it per consumer is what let a rejected paragraph
      // reach the provider even though the envelope refused to persist it.
      const frozenExclusions = revisionBindingExclusions({
        document: current.draft,
        rejectedLocations: revisionInput.rejected_locations,
      });
      const binding = bindRevisionFindingsWithAuthority({
        document: current.draft,
        primaryKeyword: handoff.primary_keyword,
        findings: revisionInput.findings,
        exclusions: frozenExclusions,
      });
      const findings = binding.findings;
      // Planning never reads the operation id, so plan first and let the
      // selected readability target set take part in that identity.
      const requestCore = {
        run_id: runId,
        document_version_id: current.version.id,
        revision: current.version.revision,
        handoff,
        current_document: current.draft,
        internal_links: links,
        accepted_findings: findings,
        revision_source: revisionInput.source,
        reference_snapshots: snapshots,
        prompt: {
          template_id: "mobelaris.revision_pass" as const,
          template_version: REVISION_PROMPT_VERSION,
        },
        model: this.revisions.model,
        temperature: 0,
      };
      const plan = planRevisionRequest(
        { ...requestCore, operation_id: "planning" },
        {
          exclusions: frozenExclusions,
          readabilityBlocksByFinding: binding.readability_blocks,
          // Exceptional execution is bound to the exact ranges the operator
          // authorised; anything else fails closed before provider dispatch.
          ...(revisionInput.authorised_readability
            ? { authorisedReadability: revisionInput.authorised_readability }
            : {}),
        },
      );
      const readabilityTargets = plan
        .filter((item) => item.readability_blocks?.length)
        .map(
          (item) => `${item.finding.id}:${readabilityTargetSetIdentity(item.readability_blocks!)}`,
        )
        .join("|");
      const operationId = revisionOperationId({
        runId,
        documentVersionId: current.version.id,
        source: revisionInput.source,
        findingIds: findings.map((finding) => finding.id),
        provider: this.revisions.provider,
        model: this.revisions.model,
        readabilityTargets,
      });
      if (findings.length === 0) {
        await this.repository.completeRevisionNoop({
          run_id: runId,
          execution_id: lease.execution_id,
          token: lease.token,
          document_version_id: current.version.id,
          operation_id: operationId,
          source: revisionInput.source,
        });
        return;
      }
      const request = { ...requestCore, operation_id: operationId };
      // A readability finding is expanded into one issued block per authorised
      // range. Each synthetic row keeps an exact immutable source location, so
      // the provider only ever sees application-issued ids and bounded source
      // text, and the existing compact contract keeps enforcing exact order.
      const modelFindings = plan
        .filter((item) => item.route === "model")
        .flatMap((item) =>
          item.readability_blocks
            ? item.readability_blocks.map((block) => ({
                ...item.finding,
                id: block.id,
                location: {
                  field: "body_markdown" as const,
                  line_start: block.line_start,
                  line_end: block.line_end,
                },
              }))
            : [item.finding],
        );
      // Every exact block the readability finding owns, so one audit can hold
      // all of its non-contiguous hunks.
      const additionalAuthority = Object.fromEntries(
        plan
          .filter((item) => item.readability_blocks?.length)
          .map((item) => [
            item.finding.id,
            item.readability_blocks!.map(
              (block) => [block.line_start, block.line_end] as readonly [number, number],
            ),
          ]),
      );

      logger.info("revision.plan_reduced", {
        run_id: runId,
        operation_id: operationId,
        planning_version: REVISION_PLANNING_VERSION,
        accepted_count: findings.length,
        deterministic_count: plan.filter((item) => item.route === "deterministic").length,
        model_count: modelFindings.length,
        unable_count: plan.filter((item) => item.route === "unable").length,
      });
      let response = await this.repository.beginRevisionOperation({
        run_id: runId,
        execution_id: lease.execution_id,
        token: lease.token,
        operation_id: operationId,
        document_version_id: current.version.id,
        request,
      });
      if (response) {
        logger.info("provider.replayed", {
          run_id: runId,
          operation_id: operationId,
          provider: this.revisions.provider,
          context: "revision",
          replayed: true,
        });
      }
      if (!response) {
        logger.info("provider.reserved", {
          run_id: runId,
          operation_id: operationId,
          provider: this.revisions.provider,
          context: "revision",
          state: "reserved",
        });
        const failureIdentity = {
          provider: this.revisions.provider,
          model: this.revisions.model,
          prompt_version: request.prompt.template_version,
          planning_version: REVISION_PLANNING_VERSION,
        };
        let modelResponse: Awaited<ReturnType<RevisionProvider["revise"]>> | undefined;
        if (modelFindings.length > 0) {
          const locked = await this.repository.getRevisionFailureLock(runId, failureIdentity);
          if (locked?.failures && locked.failures >= 2) {
            logger.warn("revision.provider_locked_out", {
              run_id: runId,
              operation_id: operationId,
              ...failureIdentity,
              failure_category: locked.category,
              failure_count: locked.failures,
            });
            throw new RevisionProviderError(
              "REVISION_PROVIDER_LOCKED_OUT",
              `Revision provider is locked after 2 failed executions (${locked.category}); use a different provider/model or contract version before resuming`,
              locked.category,
            );
          }
          const modelRequest = { ...request, accepted_findings: modelFindings };
          await this.repository.markRevisionProviderInFlight({
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            operation_id: operationId,
          });
          logger.info("provider.dispatch_started", {
            run_id: runId,
            operation_id: operationId,
            provider: this.revisions.provider,
            context: "revision",
          });
          try {
            const rawResponse = await withHeartbeat(this.repository, lease, () =>
              this.revisions.revise(modelRequest),
            );
            logger.info("provider.returned", {
              run_id: runId,
              operation_id: operationId,
              provider: this.revisions.provider,
              context: "revision",
            });
            await this.failures?.hit("after_revision_provider_return");
            modelResponse = RevisionResponseSchema.parse(rawResponse);
            logger.info("provider.response_validated", {
              run_id: runId,
              operation_id: operationId,
              provider: this.revisions.provider,
              context: "revision",
            });
          } catch (error) {
            logger.warn("provider.dispatch_failed", {
              run_id: runId,
              operation_id: operationId,
              provider: this.revisions.provider,
              context: "revision",
              ...classifyError(error),
            });
            // Once provider_in_flight is durable, an exception cannot prove that the paid
            // request was never dispatched. Preserve the reservation and fail closed so a
            // resume cannot duplicate a request that upstream may already have processed.
            const category: RevisionSafeFailureCategory =
              error instanceof RevisionProviderError ? error.category : "guard_rejected";
            await this.repository.recordRevisionFailure({
              run_id: runId,
              execution_id: lease.execution_id,
              token: lease.token,
              operation_id: operationId,
              identity: failureIdentity,
              category,
            });
            logger.warn("revision.provider_execution_failed", {
              run_id: runId,
              operation_id: operationId,
              ...failureIdentity,
              failure_category: category,
            });
            throw error;
          }
        }
        const merged = mergeRevisionPlan({
          request,
          plan,
          ...(modelResponse
            ? {
                modelDocument: modelResponse.document,
                modelResults: modelResponse.finding_results,
              }
            : {}),
        });
        response = RevisionResponseSchema.parse({
          document: merged.document,
          finding_results: merged.results,
          usage: modelResponse?.usage ?? { input_units: 0, output_units: 0, cost_micros: 0 },
        });
        await this.repository.checkpointRevisionResponse({
          run_id: runId,
          execution_id: lease.execution_id,
          token: lease.token,
          operation_id: operationId,
          response,
        });
        logger.info("provider.checkpointed", {
          run_id: runId,
          operation_id: operationId,
          provider: this.revisions.provider,
          context: "revision",
        });
      }
      await this.failures?.hit("after_revision_provider");
      // Reject any provider attempt to mutate server-owned claims before controlled reconstruction.
      if (JSON.stringify(response.document.claims) !== JSON.stringify(current.draft.claims))
        assertSafeRevision(request, response.document);
      const applied = this.preflightRevision({
        runId,
        current,
        findings,
        results: response.finding_results,
        proposed: response.document,
        rejected_locations: revisionInput.rejected_locations,
        verified_fact_locations: revisionInput.verified_fact_locations,
        additional_authority: additionalAuthority,
        manifest: validateDeterministicManifest(
          (await this.repository.getDeterministicManifest(runId)).manifest,
          { run_id: runId, handoff },
        ),
        operationId,
      });
      const controlledResponse = {
        ...response,
        document: applied.document,
        finding_results: applied.audits.map(({ finding_id, status, reason }) => ({
          finding_id,
          status,
          reason,
        })),
      };
      assertSafeRevision(request, controlledResponse.document);
      await this.repository.saveRevision({
        run_id: runId,
        execution_id: lease.execution_id,
        token: lease.token,
        request,
        response: controlledResponse,
        provider: this.revisions.provider,
        model: this.revisions.model,
        audits: applied.audits,
      });
      logger.info("provider.persistence_completed", {
        run_id: runId,
        operation_id: operationId,
        provider: this.revisions.provider,
        context: "revision",
      });
      await this.failures?.hit("after_revision_persist");
    } catch (error) {
      await this.safeFail(lease.execution_id, lease.token, error);
      if (error instanceof RevisionGuardError)
        logger.warn("revision.guard_rejected", {
          ...error.diagnostics,
          code: error.code,
          retryable: true,
        });
      throw error;
    }
  }

  /**
   * Proves every controlled correction against the frozen Step 1.11 checker
   * before the candidate is allowed to persist.
   *
   * `applyRevisionEnvelope` only proves that an edit stayed inside authorised
   * structure, so an edit could be recorded `applied` while its blocker
   * survived — or while it introduced a new one. This re-applies the same
   * envelope with ineffective and blocker-introducing edits forced to
   * `unable`, so successful independent siblings are preserved and the audits
   * describe exactly the document that persists.
   *
   * It is a pure function of the checkpointed provider response, the immutable
   * source document and the frozen manifest, so a resume replays it without
   * another provider request.
   */
  private preflightRevision(input: {
    runId: string;
    operationId: string;
    manifest: DeterministicManifest;
    current: { draft: StructuredDraft; version: { id: string; content_hash: string } };
    proposed: StructuredDraft;
    findings: RevisionFinding[];
    results: FindingResult[];
    rejected_locations: FindingLocation[];
    verified_fact_locations: FindingLocation[];
    additional_authority: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;
  }): ReturnType<typeof applyRevisionEnvelope> {
    const { manifest } = input;
    const evaluate = (draft: StructuredDraft) => {
      const owned = mapDeterministicInput({
        run_id: input.runId,
        document_version_id: input.current.version.id,
        handoff: manifest.frozen_context.handoff,
        draft,
        persisted_links: manifest.frozen_context.internal_links_artifact.body,
        fixture: manifest.frozen_context.fixture.content as DeterministicFixture,
      });
      return runVersionedDeterministicChecks(
        checkerInputFromManifest(manifest, {
          body_markdown: owned.body_markdown,
          on_page: owned.on_page,
        }),
        { id: input.current.version.id, content_hash: input.current.version.content_hash },
        manifest,
      ).findings;
    };
    const baseline = evaluate(input.current.draft);
    /** How many blocker occurrences of one rule a candidate still carries. */
    const ruleBlockers = (findings: ReturnType<typeof evaluate>, rule: string) =>
      findings.filter((finding) => finding.rule === rule && finding.severity === "blocker").length;

    const force = (reverts: ReadonlyMap<string, string>): FindingResult[] =>
      input.results.map((result) => {
        const reason = reverts.get(result.finding_id);
        return reason && result.status === "applied"
          ? { finding_id: result.finding_id, status: "unable" as const, reason }
          : result;
      });
    const run = (reverts: ReadonlyMap<string, string>) => {
      const envelope = applyRevisionEnvelope({
        current: input.current.draft,
        proposed: input.proposed,
        findings: input.findings,
        results: force(reverts),
        rejected_locations: input.rejected_locations,
        verified_fact_locations: input.verified_fact_locations,
        additional_authority: input.additional_authority,
      });
      const candidate = evaluate(envelope.document);
      return {
        envelope,
        candidate,
        comparison: compareDeterministicResults(baseline, candidate),
      };
    };
    // Attribution trials repeat the same single-revert candidates once per
    // introduced blocker. Memoise so the work stays linear in applied edits
    // and the whole preflight fits comfortably inside the step lease.
    const trials = new Map<string, ReturnType<typeof run>>();
    const runOnce = (reverts: ReadonlyMap<string, string>) => {
      const key = [...reverts.keys()].sort().join("|");
      const cached = trials.get(key);
      if (cached) return cached;
      const computed = run(reverts);
      trials.set(key, computed);
      return computed;
    };

    const none = new Map<string, string>();
    let pass = runOnce(none);
    const appliedIds = (result: typeof pass) =>
      result.envelope.audits
        .filter((audit) => audit.status === "applied")
        .map((audit) => audit.finding_id);
    const reverts = new Map<string, string>();
    const failClosed = (reason: string) => {
      for (const id of appliedIds(pass)) reverts.set(id, reason);
    };

    // A newly introduced blocker must never persist. Attribute it by reverting
    // one applied edit at a time; anything less exact fails closed.
    for (const blocker of pass.comparison.introduced_blockers) {
      const responsible = appliedIds(pass).filter((id) => {
        const trial = runOnce(new Map([[id, PREFLIGHT_INTRODUCED]]));
        return !trial.comparison.introduced_blockers.includes(blocker);
      });
      if (responsible.length === 1) reverts.set(responsible[0]!, PREFLIGHT_INTRODUCED);
      else {
        failClosed(PREFLIGHT_AMBIGUOUS);
        break;
      }
    }

    // An edit may stay `applied` only when its own blocker is provably gone.
    //
    // Occurrence identities are opaque hashes and several accepted findings can
    // share one rule, so resolution is proved counterfactually instead: an edit
    // is effective exactly when reverting it puts one of its rule's blocker
    // occurrences back. Counting occurrences of the edit's own rule makes this
    // per-finding, so two findings sharing a rule are judged independently, and
    // an edit that only appears to help because a sibling did the work restores
    // nothing and is reverted. Sharing a rule can therefore never leave an
    // ineffective edit credited.
    // Snapshot the attribution reverts so every counterfactual is measured
    // against one consistent base candidate rather than a shifting one.
    const baseReverts = new Map(reverts);
    const basePass = runOnce(baseReverts);
    for (const audit of basePass.envelope.audits) {
      if (audit.status !== "applied" || baseReverts.has(audit.finding_id)) continue;
      const finding = input.findings.find((item) => item.id === audit.finding_id);
      if (!finding || finding.severity !== "blocker") continue;
      const rule = finding.rule_reference;
      // Only rules the frozen checker actually blocks on can be proved this
      // way. A finding may carry `blocker` for a rule the checker emits as a
      // warning; there is no deterministic blocker to resolve, so demanding
      // proof would revert a perfectly good edit.
      if (ruleBlockers(baseline, rule) === 0) continue;
      const withEdit = ruleBlockers(basePass.candidate, rule);
      const withoutEdit = ruleBlockers(
        runOnce(new Map([...baseReverts, [audit.finding_id, PREFLIGHT_INEFFECTIVE]])).candidate,
        rule,
      );
      if (withoutEdit <= withEdit) reverts.set(audit.finding_id, PREFLIGHT_INEFFECTIVE);
    }

    if (reverts.size > 0) {
      pass = runOnce(reverts);
      // Reverting can only remove authorised hunks, but recheck rather than
      // assume: a candidate that still introduces a blocker reverts entirely.
      if (pass.comparison.introduced_blockers.length > 0) {
        failClosed(PREFLIGHT_AMBIGUOUS);
        pass = runOnce(reverts);
      }
    }
    logger.info("revision.preflight_completed", {
      run_id: input.runId,
      operation_id: input.operationId,
      planning_version: REVISION_PLANNING_VERSION,
      binding_version: REVISION_BINDING_VERSION,
      applied_count: appliedIds(pass).length,
      reverted_count: reverts.size,
      retained_blockers: pass.comparison.retained_blockers.length,
      introduced_blockers: pass.comparison.introduced_blockers.length,
    });
    return pass.envelope;
  }

  private async rerun(runId: string, owner: string): Promise<"continue" | "repair" | "blocked"> {
    const detail = await this.repository.getRunDetail(runId);
    if (detail.current_step === "final_coherence_export") return "continue";
    const lease = await this.repository.claimStep(runId, "automated_checks_rerun", owner);
    try {
      const { current, handoff } = await this.context(runId);
      const baseline = await this.repository.getDeterministicManifest(runId);
      const manifest = validateDeterministicManifest(baseline.manifest, {
        run_id: runId,
        handoff,
      });
      const baselineResult = validateDeterministicBaseline(manifest, baseline.result);
      const currentOwned = mapDeterministicInput({
        run_id: runId,
        document_version_id: current.version.id,
        handoff: manifest.frozen_context.handoff,
        draft: current.draft,
        persisted_links: manifest.frozen_context.internal_links_artifact.body,
        fixture: manifest.frozen_context.fixture.content,
      });
      const checkerInput = checkerInputFromManifest(manifest, {
        body_markdown: currentOwned.body_markdown,
        on_page: currentOwned.on_page,
      });
      const bare = runVersionedDeterministicChecks(
        checkerInput,
        { id: current.version.id, content_hash: current.version.content_hash },
        manifest,
      );
      const comparison = compareDeterministicResults(baselineResult.findings, bare.findings);
      const { result_hash: _, ...bareCore } = bare;
      const result = {
        ...bareCore,
        comparison,
        result_hash: deterministicHash({ ...bareCore, comparison }),
      };
      const findings = result.findings.map((finding) =>
        ReviewFindingSchema.parse({
          stable_key: `rerun:${finding.id}`,
          category: "deterministic",
          rule_reference: finding.rule,
          severity: finding.severity,
          location: finding.location,
          issue: finding.issue,
          suggested_fix: finding.suggested_fix,
        }),
      );
      await this.failures?.hit("before_rerun_persist");
      const outcome = await this.repository.saveRerun({
        run_id: runId,
        document_version_id: current.version.id,
        execution_id: lease.execution_id,
        token: lease.token,
        result,
        findings,
      });
      await this.failures?.hit("after_rerun_persist");
      return outcome;
    } catch (error) {
      await this.safeFail(lease.execution_id, lease.token, error);
      throw error;
    }
  }

  private async finalise(runId: string, owner: string): Promise<"revise" | "blocked" | "export"> {
    const lease = await this.repository.claimStep(runId, "final_coherence_export", owner);
    let stage = "reference_snapshot";
    let coherenceRequest: import("../../shared/milestone-four.js").CoherenceRequest | undefined;
    let coherenceResponse: import("../../shared/milestone-four.js").CoherenceResponse | undefined;
    try {
      const snapshots = await this.repository.snapshotReferences(
        runId,
        lease.execution_id,
        lease.token,
      );
      stage = "run_context";
      const { current, handoff } = await this.context(runId);
      if (current.legacy_derived_fields?.includes("images"))
        throw new Error(
          "Legacy draft image placement is unavailable; operator revision is required",
        );
      stage = "deterministic_gate";
      const deterministicGate = await this.repository.getDeterministicGate(
        runId,
        current.version.id,
      );
      const revisionContext = await this.repository.getCoherenceRevisionContext(
        runId,
        current.version.id,
      );
      const requestCore = {
        run_id: runId,
        parent_document_version_id: revisionContext.parent_document_version_id,
        document_version_id: current.version.id,
        revision_reason: revisionContext.revision_reason,
        coherence_cycle: revisionContext.coherence_cycle,
        handoff,
        parent_document: revisionContext.parent_document,
        current_document: current.draft,
        revision_audits: revisionContext.revision_audits,
        deterministic_result_hash: deterministicGate.result_hash,
        reference_snapshots: snapshots,
        prompt: {
          template_id: "mobelaris.final_coherence" as const,
          template_version: COHERENCE_PROMPT_VERSION,
        },
        model: this.coherence.model,
        temperature: 0,
      };
      const coherenceOperationId = stableId(
        "coherence-operation",
        runId,
        current.version.id,
        canonicalHash(requestCore),
      );
      const request = { operation_id: coherenceOperationId, ...requestCore };
      coherenceRequest = request;
      if (!deterministicGate.exact_document_match)
        throw new Error("Step 1.11 result does not match the exact current document");
      if (deterministicGate.introduced_blockers > 0 || deterministicGate.retained_blockers > 0) {
        await this.repository.blockFinalForDeterministic(
          runId,
          current.version.id,
          lease.execution_id,
          lease.token,
        );
        return "blocked";
      }
      stage = "coherence_recovery";
      const persisted = await this.repository.recoverCoherence(
        runId,
        current.version.id,
        request.operation_id,
        lease.execution_id,
        lease.token,
      );
      let outcome: "revise" | "blocked" | "export";
      if (persisted) outcome = persisted.gate.outcome;
      else {
        stage = "coherence_operation";
        let response = await this.repository.beginCoherenceOperation({
          run_id: runId,
          execution_id: lease.execution_id,
          token: lease.token,
          operation_id: request.operation_id,
          document_version_id: current.version.id,
          request,
        });
        if (response) {
          logger.info("provider.replayed", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
            replayed: true,
          });
        }
        if (!response) {
          logger.info("provider.reserved", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
            state: "reserved",
          });
          // Durably reserve the single paid call before dispatch. Once this
          // commits, an exception can no longer prove the request was never
          // sent, so a resume fails closed instead of paying twice.
          stage = "coherence_provider_reservation";
          await this.repository.markCoherenceProviderInFlight({
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            operation_id: request.operation_id,
          });
          logger.info("provider.dispatch_started", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
          });
          await this.failures?.hit("after_coherence_reservation");
          stage = "coherence_provider";
          let rawCoherence: Awaited<ReturnType<CoherenceProvider["review"]>>;
          try {
            rawCoherence = await withHeartbeat(this.repository, lease, () =>
              this.coherence.review(request),
            );
          } catch (error) {
            logger.warn("provider.dispatch_failed", {
              run_id: runId,
              operation_id: request.operation_id,
              provider: this.coherence.provider,
              context: "coherence",
              ...classifyError(error),
            });
            // Only a provider error that proves nothing was dispatched may
            // release the reservation; anything else stays ambiguous.
            if (provablyUndispatchedCoherenceFailure(error))
              await this.repository.releaseCoherenceProviderFailure({
                run_id: runId,
                execution_id: lease.execution_id,
                token: lease.token,
                operation_id: request.operation_id,
              });
            throw error;
          }
          logger.info("provider.returned", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
          });
          await this.failures?.hit("after_coherence_provider_return");
          stage = "coherence_response_validation";
          response = CoherenceResponseSchema.parse(rawCoherence);
          logger.info("provider.response_validated", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
          });
          stage = "coherence_checkpoint";
          await this.repository.checkpointCoherenceResponse({
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            operation_id: request.operation_id,
            response,
          });
          logger.info("provider.checkpointed", {
            run_id: runId,
            operation_id: request.operation_id,
            provider: this.coherence.provider,
            context: "coherence",
          });
        }
        // Validate both fresh provider output and a response recovered from an immutable checkpoint.
        stage = "coherence_eligibility";
        coherenceResponse = response;
        assertCoherenceBlockerEligibility(request, response);
        await this.failures?.hit("after_coherence_provider");
        stage = "coherence_persistence";
        outcome = await this.repository.saveCoherence({
          run_id: runId,
          document_version_id: current.version.id,
          execution_id: lease.execution_id,
          token: lease.token,
          request,
          response,
          provider: this.coherence.provider,
          model: this.coherence.model,
        });
        logger.info("provider.persistence_completed", {
          run_id: runId,
          operation_id: request.operation_id,
          provider: this.coherence.provider,
          context: "coherence",
        });
        await this.failures?.hit("after_coherence_persist");
      }
      if (outcome !== "export") return outcome;
      stage = "export_context";
      const [claims, rejected, links, runs, templates] = await Promise.all([
        this.repository.getExportClaims(runId, current.version.id),
        this.repository.getRejectedFindings(runId, current.version.id),
        this.repository.getLinks(runId).then((rows) => rows ?? []),
        this.repository.listRuns(100),
        this.repository.getContentTemplates(),
      ]);
      const renderInput = {
        plane_ticket: handoff.plane_ticket,
        draft: current.draft,
        primary_keyword: handoff.primary_keyword,
        related_keywords: handoff.related_keywords,
        page_type: handoff.page_type,
        locales_for_translation: handoff.locales_for_translation,
        export_date: runs.find((run) => run.run_id === runId)?.created_at.slice(0, 10),
        // Project to the export contract's three fields. Persisted links carry
        // Step 1.2 verification, ranking and provenance metadata (populated by
        // live discovery, absent from mock runs), none of which the rendered
        // document uses. ExportLinkSchema is deliberately strict so that
        // discovery metadata cannot leak into the immutable, hash-bound export
        // manifest — so narrow here rather than widening that guard.
        internal_links: links.map((link) => ({
          url: link.url,
          title: link.title,
          relevance: link.relevance,
        })),
        claims,
        rejected_findings: rejected,
        ...templates,
      };
      stage = "export_render";
      const frozenRenderInput = (
        await import("../../shared/export.js")
      ).ExportRenderInputSchema.parse(renderInput);
      const rendered = renderExport(frozenRenderInput);
      // The export service persists an immutable frozen manifest binding these exact inputs,
      // Step 1.11/coherence identities and deterministic structured render hashes.
      stage = "google_docs_export";
      await withHeartbeat(this.repository, lease, () =>
        this.exports.export({
          run_id: runId,
          step_execution_id: lease.execution_id,
          fencing_token: lease.token,
          document_version_id: current.version.id,
          idempotency_key: stableId("export", runId, current.version.id),
          render_input: frozenRenderInput,
          rendered,
        }),
      );
      await this.failures?.hit("after_export");
      await this.repository.completeFinal(
        runId,
        current.version.id,
        lease.execution_id,
        lease.token,
      );
      return "export";
    } catch (error) {
      logger.warn("final_coherence_export.failed", {
        run_id: runId,
        stage,
        category: finaliseFailureCategory(error),
        ...(stage === "coherence_eligibility"
          ? {
              reason: coherenceEligibilityReason(error) ?? "unknown_eligibility",
              ...(coherenceRequest && coherenceResponse
                ? {
                    document_line_count:
                      coherenceRequest.current_document.markdown.split("\n").length,
                    changed_audit_count: coherenceRequest.revision_audits.filter(
                      (audit) => audit.changed,
                    ).length,
                    finding_count: coherenceResponse.findings.length,
                    findings: coherenceEligibilityDiagnostics(coherenceRequest, coherenceResponse),
                  }
                : {}),
            }
          : {}),
      });
      await this.safeFail(
        lease.execution_id,
        lease.token,
        error,
        finaliseSafeFailure(stage, error),
      );
      throw error;
    }
  }

  private async safeFail(
    executionId: string,
    token: string,
    error: unknown,
    safeMessage?: string,
  ): Promise<void> {
    try {
      await this.repository.failStep(executionId, token, safeMessage ?? safeFailure(error));
    } catch {
      /* atomic completion may already have released the fence */
    }
  }
}

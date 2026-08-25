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
  REVISION_PLANNING_VERSION,
  mergeRevisionPlan,
  planRevisionRequest,
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
import { RevisionProviderError } from "../providers/chat-completion-revision-provider.js";
import type { CoherenceProvider, RevisionProvider } from "../providers/milestone-four-providers.js";
import { logger } from "../logger.js";
import { withHeartbeat } from "./lease-heartbeat.js";

// Version 2.2.0 starts a new immutable provider operation after the Step 1.8
// occurrence-scoped contract change. Earlier provider_in_flight reservations
// remain preserved and are never retried or overwritten.
const REVISION_PROMPT_VERSION = "2.2.0";
const COHERENCE_PROMPT_VERSION = "2.3.0";

function revisionOperationId(input: {
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
}): string {
  return stableId(
    "revision-operation",
    input.runId,
    input.documentVersionId,
    input.source,
    ...input.findingIds,
    // A no-op has no provider operation or model contract, so it remains
    // configuration-independent. Non-empty operations bind every input that
    // can change planning or provider output while retaining source identity.
    ...(input.findingIds.length > 0
      ? [input.provider, input.model, REVISION_PROMPT_VERSION, REVISION_PLANNING_VERSION]
      : []),
  );
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
  | "after_rerun_persist"
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
      const findings = revisionInput.findings;
      const operationId = revisionOperationId({
        runId,
        documentVersionId: current.version.id,
        source: revisionInput.source,
        findingIds: findings.map((finding) => finding.id),
        provider: this.revisions.provider,
        model: this.revisions.model,
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
      const request = {
        operation_id: operationId,
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
      const plan = planRevisionRequest(request);
      const modelFindings = plan
        .filter((item) => item.route === "model")
        .map((item) => item.finding);
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
      if (!response) {
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
          try {
            const rawResponse = await withHeartbeat(this.repository, lease, () =>
              this.revisions.revise(modelRequest),
            );
            await this.failures?.hit("after_revision_provider_return");
            modelResponse = RevisionResponseSchema.parse(rawResponse);
          } catch (error) {
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
      }
      await this.failures?.hit("after_revision_provider");
      // Reject any provider attempt to mutate server-owned claims before controlled reconstruction.
      if (JSON.stringify(response.document.claims) !== JSON.stringify(current.draft.claims))
        assertSafeRevision(request, response.document);
      const applied = applyRevisionEnvelope({
        current: current.draft,
        proposed: response.document,
        findings,
        results: response.finding_results,
        rejected_locations: revisionInput.rejected_locations,
        verified_fact_locations: revisionInput.verified_fact_locations,
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
        if (!response) {
          stage = "coherence_provider";
          const rawCoherence = await withHeartbeat(this.repository, lease, () =>
            this.coherence.review(request),
          );
          stage = "coherence_response_validation";
          response = CoherenceResponseSchema.parse(rawCoherence);
          stage = "coherence_checkpoint";
          await this.repository.checkpointCoherenceResponse({
            run_id: runId,
            execution_id: lease.execution_id,
            token: lease.token,
            operation_id: request.operation_id,
            response,
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

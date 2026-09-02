import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { RunDetail as RunDetailData } from "../../../shared/contracts/run-detail.js";
import { PIPELINE_STEPS, type PipelineStepId } from "../../../shared/pipeline.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { GoogleDocsConnection } from "./GoogleDocsConnection.js";
import { friendlyFailure } from "./failure-copy.js";

/**
 * Re-renders every second while `active`, purely so an elapsed-time string
 * computed from `Date.now()` at render time stays live — the value itself is
 * derived fresh each render, this only supplies the tick.
 */
function useClockTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);
}

/** "Running for" display next to a step that is mid a real, synchronous provider call. */
function formatElapsed(sinceIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes < 1 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type RunAction = "resume" | "export" | "cancel" | "exceptional-correction" | null;

/**
 * The running/terminal surface for one article: the twelve-step rail, the
 * current immutable document, run context (cost, counts) and export link.
 * Shared by every Blog Post state that shows pipeline progress.
 */
export function RunWorkspace({
  detail,
  action,
  onAction,
  onReviewFindings,
}: {
  detail: RunDetailData;
  action: RunAction;
  onAction: (action: Exclude<RunAction, null>) => void;
  /** Present only while status is "waiting" — surfaces a way into the findings decision screen. */
  onReviewFindings?: () => void;
}) {
  const attempts = useMemo(() => {
    const grouped = new Map<PipelineStepId, RunDetailData["steps"]>();
    for (const attempt of detail.steps)
      grouped.set(attempt.step, [...(grouped.get(attempt.step) ?? []), attempt]);
    return grouped;
  }, [detail.steps]);
  const completed = PIPELINE_STEPS.filter(
    (step) => attempts.get(step.id)?.at(-1)?.status === "succeeded",
  ).length;
  const currentStepName = detail.current_step
    ? (PIPELINE_STEPS.find((step) => step.id === detail.current_step)?.name ?? null)
    : null;
  const current = detail.current_document;
  const isRunning = detail.status === "running";
  // A resume in flight is a real run in progress: show the live running
  // surface (spinner + elapsed time) instead of the stale failure state.
  const resuming = action === "resume";
  useClockTick(isRunning || resuming);
  const currentStepMeta = detail.current_step
    ? PIPELINE_STEPS.find((step) => step.id === detail.current_step)
    : undefined;
  const latestCurrentAttempt = detail.current_step
    ? attempts.get(detail.current_step)?.at(-1)
    : undefined;
  // Derived from the run's own persisted state, not a one-off click — so it
  // stays visible across a page reload for as long as the step is genuinely
  // stuck, not just for the moment right after a failed "Resume safely" click.
  // Cross-checked against the step's own recorded status (not just the run's
  // top-level status) so a stale/inconsistent snapshot can never show this.
  const failingAttempt =
    detail.status === "retryable_failed" &&
    !resuming &&
    latestCurrentAttempt?.status === "retryable_failed"
      ? latestCurrentAttempt
      : undefined;
  const failure =
    failingAttempt && detail.current_step
      ? friendlyFailure(
          detail.current_step,
          detail.draft_recovery === "legacy_confirmation_required"
            ? "A pre-checkpoint draft failure requires explicit operator authorisation"
            : failingAttempt.error,
          failingAttempt.attempt,
        )
      : undefined;
  const [exceptionalConfirmed, setExceptionalConfirmed] = useState(false);
  const blockedSectionRef = useRef<HTMLElement>(null);
  const lastPresentedBlockRef = useRef<string | null>(null);
  const blockPresentationKey = detail.blocked_for_operator
    ? `${detail.current_document?.version.id ?? "missing"}:${detail.block_reason}:${detail.block_counts.deterministic_blockers}:${detail.block_counts.coherence_blockers}`
    : null;
  useEffect(() => {
    if (!blockPresentationKey || lastPresentedBlockRef.current === blockPresentationKey) return;
    lastPresentedBlockRef.current = blockPresentationKey;
    blockedSectionRef.current?.focus({ preventScroll: true });
    blockedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [blockPresentationKey]);
  const deterministicBlockerCount = detail.block_counts.deterministic_blockers;
  const blockerNoun = deterministicBlockerCount === 1 ? "item" : "items";
  const rerunCompletedWithBlockers =
    detail.status === "blocked" &&
    detail.current_step === "automated_checks_rerun" &&
    detail.block_reason === "deterministic_blockers" &&
    deterministicBlockerCount > 0 &&
    latestCurrentAttempt?.status === "succeeded";
  const blockGuidance =
    detail.block_reason === "deterministic_blockers"
      ? `The article was checked again, but ${deterministicBlockerCount} ${blockerNoun} still ${deterministicBlockerCount === 1 ? "needs" : "need"} fixing. The app stopped safely before the final check, and no Google Doc was created.`
      : detail.block_reason === "coherence_cycle_cap"
        ? `The final check still found ${detail.block_counts.coherence_blockers} ${detail.block_counts.coherence_blockers === 1 ? "issue" : "issues"} after two correction attempts. The app stopped safely so you can review them before continuing.`
        : "The app stopped safely, but the saved history does not explain why. Ask the technical owner to review the run before continuing.";

  return (
    <div className="mt-8 min-w-0 max-w-full">
      {detail.blocked_for_operator && (
        <section
          ref={blockedSectionRef}
          tabIndex={-1}
          aria-labelledby="blocked-heading"
          className="mb-8 scroll-mt-20 border-y border-danger/30 bg-danger/5 px-4 py-4 outline-none"
        >
          <h2 id="blocked-heading" className="font-semibold text-danger">
            Operator action required
          </h2>
          <p className="mt-1 text-sm text-ink">{blockGuidance}</p>
          {detail.can_recover_deterministic_block && (
            <div className="mt-4 border-t border-danger/20 pt-3">
              <Button
                type="button"
                variant="outline"
                disabled={action !== null}
                loading={action === "resume"}
                onClick={() => onAction("resume")}
              >
                {action === "resume" ? "Resuming repair…" : "Resume required correction"}
              </Button>
              <p className="mt-2 text-xs text-muted">
                Continues at Step 1.10 using the saved Step 1.11 blockers. Step 1.9 remains frozen.
              </p>
            </div>
          )}
          {detail.block_reason === "deterministic_blockers" &&
            detail.deterministic_blocker_details.length > 0 && (
              <ol className="mt-4 divide-y divide-danger/20 border-t border-danger/20">
                {detail.deterministic_blocker_details.map((blocker, index) => (
                  <li key={`${blocker.rule_reference}:${index}`} className="py-3 text-sm">
                    <p className="font-semibold text-ink">{blocker.issue}</p>
                    <p className="mt-1 font-mono text-xs text-muted">
                      {blocker.rule_reference} · {formatBlockerLocation(blocker.location)}
                    </p>
                    <p className="mt-1 text-ink">
                      <span className="font-medium">Required correction:</span>{" "}
                      {blocker.suggested_fix}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          {detail.exceptional_correction.available && (
            <div className="mt-4 border-t border-danger/20 pt-4">
              <h3 className="font-semibold text-ink">What to do next</h3>
              <ol className="mt-2 max-w-[70ch] list-decimal space-y-1 pl-5 text-sm text-ink">
                <li>Review the {blockerNoun} listed above.</li>
                <li>Tick the confirmation box below.</li>
                <li>
                  Select “Fix {deterministicBlockerCount === 1 ? "this item" : "these items"} and
                  continue”. The app will check the article again afterwards.
                </li>
              </ol>
              <label className="mt-4 flex max-w-[70ch] items-start gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-action"
                  checked={exceptionalConfirmed}
                  onChange={(event) => setExceptionalConfirmed(event.target.checked)}
                />
                <span>
                  {detail.exceptional_correction.requires_ai === false
                    ? `I understand the app will fix only the ${blockerNoun} listed above and then check the article again.`
                    : `I understand this may use a small amount of AI credit to fix only the ${blockerNoun} listed above.`}
                </span>
              </label>
              <Button
                type="button"
                className="mt-3"
                disabled={!exceptionalConfirmed || action !== null}
                loading={action === "exceptional-correction"}
                onClick={() => onAction("exceptional-correction")}
              >
                {action === "exceptional-correction"
                  ? "Fixing and checking again…"
                  : `Fix ${deterministicBlockerCount === 1 ? "this item" : "these items"} and continue`}
              </Button>
              <p className="mt-2 max-w-[70ch] text-xs text-muted">
                {detail.exceptional_correction.requires_ai === false
                  ? "The app expects to make these fixes without an AI request."
                  : detail.exceptional_correction.requires_ai === true
                    ? "The app may make one AI request to complete these fixes."
                    : "The app will first determine whether one AI request is needed."}{" "}
                Your earlier review choices will not change. This option can only be used once.
              </p>
            </div>
          )}
        </section>
      )}

      {failingAttempt && currentStepMeta && failure && (
        <section
          aria-labelledby="retry-heading"
          className="mb-8 border-y border-danger/30 bg-danger/5 px-4 py-4"
        >
          <p className="font-mono text-[10px] font-semibold tracking-[0.08em] text-danger uppercase">
            Step {currentStepMeta.number} · {currentStepMeta.name}
          </p>
          <h2 id="retry-heading" className="mt-1 font-semibold text-danger">
            {failure.title}
          </h2>
          <p className="mt-2 text-sm text-ink">{failure.explanation}</p>
          <p className="mt-1 text-sm font-medium text-ink">{failure.protection}</p>
          <p className="mt-3 text-sm text-ink">{failure.action}</p>
          <div className="mt-3 border-t border-danger/20 pt-3 text-xs text-muted">
            <p>
              This step has been tried {failingAttempt.attempt}{" "}
              {failingAttempt.attempt === 1 ? "time" : "times"}.
            </p>
            {failure.latestTry ? <p className="mt-1">{failure.latestTry}</p> : null}
            <p className="mt-1">
              “Resume safely” continues from this step. It does not restart the pipeline or repeat
              completed work.
            </p>
          </div>
        </section>
      )}

      {detail.status === "running" &&
        detail.current_step === "revision_pass" &&
        detail.deterministic_repair_cycles > 0 && (
          <p role="status" className="mb-4 text-sm font-semibold text-info">
            Automatically correcting required checks — cycle {detail.deterministic_repair_cycles} of
            2
          </p>
        )}

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
        <MetadataItem value={formatCost(detail.usage.cost_micros)} label="cost" />
        <MetadataItem value={`${qualitySafetyPercent(detail.counts)}%`} label="quality score" />
        <MetadataItem value={`${detail.coherence_return_cycles} of 2`} label="revision cycles" />
      </div>

      <PipelineStrip
        attempts={attempts}
        currentStepId={detail.current_step}
        completed={completed}
        status={detail.status}
        currentStepName={currentStepName}
      />

      <div className="grid min-w-0 max-w-full items-start gap-8 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_320px]">
        <nav aria-label="Twelve-step pipeline" className="min-w-0 max-w-full xl:sticky xl:top-20">
          <div className="mb-3 flex items-center justify-between border-b border-rule pb-2">
            <h2 className="text-sm font-semibold">Pipeline</h2>
            <span className="font-mono text-xs tabular-nums text-muted">
              {completed}/12 complete
            </span>
          </div>
          <ol className="relative border-t border-rule">
            {PIPELINE_STEPS.map((step) => {
              const stepAttempts = attempts.get(step.id) ?? [];
              const latest = stepAttempts.at(-1);
              const status = latest?.status ?? "queued";
              const isCurrentRow = step.id === detail.current_step;
              const completedWithBlockers =
                step.id === "automated_checks_rerun" && isCurrentRow && rerunCompletedWithBlockers;
              const canReviewFindings =
                step.id === "findings_review" &&
                detail.status === "waiting" &&
                Boolean(onReviewFindings);
              const rowContent = (
                <>
                  <span aria-hidden="true" className="font-mono text-xs text-muted">
                    {step.number}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-5">{step.name}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={status} />
                      <span className="text-xs tabular-nums text-muted">
                        {stepAttempts.length || 0}{" "}
                        {stepAttempts.length === 1 ? "attempt" : "attempts"}
                      </span>
                      {isCurrentRow && status === "running" && !resuming && (
                        <span className="text-xs font-semibold tabular-nums text-info">
                          Running for {formatElapsed(detail.updated_at)}
                        </span>
                      )}
                    </div>
                    {latest?.error && !resuming ? (
                      <p className="mt-1 text-xs text-danger">
                        {friendlyFailure(step.id, latest.error, latest.attempt).title}
                      </p>
                    ) : status === "blocked" && !resuming ? (
                      <p className="mt-1 text-xs text-danger">
                        Blocked — needs your review before this can continue.
                      </p>
                    ) : completedWithBlockers ? (
                      <p className="mt-1 text-xs text-danger">
                        Checks completed successfully; {deterministicBlockerCount} required{" "}
                        {blockerNoun} still {deterministicBlockerCount === 1 ? "blocks" : "block"}{" "}
                        the article.
                      </p>
                    ) : null}
                  </div>
                </>
              );
              return (
                <li
                  key={step.id}
                  className={`border-b border-l-2 border-b-rule pl-2 ${
                    isCurrentRow ? "border-l-action bg-subtle/60" : "border-l-transparent"
                  }`}
                >
                  {canReviewFindings ? (
                    <button
                      type="button"
                      onClick={onReviewFindings}
                      className="grid w-full min-w-0 grid-cols-[28px_minmax(0,1fr)] gap-2 py-3 text-left hover:bg-subtle"
                    >
                      {rowContent}
                    </button>
                  ) : (
                    <div className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] gap-2 py-3">
                      {rowContent}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <article aria-labelledby="document-heading" className="min-w-0">
          <h2 id="document-heading" className="sr-only">
            Current document
          </h2>
          {current ? (
            <div className="min-w-0 max-w-full rounded-group border border-rule bg-paper px-5 py-7 sm:px-8">
              <div className="flex items-center justify-between">
                <span
                  aria-hidden="true"
                  className="font-mono text-[10px] font-semibold tracking-[0.08em] text-muted uppercase"
                >
                  Current document
                </span>
                <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">
                  Draft {String(current.version.revision).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-4 [overflow-wrap:anywhere] font-serif text-h1 font-semibold">
                {current.draft.title}
              </h3>
              <p className="mt-2 [overflow-wrap:anywhere] font-mono text-xs text-action">
                /{current.draft.slug}
              </p>
              <p className="mt-5 [overflow-wrap:anywhere] border-y border-rule py-4 font-serif text-standfirst italic text-muted">
                {current.draft.meta_description}
              </p>
              <div className="mt-4 min-w-0 space-y-1 [overflow-wrap:anywhere] text-xs text-muted">
                {current.legacy_derived_fields?.length ? (
                  <p className="rounded-control border border-warning/50 bg-warning/10 px-3 py-2 text-ink">
                    Legacy draft version: OG and on-page details below were not stored for this
                    revision and are placeholders only.
                  </p>
                ) : null}
                <p>
                  <span className="font-medium text-ink">Open Graph:</span> {current.draft.og_title}{" "}
                  — {current.draft.og_description}
                </p>
                <p>
                  {current.draft.images.length}{" "}
                  {current.draft.images.length === 1 ? "image" : "images"} ·{" "}
                  {current.draft.faqs.length}{" "}
                  {current.draft.faqs.length === 1 ? "question" : "questions"} in the FAQ
                </p>
              </div>
              <div className="mt-6 max-w-[72ch]">
                {renderMarkdownBlocks(current.draft.markdown)}
              </div>
            </div>
          ) : isRunning || resuming ? (
            <div className="flex flex-col items-center gap-3 border-y border-rule py-14 text-center">
              <Spinner className="size-8 text-info" />
              <p className="text-sm font-medium text-ink">
                {resuming
                  ? "Resuming the pipeline…"
                  : `${currentStepName ?? "The pipeline"} is running…`}
              </p>
              <p className="text-xs tabular-nums text-info">
                Running for {formatElapsed(detail.updated_at)}
              </p>
            </div>
          ) : (
            <p className="border-y border-rule py-10 text-center text-sm text-muted">
              No document version has been created for this blog post.
            </p>
          )}
        </article>

        <aside
          aria-label="Run context"
          className="min-w-0 max-w-full border border-rule bg-paper md:col-span-2 xl:sticky xl:top-20 xl:col-span-1"
        >
          <ContextSection title="Article status">
            <DefinitionRow label="State">
              <StatusBadge status={detail.status} />
            </DefinitionRow>
            <DefinitionRow
              label={rerunCompletedWithBlockers ? "Blocked after" : "Current step"}
              value={
                detail.current_step
                  ? (() => {
                      const step = PIPELINE_STEPS.find((item) => item.id === detail.current_step);
                      return step ? `${step.number} · ${step.name}` : detail.current_step;
                    })()
                  : "None"
              }
            />
            <DefinitionRow
              label="Revision cycles"
              value={`${detail.coherence_return_cycles} of 2`}
            />
            <div className="mt-4 flex flex-wrap gap-2">
              {detail.status === "waiting" && onReviewFindings && (
                <div className="w-full">
                  <Button type="button" variant="outline" onClick={onReviewFindings}>
                    Review findings →
                  </Button>
                  <p className="mt-2 text-xs text-muted">
                    Read each finding, then accept or reject it with a short rationale. Accepted
                    fixes are applied in the revision pass; rejected ones are recorded for the
                    export with your reason.
                  </p>
                </div>
              )}
              {(detail.status === "running" || action === "resume") &&
                !detail.blocked_for_operator && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={action !== null && action !== "cancel"}
                    loading={action === "cancel"}
                    onClick={() => onAction("cancel")}
                  >
                    {action === "cancel" ? "Stopping…" : "Stop blog post"}
                  </Button>
                )}
              {detail.can_retry && !detail.blocked_for_operator && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={action !== null}
                  loading={action === "resume"}
                  onClick={() => onAction("resume")}
                >
                  {action === "resume"
                    ? detail.current_step === "internal_link_discovery"
                      ? "Discovering links…"
                      : "Resuming…"
                    : detail.current_step === "internal_link_discovery"
                      ? "Retry link discovery"
                      : detail.draft_recovery === "legacy_confirmation_required"
                        ? "Authorise one new draft request"
                        : "Resume safely"}
                </Button>
              )}
              {detail.export.status === "failed" && !detail.blocked_for_operator && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={action !== null}
                  loading={action === "export"}
                  onClick={() => onAction("export")}
                >
                  {action === "export" ? "Retrying export…" : "Retry export"}
                </Button>
              )}
            </div>
          </ContextSection>

          <LinkDiscoveryContext detail={detail} />

          <ContextSection title="Completion summary">
            <DefinitionRow
              label="Model tokens (in / out)"
              value={`${detail.usage.input_units.toLocaleString("en-GB")} / ${detail.usage.output_units.toLocaleString("en-GB")}`}
              mono
            />
            <DefinitionRow label="Warnings" value={String(detail.counts.warnings)} mono />
            <DefinitionRow
              label="Claims needing review"
              value={String(detail.counts.hard_flags)}
              mono
            />
            <DefinitionRow
              label="Rejected suggestions"
              value={String(detail.counts.rejected_findings)}
              mono
            />
          </ContextSection>

          <ContextSection title="Export">
            <DefinitionRow label="Google Docs">
              <StatusBadge status={detail.export.status} />
            </DefinitionRow>
            {(detail.current_step === "final_coherence_export" ||
              detail.status === "succeeded" ||
              detail.export.status === "failed") && <GoogleDocsConnection />}
            {detail.export.external_url ? (
              <a
                className="mt-3 inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 [overflow-wrap:anywhere] text-sm font-semibold text-action underline underline-offset-4 hover:text-action-hover"
                href={detail.export.external_url}
                target="_blank"
                rel="noreferrer"
              >
                Open exported document
                <ArrowUpRight aria-hidden="true" className="size-4" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <p className="mt-3 text-sm text-muted">
                {detail.status === "succeeded" || detail.status === "cancelled"
                  ? "No export link is available."
                  : "Available after final coherence review."}
              </p>
            )}
          </ContextSection>

          {current && (
            <ContextSection title="Technical details">
              <details className="group mt-1">
                <summary className="cursor-pointer list-none text-sm text-muted hover:text-action">
                  Show reference IDs for support
                  <span className="ml-1 inline-block transition-transform group-open:rotate-90">
                    ›
                  </span>
                </summary>
                <dl className="mt-3 divide-y divide-rule border-t border-rule pt-1">
                  <DefinitionRow
                    label="Draft version"
                    value={truncateId(current.version.id)}
                    mono
                  />
                  <DefinitionRow
                    label="Revised from"
                    value={
                      current.version.parent_id
                        ? truncateId(current.version.parent_id)
                        : "Original draft"
                    }
                    mono
                  />
                  <DefinitionRow label="Stored file" value={truncateId(current.artifact.id)} mono />
                  <DefinitionRow
                    label="Checksum"
                    value={current.version.content_hash.slice(0, 12)}
                    mono
                  />
                </dl>
              </details>
            </ContextSection>
          )}
        </aside>
      </div>
    </div>
  );
}

function LinkDiscoveryContext({ detail }: { detail: RunDetailData }) {
  const metadata = detail.link_discovery.metadata;
  if (!metadata && detail.link_discovery.shortlist.length === 0) return null;
  const sourceLabel = (value: string) => value.replaceAll("_", " ");
  return (
    <ContextSection title="Link discovery">
      <DefinitionRow
        label="Eligibility"
        value={metadata?.eligibility === "eligible" ? "Verified commercial links" : "Blocked"}
      />
      {metadata && (
        <>
          <DefinitionRow
            label="Public sitemap"
            value={sourceLabel(metadata.providerStatus.sitemap ?? "historical record")}
          />
          <DefinitionRow label="Search Console" value={sourceLabel(metadata.providerStatus.gsc)} />
          <DefinitionRow
            label="Cache"
            value={`${sourceLabel(metadata.cache.state)}${metadata.cache.retrieved_at ? ` · ${new Date(metadata.cache.retrieved_at).toLocaleString("en-GB")}` : ""}`}
          />
          <DefinitionRow
            label="Local bypass"
            value={
              metadata.bypass.used
                ? "Used · unverified link testing"
                : metadata.bypass.enabled
                  ? "Enabled · not used"
                  : "Disabled"
            }
          />
          <DefinitionRow
            label="Collected"
            value={`${(metadata.counts.sitemap_collected ?? metadata.counts.ghost_collected) + metadata.counts.gsc_collected}`}
            mono
          />
          <DefinitionRow
            label="Commercial / editorial"
            value={`${metadata.counts.commercial} / ${metadata.counts.editorial}`}
            mono
          />
          <DefinitionRow
            label="Direct 200 / unresolved"
            value={`${metadata.counts.direct_200} / ${metadata.counts.unresolved}`}
            mono
          />
        </>
      )}
      <DefinitionRow
        label="Exact shortlist"
        value={String(detail.link_discovery.shortlist.length)}
        mono
      />
      {detail.link_discovery.shortlist.length > 0 && (
        <div className="py-2">
          <dt className="text-sm text-muted">Hierarchy and provenance</dt>
          <dd>
            <ol className="mt-2 divide-y divide-rule border-t border-rule">
              {detail.link_discovery.shortlist.map((link) => (
                <li key={link.url} className="py-2 text-xs">
                  <p className="font-medium text-ink">{link.title}</p>
                  <p className="mt-1 [overflow-wrap:anywhere] font-mono text-muted">{link.url}</p>
                  <p className="mt-1 text-muted">
                    {link.hierarchy?.replaceAll("_", " ")} · direct HTTP {link.status} ·{" "}
                    {link.source?.replaceAll("_", " ")}
                  </p>
                </li>
              ))}
            </ol>
          </dd>
        </div>
      )}
    </ContextSection>
  );
}

function MetadataItem({ value, label }: { value: string; label: string }) {
  return (
    <span>
      <span className="font-mono font-semibold tabular-nums text-ink">{value}</span>{" "}
      <span className="text-muted">{label}</span>
    </span>
  );
}

/** Shortened identifier form for the technical-details disclosure; full IDs remain in the API. */
function truncateId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function ContextSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b border-rule px-4 py-4 last:border-b-0">
      <h2 className="text-sm font-semibold">{title}</h2>
      <dl className="mt-2 divide-y divide-rule">{children}</dl>
    </section>
  );
}

function DefinitionRow({
  label,
  value,
  mono = false,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-2 text-sm">
      <dt className="min-w-0 [overflow-wrap:anywhere] text-muted">{label}</dt>
      <dd
        className={`min-w-0 max-w-[60%] [overflow-wrap:anywhere] text-right tabular-nums ${mono ? "font-mono text-xs" : ""}`}
      >
        {children ?? value}
      </dd>
    </div>
  );
}

function formatBlockerLocation(location: Record<string, unknown>): string {
  const field = typeof location.field === "string" ? location.field : "Unknown field";
  const start = typeof location.line_start === "number" ? location.line_start : null;
  const end = typeof location.line_end === "number" ? location.line_end : start;
  const section = typeof location.section === "string" ? location.section : null;
  if (start !== null)
    return `${field}, ${start === end ? `line ${start}` : `lines ${start}–${end}`}`;
  if (section) return `${field}, section ${section}`;
  return field;
}

function formatCost(micros: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(micros / 1_000_000);
}

/**
 * A frontend-only display heuristic for client review — RunDetail has no
 * real "quality safety" field. Starts at 100% and deducts for warnings and
 * hard flags found so far; not a backend-computed metric.
 */
function qualitySafetyPercent(counts: RunDetailData["counts"]): number {
  return Math.max(0, 100 - (counts.warnings + counts.hard_flags) * 2);
}

/**
 * A minimal, dependency-free renderer for the pipeline's own generated
 * markdown body — headings and paragraphs only, split on blank lines. No
 * markdown package is installed for this; the pipeline's output is a small,
 * predictable subset (see AGENTS.md — deterministic checks before model
 * reviews), so a full parser isn't needed.
 */
function renderMarkdownBlocks(markdown: string) {
  const blocks: Array<{ type: "heading" | "paragraph"; text: string }> = [];
  let paragraphLines: string[] = [];

  function flushParagraph() {
    const text = paragraphLines.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraphLines = [];
  }

  // Line-based, not blank-line-block-based: real generated markdown doesn't
  // always put a blank line after a heading, so splitting on "\n\n" alone
  // left the leading "#" as literal text in the following paragraph.
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", text: heading[1] ?? "" });
    } else {
      paragraphLines.push(line);
    }
  }
  flushParagraph();

  return blocks.map((block, index) =>
    block.type === "heading" ? (
      <h4
        key={index}
        className="mt-6 [overflow-wrap:anywhere] font-serif text-h3 font-semibold text-ink first:mt-0"
      >
        {block.text}
      </h4>
    ) : (
      <p
        key={index}
        className="mt-3 [overflow-wrap:anywhere] font-serif text-document text-ink first:mt-0"
      >
        {block.text}
      </p>
    ),
  );
}

function progressSummary(
  completed: number,
  status: RunDetailData["status"],
  currentStepName: string | null,
): string {
  if (status === "succeeded") return `${completed} of 12 steps complete. Finished.`;
  if (status === "cancelled") return `${completed} of 12 steps complete. Cancelled.`;
  if (!currentStepName) return `${completed} of 12 steps complete.`;
  const verb =
    status === "waiting"
      ? "waiting on your decision"
      : status === "blocked"
        ? "blocked"
        : status === "retryable_failed"
          ? "needs a retry"
          : "running";
  return `${completed} of 12 steps complete; ${currentStepName} ${verb}.`;
}

/**
 * A numbers-only twelve-step strip — an at-a-glance read of the whole
 * pipeline above the rail. Completed: near-black fill; current: terracotta
 * border; queued: warm rule border, muted number. Step names surface through
 * the accessible label, individual `title` tooltips, and the rail below.
 */
function PipelineStrip({
  attempts,
  currentStepId,
  completed,
  status,
  currentStepName,
}: {
  attempts: Map<PipelineStepId, RunDetailData["steps"]>;
  currentStepId: PipelineStepId | null;
  completed: number;
  status: RunDetailData["status"];
  currentStepName: string | null;
}) {
  return (
    <div
      role="img"
      aria-label={progressSummary(completed, status, currentStepName)}
      className="mb-6 max-w-full overflow-x-auto overscroll-x-contain"
    >
      <div className="flex min-w-max gap-1 sm:min-w-0">
        {PIPELINE_STEPS.map((step, index) => {
          const isCompleted = attempts.get(step.id)?.at(-1)?.status === "succeeded";
          const isCurrent = step.id === currentStepId;
          return (
            <span
              key={step.id}
              aria-hidden="true"
              title={`${step.number} ${step.name}`}
              className={`flex h-5 w-8 flex-1 shrink-0 items-center justify-center rounded-control border font-mono text-[10px] tabular-nums sm:w-auto ${
                isCompleted
                  ? "border-ink bg-ink text-paper"
                  : isCurrent
                    ? "border-action bg-action/10 text-action"
                    : "border-rule bg-paper text-muted"
              }`}
            >
              {String(index + 1).padStart(2, "0")}
            </span>
          );
        })}
      </div>
    </div>
  );
}

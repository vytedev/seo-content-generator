import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDetail, RunSummary } from "../../../shared/contracts/run-detail.js";
import { AsyncNotice } from "../../components/AsyncNotice.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Button } from "../../components/ui/button.js";
import { fetchRecentRuns } from "../../lib/run-list-api.js";
import { newActionIdempotencyKey } from "../../lib/command-submission-api.js";
import { apiFetch } from "../../lib/api.js";
import { reportClientFailure } from "../../lib/diagnostics.js";
import {
  parseRunCommandResponse,
  parseRunDetailResponse,
  resumeEndpoint,
  resumeRequest,
} from "../../lib/run-detail-api.js";
import { FindingsReview } from "../findings/FindingsReview.js";
import { NewRun } from "../runs/NewRun.js";
import { RunWorkspace, type RunAction } from "../runs/RunWorkspace.js";
import { RunWorkspaceSkeleton } from "../runs/RunWorkspaceSkeleton.js";
import { BlogPostsTable } from "./BlogPostsTable.js";
import { HandoffReference } from "./HandoffReference.js";
import { phaseFromRunStatus } from "./phase.js";
import { WorkflowBreadcrumb, type WorkflowStep } from "./WorkflowBreadcrumb.js";

type ListState = "loading" | "loaded" | "error";

const RUN_QUERY_KEY = "run";
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function runIdFromLocation(): string {
  const value = new URLSearchParams(window.location.search).get(RUN_QUERY_KEY)?.trim() ?? "";
  return RUN_ID_PATTERN.test(value) ? value : "";
}

function setRunInLocation(runId: string) {
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set(RUN_QUERY_KEY, runId);
  else url.searchParams.delete(RUN_QUERY_KEY);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * The one continuous article flow: start → running → needs your decision →
 * done. The active state is always derived from the focused run's server-side
 * status, never from where the operator clicked.
 */
export function BlogPost() {
  const [listState, setListState] = useState<ListState>("loading");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [listError, setListError] = useState("");
  const [focusRunId, setFocusRunId] = useState(runIdFromLocation);
  // Bumped only when a run's status or stage actually moves, so the history
  // table refreshes with the pipeline without polling on its own.
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [action, setAction] = useState<RunAction>(null);
  const [actionError, setActionError] = useState("");
  const [backToStart, setBackToStart] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  const actionKeys = useRef(new Map<string, string>());

  const applyDetail = useCallback((incoming: RunDetail) => {
    // A quiet poll and an action response can cross in flight. Never let an
    // older snapshot overwrite newer server state and make the screen appear
    // stuck until a hard refresh.
    setDetail((current) =>
      current && Date.parse(current.updated_at) > Date.parse(incoming.updated_at)
        ? current
        : incoming,
    );
    setDetailState("loaded");
    setDetailError("");
  }, []);

  const fetchDetail = useCallback(
    async (id: string, quiet = false): Promise<RunDetail | null> => {
      if (!quiet) setDetailState("loading");
      try {
        const response = await apiFetch(`/api/runs/${encodeURIComponent(id)}`);
        const body: unknown = await response.json();
        const parsed = parseRunDetailResponse(
          body,
          response.ok,
          "The blog post could not be loaded.",
        );
        applyDetail(parsed);
        return parsed;
      } catch (error) {
        if (!quiet) {
          setDetail(null);
          setDetailState("error");
          setDetailError(
            error instanceof Error ? error.message : "The blog post could not be loaded.",
          );
        }
        return null;
      }
    },
    [applyDetail],
  );

  // The history/navigation slice never chooses the focused run. A normal load
  // always stays at 01 Handoff; only an explicit, valid `?run=<uuid>` deep link
  // reopens a run after refresh.
  useEffect(() => {
    let cancelled = false;
    fetchRecentRuns()
      .then((list) => {
        if (cancelled) return;
        setRuns(list);
        setListState("loaded");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setListError(caught instanceof Error ? caught.message : "Blog posts could not be loaded.");
        setListState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const restoreFromHistory = () => {
      setFocusRunId(runIdFromLocation());
      setBackToStart(false);
    };
    window.addEventListener("popstate", restoreFromHistory);
    return () => window.removeEventListener("popstate", restoreFromHistory);
  }, []);

  useEffect(() => {
    if (focusRunId) void fetchDetail(focusRunId);
  }, [fetchDetail, focusRunId]);

  // Poll while the pipeline is actively working. A resume/export request is
  // synchronous on the server, so begin polling as soon as the operator
  // clicks rather than waiting for that long request to return. This keeps
  // step/status changes visible without a hard refresh.
  useEffect(() => {
    const actionIsAdvancing = action === "resume" || action === "export";
    if (
      !focusRunId ||
      !detail ||
      (!actionIsAdvancing && !["queued", "running"].includes(detail.status))
    )
      return;
    void fetchDetail(focusRunId, true);
    const interval = window.setInterval(() => void fetchDetail(focusRunId, true), 2000);
    return () => window.clearInterval(interval);
  }, [action, detail?.status, fetchDetail, focusRunId]);

  // Poll the run list so every part of the screen that reads run summaries —
  // "Pick up where you left off", the breadcrumb's run picks — stays live
  // while the pipeline works, with no manual page refresh. Quiet failures: a
  // transient poll error must never disturb the screen.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchRecentRuns()
        .then((list) => {
          setRuns((current) => {
            const signature = (items: RunSummary[]) =>
              items.map((run) => `${run.run_id}:${run.status}:${run.current_step}`).join("|");
            if (signature(current) !== signature(list)) setHistoryRefresh((value) => value + 1);
            return list;
          });
          setListState("loaded");
          setListError("");
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  // A focused run always owns the screen once chosen, even before its detail
  // has loaded — otherwise the compose form flashes back up while a resumed
  // run's own detail fetch is still in flight.
  const hasFocus = Boolean(focusRunId) && !backToStart;
  const phase =
    detail && detailState === "loaded" && !backToStart
      ? phaseFromRunStatus(detail.status)
      : "start";
  const workflowStep: WorkflowStep = !hasFocus
    ? "handoff"
    : showFindings
      ? "decision"
      : phase === "done"
        ? "export"
        : "production";
  // Step 1.9 pauses the pipeline for a decision, so the findings screen
  // opens on its own the moment the run's phase becomes "needs-decision"
  // (see the effect below) — no click required. The in-workspace "Review
  // findings →" affordance and the breadcrumb's "03 Decision" remain as a
  // manual way back in once the operator has navigated elsewhere (e.g. "02
  // Production"). The breadcrumb link works regardless of the run's real
  // phase — it's a way to inspect the findings screen at any time — but the
  // in-workspace "Review findings →" affordance and the rail's own row stay
  // honest, only lighting up once the run has actually reached that step
  // (see RunWorkspace.tsx's own "detail.status === 'waiting'" checks).
  const workspaceVisible = !showFindings;
  const focusedSummary = runs.find((run) => run.run_id === focusRunId);
  const pageTitle =
    hasFocus && focusedSummary ? toSentenceCase(focusedSummary.primary_keyword) : "Blog post";
  // From the start screen, the breadcrumb can still jump straight to an
  // existing run that's already at that stage. These come from the small
  // navigation list, never from the history table: a run the breadcrumb needs
  // may well sit on a page the table is not currently showing.
  const productionRunId = findRunForPhase(runs, "running");
  const decisionRunId = findRunForPhase(runs, "needs-decision");
  const doneRunId = findRunForPhase(runs, "done");
  const breadcrumbSelect: Partial<Record<WorkflowStep, () => void>> = {};
  if (hasFocus) breadcrumbSelect.handoff = startNew;
  if (hasFocus && detail) breadcrumbSelect.production = () => setShowFindings(false);
  else if (!hasFocus && productionRunId)
    breadcrumbSelect.production = () => openRun(productionRunId);
  if (hasFocus && detail) breadcrumbSelect.decision = () => setShowFindings(true);
  else if (!hasFocus && decisionRunId) breadcrumbSelect.decision = () => openRun(decisionRunId);
  if (!hasFocus && doneRunId) breadcrumbSelect.export = () => openRun(doneRunId);

  useEffect(() => {
    setShowFindings(false);
  }, [focusRunId]);

  // Opens automatically on reaching the decision phase, closes on leaving
  // it. Only re-runs when `phase` itself changes value — not on every 5s
  // poll tick — so a deliberate "02 Production" click sticks until the run
  // actually moves to a different phase.
  useEffect(() => {
    setShowFindings(phase === "needs-decision");
  }, [phase]);

  function openRun(runId: string) {
    setBackToStart(false);
    setFocusRunId(runId);
    actionKeys.current.clear();
    setRunInLocation(runId);
  }

  function startNew() {
    setBackToStart(true);
    setDetail(null);
    setDetailState("idle");
    setFocusRunId("");
    actionKeys.current.clear();
    setRunInLocation("");
  }

  async function performAction(kind: Exclude<RunAction, null>) {
    if (!focusRunId || !detail) return;
    setAction(kind);
    setActionError("");
    const actionIdentity = `${focusRunId}:${kind}`;
    const idempotencyKey =
      actionKeys.current.get(actionIdentity) ?? newActionIdempotencyKey(kind, focusRunId);
    actionKeys.current.set(actionIdentity, idempotencyKey);
    const path =
      kind === "export"
        ? `/api/runs/${encodeURIComponent(focusRunId)}/export/retry`
        : kind === "cancel"
          ? `/api/runs/${encodeURIComponent(focusRunId)}/cancel`
          : kind === "exceptional-correction"
            ? `/api/runs/${encodeURIComponent(focusRunId)}/exceptional-correction/authorise`
            : resumeEndpoint(focusRunId, detail.current_step);
    try {
      const response = await apiFetch(path, {
        ...(kind === "resume"
          ? resumeRequest(detail.current_step, detail.draft_recovery, idempotencyKey)
          : {
              method: "POST",
              headers: { "Idempotency-Key": idempotencyKey },
            }),
        ...(kind === "exceptional-correction"
          ? {
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                explicit_confirmation: true,
                idempotency_key: idempotencyKey,
              }),
            }
          : {}),
      });
      const body: unknown = await response.json();
      parseRunCommandResponse(
        body,
        response.status,
        focusRunId,
        "The action could not be completed.",
      );
      // The durable acceptance retires this key. Any failure before this point,
      // including a disconnected response, deliberately keeps it for replay.
      actionKeys.current.delete(actionIdentity);
      setBackToStart(false);
      await fetchDetail(focusRunId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action could not be completed.";
      setActionError(message);
      reportClientFailure("pipeline.action.failed", {
        run_id: focusRunId,
        ...(detail.current_step ? { step: detail.current_step } : {}),
        category: "client",
        reason_code: "action_failed",
      });
    } finally {
      // Reconcile once more after any successful or failed action response.
      // The server may have committed a newer step even when the request was
      // interrupted or returned a safe error.
      await fetchDetail(focusRunId, true);
      setAction(null);
    }
  }

  return (
    <div className="w-full min-w-0 max-w-full flex-1 overflow-x-clip [overflow-wrap:anywhere] px-4 py-8 sm:px-6 xl:px-8">
      <PageHeader
        id="blog-post-heading"
        eyebrow={
          !hasFocus
            ? "Start a blog post"
            : !workspaceVisible
              ? "Operator review"
              : phase === "done"
                ? detail?.status === "cancelled"
                  ? "Cancelled"
                  : "Pipeline complete"
                : "In production"
        }
        title={
          !hasFocus
            ? pageTitle
            : !workspaceVisible
              ? "Needs your decision"
              : phase === "done"
                ? detail?.status === "cancelled"
                  ? "Blog post cancelled"
                  : "Export ready"
                : pageTitle
        }
      >
        {!hasFocus
          ? "Paste or upload your keyword handoff — the pipeline takes it from there and stops only when it needs your decision."
          : !workspaceVisible
            ? "Accept or reject each finding below, then continue the pipeline."
            : phase === "done"
              ? detail?.status === "cancelled"
                ? "This blog post was cancelled before completion."
                : "The finished document has passed final coherence review and is ready to open."
              : "The pipeline is producing a single exportable document. Review is required before revisions proceed."}
      </PageHeader>

      <WorkflowBreadcrumb current={workflowStep} onSelect={breadcrumbSelect} />

      {listState === "error" && (
        <AsyncNotice
          message={`${listError} You can still start a new blog post below.`}
          tone="error"
        />
      )}

      {!hasFocus && (
        <>
          <p className="mb-6 text-sm text-muted">
            This is the handoff produced at the end of your keyword-research chat in Claude — paste
            the JSON below, or upload the file you saved.
          </p>
          <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0">
              <NewRun onOpenRun={openRun} />
            </div>
            <aside className="min-w-0 w-full space-y-8 md:sticky md:top-20">
              <HandoffReference />
            </aside>
          </div>
          {/* Full width, below the whole handoff area: the complete history is
              its own concern, not part of composing a new blog post. */}
          <div className="mt-8">
            <BlogPostsTable onOpenRun={openRun} refreshToken={historyRefresh} />
          </div>
        </>
      )}

      {hasFocus && (
        <>
          <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-muted">
              Blog post ID: {focusRunId}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={startNew}>
              Start another blog post
            </Button>
          </div>

          {actionError && <AsyncNotice message={actionError} tone="error" />}

          {detailState === "loading" && (
            <>
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                Loading your blog post…
              </p>
              <RunWorkspaceSkeleton />
            </>
          )}
          {detailState === "error" && (
            <div className="space-y-3">
              <AsyncNotice message={detailError} tone="error" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchDetail(focusRunId)}
              >
                Try again
              </Button>
            </div>
          )}

          {detail && detailState === "loaded" && (
            <div
              key={`${phase}-${showFindings}`}
              className="min-w-0 max-w-full animate-in fade-in-0 duration-[170ms] ease-[cubic-bezier(0.25,1,0.5,1)]"
            >
              {showFindings && (
                <>
                  <FindingsReview
                    key={focusRunId}
                    runId={focusRunId}
                    onSubmitted={() => void fetchDetail(focusRunId, true)}
                  />
                </>
              )}

              {workspaceVisible && (
                <RunWorkspace
                  detail={detail}
                  action={action}
                  onAction={performAction}
                  {...(phase === "needs-decision"
                    ? { onReviewFindings: () => setShowFindings(true) }
                    : {})}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function toSentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** The newest run already at the given phase, if any — for the breadcrumb's start-screen shortcuts. */
function findRunForPhase(
  list: RunSummary[],
  target: ReturnType<typeof phaseFromRunStatus>,
): string | undefined {
  return list.find((run) => phaseFromRunStatus(run.status) === target)?.run_id;
}

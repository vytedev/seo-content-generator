import { useEffect, useId, useRef, useState } from "react";
import type { RunSummary } from "../../../shared/contracts/run-detail.js";
import { PIPELINE_STEPS } from "../../../shared/pipeline.js";
import {
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_FILTERS,
  RUN_LIST_FILTER_LABELS,
  type RunListFilter,
  type RunListPagination,
  type RunStatus,
} from "../../../shared/contracts/run-list.js";
import { fetchRunPage } from "../../lib/run-list-api.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";

function stepLabel(stepId: RunSummary["current_step"]): string {
  if (!stepId) return "Not started";
  const step = PIPELINE_STEPS.find((candidate) => candidate.id === stepId);
  // Never a raw step id: the operator's vocabulary is the numbered pipeline.
  return step ? `${step.number} · ${step.name}` : "Unknown stage";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Keywords are stored as typed; present them consistently without hiding them. */
function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed[0]!.toLocaleUpperCase("en-GB") + trimmed.slice(1);
}

/**
 * What the row's action offers, named for the state the operator will find.
 *
 * Every one of these only opens the run's details. None retries, exports or
 * changes anything: the decision to act belongs on the run's own screen, where
 * the evidence for it is visible.
 */
const ACTION_LABEL = {
  queued: "Continue",
  running: "Continue",
  waiting: "Review",
  retryable_failed: "Open retry",
  blocked: "Review issue",
  succeeded: "View result",
  cancelled: "View details",
} as const satisfies Record<RunStatus, string>;

const EMPTY_MESSAGE: Record<RunListFilter, string> = {
  all: "No blog posts yet. Start one with a handoff above.",
  needs_attention: "Nothing needs attention.",
  in_progress: "No blog posts are in progress.",
  finished: "No finished blog posts yet.",
  cancelled: "No cancelled blog posts.",
};

/**
 * Opens the run and nothing else.
 *
 * The accessible name carries the keyword too, so a screen reader reading the
 * page's buttons hears which blog post each one opens rather than several
 * identical "Continue"s.
 */
function RunAction({ run, onOpenRun }: { run: RunSummary; onOpenRun: (runId: string) => void }) {
  const label = ACTION_LABEL[run.status];
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${label}: ${sentenceCase(run.primary_keyword)}`}
      onClick={() => onOpenRun(run.run_id)}
    >
      {label}
    </Button>
  );
}

/**
 * The complete blog-post history: every status, filtered and paged on the
 * server.
 *
 * Its filter and page are entirely its own. The run the operator is working on
 * is chosen elsewhere and is never derived from what this table happens to be
 * showing, so paging or filtering can never move, close or reopen a run.
 */
export function BlogPostsTable({
  onOpenRun,
  refreshToken,
}: {
  onOpenRun: (runId: string) => void;
  /** Changes when pipeline activity elsewhere should refresh the current page. */
  refreshToken?: number;
}) {
  const headingId = useId().replaceAll(":", "");
  const [filter, setFilter] = useState<RunListFilter>("all");
  const [page, setPage] = useState(1);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [pagination, setPagination] = useState<RunListPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Only the newest request may write to the table: a slow earlier page must
  // never replace the one the operator has since asked for.
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setLoading(true);
    fetchRunPage({ page, limit: RUN_LIST_DEFAULT_LIMIT, filter }, controller.signal)
      .then((result) => {
        if (current !== sequence.current) return;
        setRuns(result.runs);
        setPagination(result.pagination);
        setError("");
        setLoaded(true);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (current !== sequence.current || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Blog posts could not be loaded.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [filter, page, refreshToken]);

  function changeFilter(next: RunListFilter) {
    setFilter(next);
    // A filter change always starts at the first page of the new result set.
    setPage(1);
  }

  const total = pagination?.total_items ?? 0;
  const totalPages = pagination?.total_pages ?? 0;
  // The range describes the rows actually on screen, so a short final page
  // reads honestly rather than claiming a full one.
  const rangeStart =
    runs.length === 0
      ? 0
      : ((pagination?.page ?? 1) - 1) * (pagination?.limit ?? RUN_LIST_DEFAULT_LIMIT) + 1;
  const rangeEnd = rangeStart === 0 ? 0 : rangeStart + runs.length - 1;

  return (
    <section aria-labelledby={headingId} className="rounded-group border border-rule bg-paper">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rule p-4 sm:p-6">
        <div className="min-w-0">
          <h2 id={headingId} className="text-h2 font-semibold">
            Blog posts
          </h2>
          <p className="mt-1 text-sm text-muted">
            Track current work, review runs that need attention, and reopen finished exports.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading && loaded && <Spinner aria-label="Loading blog posts" className="size-4" />}
          <Select value={filter} onValueChange={(value) => changeFilter(value as RunListFilter)}>
            <SelectTrigger aria-label="Filter blog posts" className="w-[11rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RUN_LIST_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RUN_LIST_FILTER_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="p-4 text-sm text-danger sm:p-6">
          {error}
        </p>
      ) : !loaded ? (
        <p className="p-4 text-sm text-muted sm:p-6">Loading blog posts…</p>
      ) : runs.length === 0 ? (
        <p className="p-4 text-sm text-muted sm:p-6">{EMPTY_MESSAGE[filter]}</p>
      ) : (
        <>
          {/* Cards on narrow screens, a real table from md up: the same rows
              either way, so nothing is only reachable on one screen size. Only
              one is ever displayed, and `display: none` keeps the other out of
              the accessibility tree as well as out of sight. */}
          <ul className="divide-y divide-rule md:hidden">
            {runs.map((run) => (
              <li key={run.run_id} className="flex flex-wrap items-start gap-x-4 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words text-ink">
                    {sentenceCase(run.primary_keyword)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <span className="font-mono">{run.plane_ticket}</span> ·{" "}
                    {stepLabel(run.current_step)} · {formatDate(run.created_at)}
                  </p>
                </div>
                <StatusBadge status={run.status} />
                <RunAction run={run} onOpenRun={onOpenRun} />
              </li>
            ))}
          </ul>

          <div className="hidden md:block">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Blog posts, filtered by {RUN_LIST_FILTER_LABELS[filter].toLocaleLowerCase("en-GB")}
              </caption>
              <thead>
                <tr className="border-b border-rule text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Keyword
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Ticket
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Current stage
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {runs.map((run) => (
                  <tr key={run.run_id}>
                    <th
                      scope="row"
                      className="max-w-[18rem] px-4 py-3 text-left font-medium break-words text-ink"
                    >
                      {sentenceCase(run.primary_keyword)}
                    </th>
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap text-muted">
                      {run.plane_ticket}
                    </td>
                    <td className="px-4 py-3 text-muted">{stepLabel(run.current_step)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted">
                      {formatDate(run.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RunAction run={run} onOpenRun={onOpenRun} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {loaded && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule p-4 sm:p-6">
          <p aria-live="polite" className="text-sm text-muted">
            Showing {rangeStart}–{rangeEnd} of {total} {total === 1 ? "blog post" : "blog posts"} ·
            Page {pagination?.page ?? 1} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || !pagination?.has_previous}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || !pagination?.has_next}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

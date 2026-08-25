import { CircleAlert } from "lucide-react";
import type { StepStatus } from "../../shared/pipeline.js";

type Status = StepStatus | "not_started" | "pending" | "failed";

const labels: Record<Status, string> = {
  queued: "Queued",
  leased: "Leased",
  running: "Running",
  waiting: "Waiting",
  retryable_failed: "Retry available",
  blocked: "Blocked",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
  not_started: "Not started",
  pending: "Pending",
  failed: "Failed",
};

/** Dot colour (or icon colour for the attention states) — see .xevy/design.md §10, Status treatment. */
const dotTone: Record<Status, string> = {
  queued: "bg-muted",
  leased: "bg-info",
  running: "bg-info",
  waiting: "bg-warning",
  retryable_failed: "bg-danger",
  blocked: "bg-danger",
  succeeded: "bg-success",
  cancelled: "bg-muted",
  not_started: "bg-muted",
  pending: "bg-info",
  failed: "bg-danger",
};

const textTone: Record<Status, string> = {
  queued: "text-muted",
  leased: "text-info",
  running: "text-info",
  waiting: "text-warning",
  retryable_failed: "text-danger",
  blocked: "text-danger",
  succeeded: "text-success",
  cancelled: "text-muted",
  not_started: "text-muted",
  pending: "text-info",
  failed: "text-danger",
};

/** The attention states get a small icon instead of a plain dot. */
const needsIcon = new Set<Status>(["retryable_failed", "blocked", "failed"]);

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${textTone[status]}`}
    >
      {needsIcon.has(status) ? (
        <CircleAlert aria-hidden="true" className={`size-3 ${textTone[status]}`} />
      ) : (
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dotTone[status]}`} />
      )}
      {labels[status]}
    </span>
  );
}

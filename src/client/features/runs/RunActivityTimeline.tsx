import type { RunActivity } from "../../../shared/commands.js";

const ACTIVITY_LABELS: Record<RunActivity["type"], string> = {
  command_accepted: "Action accepted",
  command_rejected: "Action rejected",
  step_started: "Step started",
  step_waiting: "Waiting for review",
  step_failed: "Step needs attention",
  step_blocked: "Step blocked",
  step_succeeded: "Step completed",
  run_cancelled: "Blog post cancelled",
  warning_recorded: "Warning recorded",
  warning_acknowledged: "Warning acknowledged",
  export_succeeded: "Export completed",
};

export function RunActivityTimeline({ activity }: { activity: RunActivity[] }) {
  return (
    <section aria-labelledby="activity-heading" className="border-t border-rule px-4 py-4">
      <h3 id="activity-heading" className="text-sm font-semibold text-ink">
        Activity
      </h3>
      {activity.length ? (
        <ol className="mt-3 space-y-3">
          {[...activity].reverse().map((event) => (
            <li
              key={event.activity_id}
              className="grid grid-cols-[8px_minmax(0,1fr)] gap-2 text-xs"
            >
              <span aria-hidden="true" className="mt-1.5 size-1.5 bg-muted" />
              <div className="min-w-0">
                <p className="font-medium text-ink">{ACTIVITY_LABELS[event.type]}</p>
                <p className="mt-0.5 text-muted">{event.summary}</p>
                <time
                  className="mt-1 block font-mono text-[10px] text-muted"
                  dateTime={event.occurred_at}
                >
                  {new Intl.DateTimeFormat("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(event.occurred_at))}
                </time>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted">No activity has been recorded yet.</p>
      )}
    </section>
  );
}

export type WorkflowStep = "handoff" | "production" | "decision" | "export";

const STEPS: Array<{ id: WorkflowStep; number: string; label: string }> = [
  { id: "handoff", number: "01", label: "Handoff" },
  { id: "production", number: "02", label: "Production" },
  { id: "decision", number: "03", label: "Decision" },
  { id: "export", number: "04", label: "Export" },
];

/**
 * A four-stage progress indicator for the blog post lifecycle. A step is a
 * real navigation link only when the caller supplies a handler for it — i.e.
 * only once the run has actually reached a view for that step. The active
 * phase itself is still always derived from server status, never from these
 * clicks: this only ever moves between views the run has already unlocked
 * (e.g. back from the findings screen to the workspace), never forward to a
 * status the run hasn't reached yet.
 */
export function WorkflowBreadcrumb({
  current,
  onSelect,
}: {
  current: WorkflowStep;
  onSelect?: Partial<Record<WorkflowStep, () => void>>;
}) {
  return (
    <nav
      aria-label="Blog post workflow"
      className="mb-6 max-w-full overflow-x-auto border-y border-rule overscroll-x-contain"
    >
      <ol className="flex h-9 min-w-max items-center gap-6 px-1 font-mono text-xs">
        {STEPS.map((step) => {
          const isCurrent = step.id === current;
          const handler = onSelect?.[step.id];
          const toneClass = isCurrent ? "font-semibold text-action" : "text-muted";
          return (
            <li
              key={step.id}
              aria-current={isCurrent ? "step" : undefined}
              className={`border-b-2 pb-1 ${isCurrent ? "border-action" : "border-transparent"}`}
            >
              {handler ? (
                <button
                  type="button"
                  onClick={handler}
                  className={`cursor-pointer hover:text-action ${toneClass}`}
                >
                  <span className="tabular-nums">{step.number}</span> {step.label}
                </button>
              ) : (
                <span className={toneClass}>
                  <span className="tabular-nums">{step.number}</span> {step.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

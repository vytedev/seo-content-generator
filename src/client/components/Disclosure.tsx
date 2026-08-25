import { type ReactNode, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A collapsible section built on native details/summary, so keyboard support
 * and the disclosure semantics come from the platform rather than from state.
 */
export function Disclosure({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const generatedId = useId().replaceAll(":", "");
  const triggerId = `disclosure-${generatedId}-trigger`;
  const contentId = `disclosure-${generatedId}-content`;
  const [expanded, setExpanded] = useState(false);

  return (
    <details
      className="group border-b border-rule py-3 last:border-b-0"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary
        id={triggerId}
        className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-control text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <span>
          {title}
          {typeof count === "number" && count > 0 && (
            <span className="ml-2 font-mono text-xs font-normal text-muted">· {count}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div id={contentId} role="region" aria-labelledby={triggerId} className="mt-3 min-w-0">
        {children}
      </div>
    </details>
  );
}

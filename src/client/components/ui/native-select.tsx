import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils.js";

function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className="relative min-w-0">
      <select
        data-slot="native-select"
        className={cn(
          "h-9 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-paper py-1 pr-8 pl-2.5 text-sm text-ink transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

function NativeSelectOption(props: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup(props: React.ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-opt-group" {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };

import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils.js";

/**
 * The same spinning glyph `Button`'s `loading` state uses (`Loader2` +
 * `animate-spin`), vendored standalone for places that need a spinner without
 * a button around it — sized up and coloured to the app's action accent by
 * default, both overridable via `className`.
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("size-5 animate-spin text-action", className)}
      {...props}
    />
  );
}

export { Spinner };

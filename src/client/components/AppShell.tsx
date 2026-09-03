import type { ReactNode } from "react";
import type { Operator } from "../../shared/contracts/auth.js";
import { AppSidebar } from "./AppSidebar.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar.js";
import { TooltipProvider } from "./ui/tooltip.js";
import type { WorkspaceScreen } from "./workspace-screen.js";
import { runtimeState, type RuntimeMode } from "../../shared/runtime-mode.js";

export type { WorkspaceScreen };

const screenHeadingId: Record<WorkspaceScreen, string> = {
  "blog-post": "blog-post-heading",
  checker: "draft-checker-heading",
  "reference-documents": "writing-guides-heading",
  calibration: "calibration-heading",
};

function RuntimeModeBadge({ mode }: { mode: RuntimeMode }) {
  const runtime = runtimeState(mode);
  return (
    <span
      className={`border px-2 py-1 text-xs font-semibold ${runtime.mode === "production" ? "border-success/40 text-success" : "border-warning/40 text-warning"}`}
      role="status"
    >
      {runtime.label}
    </span>
  );
}

export function AppShell({
  active,
  onNavigate,
  operator,
  onSignOut,
  children,
  runtimeMode = "local",
}: {
  active: WorkspaceScreen;
  onNavigate: (screen: WorkspaceScreen) => void;
  operator: Operator;
  onSignOut: () => Promise<void>;
  children: ReactNode;
  runtimeMode?: RuntimeMode;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <AppSidebar
          active={active}
          onNavigate={onNavigate}
          operator={operator}
          onSignOut={onSignOut}
        />
        <SidebarInset aria-labelledby={screenHeadingId[active]}>
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-rule bg-paper/95 px-4 backdrop-blur-sm sm:px-6">
            <SidebarTrigger />
            <div className="ml-auto">
              <RuntimeModeBadge mode={runtimeMode} />
            </div>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

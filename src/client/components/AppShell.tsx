import type { ReactNode } from "react";
import type { Operator } from "../../shared/contracts/auth.js";
import { AppSidebar } from "./AppSidebar.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar.js";
import { TooltipProvider } from "./ui/tooltip.js";
import type { WorkspaceScreen } from "./workspace-screen.js";

export type { WorkspaceScreen };

const screenHeadingId: Record<WorkspaceScreen, string> = {
  "blog-post": "blog-post-heading",
  checker: "draft-checker-heading",
  "reference-documents": "writing-guides-heading",
  calibration: "calibration-heading",
};

export function AppShell({
  active,
  onNavigate,
  operator,
  onSignOut,
  children,
}: {
  active: WorkspaceScreen;
  onNavigate: (screen: WorkspaceScreen) => void;
  operator: Operator;
  onSignOut: () => Promise<void>;
  children: ReactNode;
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
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

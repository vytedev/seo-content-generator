import {
  BookOpen,
  ChevronsUpDown,
  CircleUserRound,
  FileCheck2,
  LogOut,
  SlidersHorizontal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import mobelarisLogoFull from "../assets/LOGO-MOBELARIS_Final.webp";
import mobelarisLogoMark from "../assets/Mobelaris-Logo-M.png";
import type { Operator } from "../../shared/contracts/auth.js";
import type { WorkspaceScreen } from "./workspace-screen.js";
import { cn } from "../lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar.js";

const workspaceDestinations: Array<{ id: WorkspaceScreen; label: string; icon: LucideIcon }> = [
  { id: "blog-post", label: "Blog post", icon: Workflow },
  { id: "reference-documents", label: "Writing guides", icon: BookOpen },
];

const toolsDestinations: Array<{ id: WorkspaceScreen; label: string; icon: LucideIcon }> = [
  { id: "checker", label: "Check a draft", icon: FileCheck2 },
  { id: "calibration", label: "Calibration", icon: SlidersHorizontal },
];

export function AppSidebar({
  active,
  onNavigate,
  operator,
  onSignOut,
}: {
  active: WorkspaceScreen;
  onNavigate: (screen: WorkspaceScreen) => void;
  operator: Operator;
  onSignOut: () => Promise<void>;
}) {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

  function handleNavigate(id: WorkspaceScreen) {
    onNavigate(id);
    if (isMobile) setOpenMobile(false);
  }

  function renderDestination(destination: {
    id: WorkspaceScreen;
    label: string;
    icon: LucideIcon;
  }) {
    const Icon = destination.icon;
    const isActive = active === destination.id;
    return (
      <SidebarMenuItem key={destination.id}>
        <SidebarMenuButton
          isActive={isActive}
          aria-current={isActive ? "page" : undefined}
          tooltip={destination.label}
          size={isMobile ? "lg" : "default"}
          onClick={() => handleNavigate(destination.id)}
        >
          <Icon aria-hidden="true" />
          <span>{destination.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div
          className={cn(
            "flex flex-col items-center gap-1 px-2 py-2 text-center",
            collapsed && "px-0",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-center border border-ink/70",
              collapsed ? "size-10 p-1" : "w-full max-w-[216px] px-3 py-2",
            )}
          >
            {collapsed ? (
              <img
                src={mobelarisLogoMark}
                alt="Mobelaris"
                width={225}
                height={215}
                className="size-8 object-contain"
              />
            ) : (
              <img
                src={mobelarisLogoFull}
                alt="Mobelaris"
                width={230}
                height={37}
                className="h-6 w-auto max-w-full object-contain"
              />
            )}
          </div>
          {collapsed ? (
            <span className="sr-only">SEO Production</span>
          ) : (
            <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
              SEO Production
            </span>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{workspaceDestinations.map(renderDestination)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{toolsDestinations.map(renderDestination)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarAccountMenu operator={operator} onSignOut={onSignOut} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarAccountMenu({
  operator,
  onSignOut,
}: {
  operator: Operator;
  onSignOut: () => Promise<void>;
}) {
  const { isMobile } = useSidebar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" tooltip={operator.display_name}>
          {/*
           * SidebarMenuButton applies an unguarded `[&_svg]:size-*` rule to
           * every descendant svg (no `:not([class*='size-'])` escape hatch,
           * unlike button.tsx/dropdown-menu.tsx), so a per-icon size class
           * here would be beaten by that higher-specificity descendant rule
           * and silently do nothing — both icons intentionally take the
           * button's own ambient icon size instead of one of their own.
           */}
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent">
            <CircleUserRound aria-hidden="true" />
          </span>
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate font-semibold">{operator.display_name}</span>
            <span className="truncate text-xs text-muted">{operator.account_type}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="ml-auto" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="min-w-56">
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-rule bg-subtle">
              <CircleUserRound aria-hidden="true" className="size-5" />
            </span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-semibold">{operator.display_name}</span>
              <span className="truncate text-xs text-muted">{operator.email}</span>
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void onSignOut()}>
          <LogOut aria-hidden="true" className="size-5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

export type SeverityLevel = "blocker" | "warning" | "info";

/** Icon + colour treatment for the blocker/warning/info severity concept, shared by every screen that shows findings. */
export const SEVERITY_META: Record<
  SeverityLevel,
  { label: string; icon: LucideIcon; badge: string; icon_tone: string }
> = {
  blocker: {
    label: "Blocker",
    icon: OctagonAlert,
    badge: "border-danger/30 bg-danger/10 text-danger",
    icon_tone: "text-danger",
  },
  warning: {
    label: "Warning",
    icon: TriangleAlert,
    badge: "border-warning/50 bg-warning/10 text-ink",
    icon_tone: "text-warning",
  },
  info: {
    label: "Info",
    icon: Info,
    badge: "border-info/30 bg-info/10 text-info",
    icon_tone: "text-info",
  },
};

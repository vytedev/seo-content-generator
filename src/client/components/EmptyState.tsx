import type { LucideIcon } from "lucide-react";

type Tone = "neutral" | "danger" | "success";

const TEXT_TONE: Record<Tone, string> = {
  neutral: "text-muted",
  danger: "text-danger",
  success: "text-success",
};

/** An icon-led status message for a nested slot that already has its own border (e.g. inside a results panel). */
export function EmptyState({
  icon: Icon,
  text,
  tone = "neutral",
  spin = false,
}: {
  icon: LucideIcon;
  text: string;
  tone?: Tone;
  spin?: boolean;
}) {
  return (
    <div
      className={`flex min-h-52 flex-col items-center justify-center gap-3 px-8 py-12 text-center ${TEXT_TONE[tone]}`}
    >
      <Icon aria-hidden="true" className={`size-6 ${spin ? "animate-spin" : ""}`} />
      <p className="max-w-md text-sm">{text}</p>
    </div>
  );
}

/** The same treatment, boxed with its own border — for a top-level, standalone status state. */
export function BoxedEmptyState(props: {
  icon: LucideIcon;
  text: string;
  tone?: Tone;
  spin?: boolean;
}) {
  return (
    <div className="border-y border-rule bg-paper">
      <EmptyState {...props} />
    </div>
  );
}

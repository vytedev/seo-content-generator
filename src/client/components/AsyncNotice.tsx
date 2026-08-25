export function AsyncNotice({
  message,
  tone = "neutral",
}: {
  message: string;
  tone?: "neutral" | "error" | "warning" | "success";
}) {
  const classes = {
    neutral: "border-rule bg-subtle text-muted",
    error: "border-danger/30 bg-danger/5 text-danger",
    warning: "border-warning/50 bg-warning/10 text-ink",
    success: "border-success/30 bg-success/10 text-ink",
  }[tone];
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`rounded-control border px-4 py-3 text-sm ${classes}`}
    >
      {message}
    </p>
  );
}

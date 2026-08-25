import type { ReactNode } from "react";

export function PageHeader({
  id,
  eyebrow,
  title,
  children,
  className = "mb-8 max-w-3xl",
}: {
  id: string;
  eyebrow: string;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`min-w-0 ${className}`}>
      <p className="mb-2 font-sans text-xs font-semibold tracking-[0.08em] text-action uppercase">
        {eyebrow}
      </p>
      <h1
        id={id}
        className="font-screen-title text-screen-title [overflow-wrap:anywhere] lg:text-screen-title-lg"
      >
        {title}
      </h1>
      <div className="mt-4 h-0.5 w-full bg-ink" aria-hidden="true" />
      {children && (
        <p className="mt-3 max-w-[70ch] [overflow-wrap:anywhere] text-muted">{children}</p>
      )}
    </header>
  );
}

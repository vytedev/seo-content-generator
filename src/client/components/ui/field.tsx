import * as React from "react";

import { cn } from "@/lib/utils.js";

type FieldOrientation = "vertical" | "horizontal" | "responsive";
type FieldErrorItem = { message?: string | null } | null | undefined;

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: FieldOrientation }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        "group/field grid min-w-0 gap-1.5 data-[invalid=true]:text-danger",
        orientation === "horizontal" &&
          "grid-cols-[minmax(0,0.4fr)_minmax(0,1fr)] items-start gap-x-4",
        orientation === "responsive" &&
          "sm:grid-cols-[minmax(0,0.4fr)_minmax(0,1fr)] sm:items-start sm:gap-x-4",
        className,
      )}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="field-content" className={cn("grid min-w-0 gap-1.5", className)} {...props} />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        "text-sm leading-5 font-semibold text-ink group-data-[invalid=true]/field:text-danger peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-xs leading-4 text-muted", className)}
      {...props}
    />
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & { errors?: FieldErrorItem[] }) {
  const messages = [
    ...(children ? [children] : []),
    ...[
      ...new Set(
        (errors ?? [])
          .map((error) => error?.message?.trim())
          .filter((message): message is string => Boolean(message)),
      ),
    ],
  ];
  if (!messages.length) return null;

  return (
    <div
      data-slot="field-error"
      className={cn("text-xs font-medium text-danger", className)}
      {...props}
    >
      {messages.length === 1 ? (
        messages[0]
      ) : (
        <ul className="ml-4 list-disc space-y-1">
          {messages.map((message, index) => (
            <li key={typeof message === "string" ? message : index}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("grid gap-5", className)} {...props} />;
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset data-slot="field-set" className={cn("min-w-0 border-0 p-0", className)} {...props} />
  );
}

function FieldLegend({ className, ...props }: React.ComponentProps<"legend">) {
  return (
    <legend
      data-slot="field-legend"
      className={cn("text-sm font-semibold text-ink", className)}
      {...props}
    />
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
};

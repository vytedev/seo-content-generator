import { type ReactNode, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";

export function TextField({
  label,
  value,
  onChange,
  multiline = false,
  mono = false,
  id: suppliedId,
  className,
  controlClassName,
  description,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  mono?: boolean;
  id?: string;
  className?: string;
  controlClassName?: string;
  description?: string;
  error?: string;
}) {
  const generatedId = useId();
  const id = suppliedId ?? `checker-${generatedId.replaceAll(":", "")}`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [description && descriptionId, error && errorId].filter(Boolean).join(" ");
  const controlClasses = [mono && "font-mono", controlClassName].filter(Boolean).join(" ");

  return (
    <Field className={className} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          id={id}
          className={controlClasses}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy || undefined}
          aria-invalid={Boolean(error)}
        />
      ) : (
        <Input
          id={id}
          className={controlClasses}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy || undefined}
          aria-invalid={Boolean(error)}
        />
      )}
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export function CountedField({
  label,
  value,
  onChange,
  max,
  multiline = false,
  multilineClassName,
  description,
  error,
  goodRange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  multiline?: boolean;
  multilineClassName?: string;
  description?: string;
  error?: string;
  /** Character count considered on-target — counter reads success in range, danger outside it. */
  goodRange?: [number, number];
}) {
  const generatedId = useId();
  const id = `checker-${generatedId.replaceAll(":", "")}`;
  const countId = `${id}-count`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [countId, description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(" ");
  const length = value.length;
  const inRange = goodRange ? length >= goodRange[0] && length <= goodRange[1] : false;
  const countTone = !length
    ? "text-muted"
    : !goodRange
      ? "text-muted"
      : inRange
        ? "text-success"
        : "text-danger";

  return (
    <Field data-invalid={Boolean(error)}>
      <div className="flex min-w-0 flex-wrap justify-between gap-x-2 gap-y-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <span
          id={countId}
          className={`font-mono text-xs font-normal tabular-nums ${countTone}`}
          aria-live="polite"
        >
          {length}/{max}
        </span>
      </div>
      {multiline ? (
        <Textarea
          id={id}
          className={multilineClassName}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
        />
      )}
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

/** A native, keyboard-operable disclosure for a progressive form section. */
export function RowEditor({
  title,
  addLabel,
  onAdd,
  children,
  bare = false,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
  /** Skip the built-in legend/header — for use inside an already-labelled disclosure. */
  bare?: boolean;
}) {
  if (bare) {
    return (
      <div>
        {children}
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onAdd}>
          + {addLabel}
        </Button>
      </div>
    );
  }
  return (
    <FieldSet className="mt-8">
      <div className="flex items-center justify-between border-b border-rule pb-2">
        <FieldLegend>{title}</FieldLegend>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          + {addLabel}
        </Button>
      </div>
      {children}
    </FieldSet>
  );
}

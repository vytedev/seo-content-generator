import { type FormEvent, useId, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, ClipboardList, Loader2 } from "lucide-react";
import type {
  CheckerInput,
  Finding,
  InternalLinkHierarchy,
} from "../../../shared/checker/index.js";
import { EmptyState } from "../../components/EmptyState.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";
import { apiFetch } from "../../lib/api.js";
import { Disclosure } from "../../components/Disclosure.js";
import { CountedField, RowEditor, TextField } from "./fields.js";

interface EditableImage {
  id: string;
  alt: string;
  filename: string;
}
interface EditableFaq {
  id: string;
  question: string;
  answer: string;
}
interface EditableLink {
  id: string;
  url: string;
  status: string;
  hierarchy: InternalLinkHierarchy;
}

type ValidationKey = "primaryKeyword" | "relatedKeywords" | "origins" | `link-${string}-status`;
type ValidationErrors = Partial<Record<ValidationKey, string>>;
let nextRowId = 0;
const createRowId = (kind: string) => `${kind}-${++nextRowId}`;

const hierarchyRanks: Record<InternalLinkHierarchy, number> = {
  collection: 1,
  designer_hub: 2,
  sub_collection: 3,
  product: 4,
  broad_category: 5,
  homepage: 6,
};
const hierarchyOptions: Array<{ value: InternalLinkHierarchy; label: string }> = [
  { value: "collection", label: "Collection" },
  { value: "designer_hub", label: "Designer hub" },
  { value: "sub_collection", label: "Sub-collection" },
  { value: "product", label: "Product" },
  { value: "broad_category", label: "Broad category" },
  { value: "homepage", label: "Homepage" },
];
const severityOrder: Finding["severity"][] = ["blocker", "warning", "info"];
const severityLabels = { blocker: "Blockers", warning: "Warnings", info: "Info" };
const severitySingular = { blocker: "Blocker", warning: "Warning", info: "Info" };
/** Dot colour for severity pills and per-finding badges — see .xevy/design.md §10, Status treatment. */
const SEVERITY_DOT: Record<Finding["severity"], string> = {
  blocker: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};

function severityCountLabel(severity: Finding["severity"], count: number): string {
  if (count === 1) return severitySingular[severity];
  return severityLabels[severity];
}

function growTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

export function DraftChecker() {
  const formId = useId().replaceAll(":", "");
  const [primaryKeyword, setPrimaryKeyword] = useState("");
  const [relatedKeywords, setRelatedKeywords] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [ogTitle, setOgTitle] = useState("");
  const [ogDescription, setOgDescription] = useState("");
  const [slug, setSlug] = useState("");
  const [images, setImages] = useState<EditableImage[]>(() => [
    { id: createRowId("image"), alt: "", filename: "" },
  ]);
  const [faqs, setFaqs] = useState<EditableFaq[]>(() => [
    { id: createRowId("faq"), question: "", answer: "" },
  ]);
  const [origins, setOrigins] = useState("https://www.mobelaris.com");
  const [links, setLinks] = useState<EditableLink[]>(() => [
    { id: createRowId("link"), url: "", status: "200", hierarchy: "collection" },
  ]);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("Checks have not been run.");
  const [validation, setValidation] = useState<ValidationErrors>({});

  const groups = useMemo(
    () =>
      severityOrder.map((severity) => ({
        severity,
        findings: findings?.filter((finding) => finding.severity === severity) ?? [],
      })),
    [findings],
  );
  const orderedFindings = useMemo(() => groups.flatMap((group) => group.findings), [groups]);

  const updateImage = (index: number, field: "alt" | "filename", value: string) =>
    setImages((current) =>
      current.map((image, itemIndex) =>
        itemIndex === index ? { ...image, [field]: value } : image,
      ),
    );
  const updateFaq = (index: number, field: "question" | "answer", value: string) =>
    setFaqs((current) =>
      current.map((faq, itemIndex) => (itemIndex === index ? { ...faq, [field]: value } : faq)),
    );
  const updateLink = <K extends "url" | "status" | "hierarchy">(
    index: number,
    field: K,
    value: EditableLink[K],
  ) =>
    setLinks((current) =>
      current.map((link, itemIndex) => (itemIndex === index ? { ...link, [field]: value } : link)),
    );

  async function runChecks(event: FormEvent) {
    event.preventDefault();
    const errors: ValidationErrors = {};
    if (!primaryKeyword.trim()) errors.primaryKeyword = "Enter a primary keyword.";
    const related = relatedKeywords
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!related.length) errors.relatedKeywords = "Enter at least one related keyword.";
    const internalOrigins = origins
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!internalOrigins.length) errors.origins = "Enter at least one internal origin.";
    const shortlist = links.filter((link) => link.url.trim());
    shortlist.forEach((link) => {
      if (!/^\d{3}$/.test(link.status))
        errors[`link-${link.id}-status`] = "Enter a three-digit HTTP status.";
    });
    const errorCount = Object.keys(errors).length;
    if (errorCount) {
      setValidation(errors);
      setState("error");
      setMessage(
        `Checks not run. ${errorCount} input ${errorCount === 1 ? "needs" : "inputs need"} attention.`,
      );
      return;
    }

    setValidation({});
    setState("loading");
    setMessage("Running deterministic checks…");
    const payload: CheckerInput = {
      primary_keyword: primaryKeyword.trim(),
      related_keywords: related,
      body_markdown: bodyMarkdown,
      on_page: {
        meta_title: metaTitle,
        meta_description: metaDescription,
        og_title: ogTitle,
        og_description: ogDescription,
        slug,
        images: images.map(({ alt, filename }) => ({ alt, filename })),
        faqs: faqs.map(({ question, answer }) => ({ question, answer })),
      },
      internal_origins: internalOrigins,
      verified_internal_links: shortlist.map((link) => ({
        url: link.url.trim(),
        status: Number(link.status),
        hierarchy: link.hierarchy,
        hierarchy_rank: hierarchyRanks[link.hierarchy],
      })),
    };

    try {
      const response = await apiFetch("/api/checker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        findings?: Finding[];
        error?: { message?: string; details?: Array<{ path: string; message: string }> };
      };
      if (!response.ok || !result.findings) {
        if (result.error?.details)
          setValidation(
            Object.fromEntries(
              result.error.details.map((detail, index) => [
                `server-${index}`,
                `${detail.path || "Input"}: ${detail.message}`,
              ]),
            ) as ValidationErrors,
          );
        throw new Error(result.error?.message ?? "The checker could not be completed.");
      }
      setFindings(result.findings);
      setState("success");
      setMessage(
        result.findings.length
          ? `Checks complete. ${result.findings.length} ${result.findings.length === 1 ? "finding" : "findings"}.`
          : "Checks complete. No findings.",
      );
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The checker could not be completed.");
    }
  }

  return (
    <div className="min-w-0 flex-1 px-4 py-8 sm:px-6 xl:px-8">
      <PageHeader id="draft-checker-heading" eyebrow="Deterministic checks" title="Check a draft">
        Validate a working draft against the same rules without starting a production run. Findings
        identify issues only — your prose is never rewritten.
      </PageHeader>

      <form onSubmit={runChecks} noValidate>
        {Object.keys(validation).length > 0 && (
          <section
            aria-labelledby="validation-heading"
            role="alert"
            className="mb-6 rounded-group border border-danger/40 bg-danger/5 p-4"
          >
            <h2 id="validation-heading" className="text-h2 font-semibold text-danger">
              Review the checker input
            </h2>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {Object.entries(validation).map(([key, error]) => (
                <li key={key}>
                  {fieldIdForValidation(formId, key) ? (
                    <a
                      className="underline underline-offset-2"
                      href={`#${fieldIdForValidation(formId, key)}`}
                    >
                      {error}
                    </a>
                  ) : (
                    error
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.62fr)]">
          <div className="rounded-group border border-rule bg-paper p-4 sm:p-6">
            <CountedField
              label="Meta title"
              value={metaTitle}
              onChange={setMetaTitle}
              max={60}
              goodRange={[55, 60]}
            />
            <div className="mt-4">
              <CountedField
                label="Meta description"
                value={metaDescription}
                onChange={setMetaDescription}
                max={155}
                multiline
                multilineClassName="min-h-24"
                description="Summarise the draft for search results in 150–155 characters."
                goodRange={[150, 155]}
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(validation.primaryKeyword)}>
                <FieldLabel htmlFor={`${formId}-primary-keyword`}>
                  Primary keyword <span className="text-danger">*</span>
                </FieldLabel>
                <Input
                  id={`${formId}-primary-keyword`}
                  value={primaryKeyword}
                  onChange={(event) => setPrimaryKeyword(event.target.value)}
                  required
                  aria-invalid={Boolean(validation.primaryKeyword)}
                  aria-describedby={
                    validation.primaryKeyword ? `${formId}-primary-keyword-error` : undefined
                  }
                />
                <FieldError id={`${formId}-primary-keyword-error`}>
                  {validation.primaryKeyword}
                </FieldError>
              </Field>
              <Field data-invalid={Boolean(validation.relatedKeywords)}>
                <FieldLabel htmlFor={`${formId}-related-keywords`}>
                  Related keywords <span className="text-danger">*</span>
                </FieldLabel>
                <Input
                  id={`${formId}-related-keywords`}
                  value={relatedKeywords}
                  onChange={(event) => setRelatedKeywords(event.target.value)}
                  placeholder="e.g. modern chair, oak furniture"
                  required
                  aria-invalid={Boolean(validation.relatedKeywords)}
                  aria-describedby={
                    validation.relatedKeywords ? `${formId}-related-keywords-error` : undefined
                  }
                />
                <FieldError id={`${formId}-related-keywords-error`}>
                  {validation.relatedKeywords}
                </FieldError>
              </Field>
            </div>

            <Field className="mt-4">
              <FieldLabel htmlFor={`${formId}-draft-markdown`}>Body markdown</FieldLabel>
              <Textarea
                id={`${formId}-draft-markdown`}
                className="min-h-[14rem] resize-y font-mono leading-6 lg:min-h-[18rem]"
                value={bodyMarkdown}
                onChange={(event) => setBodyMarkdown(event.target.value)}
                onInput={(event) => growTextarea(event.currentTarget)}
                placeholder="# Draft title"
                aria-describedby={`${formId}-draft-markdown-description`}
                spellCheck
              />
              <FieldDescription id={`${formId}-draft-markdown-description`}>
                Paste the complete article in Markdown. The checker reads it without rewriting it.
              </FieldDescription>
              <FieldError />
            </Field>

            <div className="mt-6 border-t border-rule">
              <p className="pt-4 text-sm text-muted">
                Optional details — add these for a complete check.
              </p>
              <Disclosure title="More on-page elements">
                <div
                  data-testid="on-page-elements-grid"
                  className="grid min-w-0 items-start gap-x-4 gap-y-5 md:grid-cols-2"
                >
                  <TextField label="OG title" value={ogTitle} onChange={setOgTitle} />
                  <TextField
                    label="OG description"
                    value={ogDescription}
                    onChange={setOgDescription}
                    multiline
                    controlClassName="min-h-24"
                  />
                  <TextField
                    label="Slug"
                    value={slug}
                    onChange={setSlug}
                    mono
                    className="md:col-span-2"
                  />
                </div>
              </Disclosure>

              <Disclosure title="Images" count={images.length}>
                <RowEditor
                  bare
                  title="Images"
                  addLabel="Add image"
                  onAdd={() =>
                    setImages((current) => [
                      ...current,
                      { id: createRowId("image"), alt: "", filename: "" },
                    ])
                  }
                >
                  {images.map((image, index) => (
                    <div
                      key={image.id}
                      className="grid gap-3 border-b border-rule py-4 sm:grid-cols-2 first:pt-0"
                    >
                      <TextField
                        label={`Image ${index + 1} alt text`}
                        id={`${formId}-${image.id}-alt`}
                        value={image.alt}
                        onChange={(value) => updateImage(index, "alt", value)}
                      />
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <TextField
                            label="Filename"
                            id={`${formId}-${image.id}-filename`}
                            value={image.filename}
                            onChange={(value) => updateImage(index, "filename", value)}
                            mono
                          />
                        </div>
                        {images.length > 1 && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() =>
                              setImages((current) => current.filter((_, i) => i !== index))
                            }
                            aria-label={`Remove image ${index + 1}`}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </RowEditor>
              </Disclosure>

              <Disclosure title="FAQs" count={faqs.length}>
                <RowEditor
                  bare
                  title="FAQs"
                  addLabel="Add FAQ"
                  onAdd={() =>
                    setFaqs((current) => [
                      ...current,
                      { id: createRowId("faq"), question: "", answer: "" },
                    ])
                  }
                >
                  {faqs.map((faq, index) => (
                    <div key={faq.id} className="border-b border-rule py-4 first:pt-0">
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <TextField
                            label={`FAQ ${index + 1} question`}
                            id={`${formId}-${faq.id}-question`}
                            value={faq.question}
                            onChange={(value) => updateFaq(index, "question", value)}
                          />
                        </div>
                        {faqs.length > 1 && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() =>
                              setFaqs((current) => current.filter((_, i) => i !== index))
                            }
                            aria-label={`Remove FAQ ${index + 1}`}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                      <FaqAnswerField
                        id={`${formId}-${faq.id}-answer`}
                        value={faq.answer}
                        onChange={(value) => updateFaq(index, "answer", value)}
                      />
                    </div>
                  ))}
                </RowEditor>
              </Disclosure>

              <Disclosure title="Internal links" count={links.length}>
                <Field data-invalid={Boolean(validation.origins)}>
                  <FieldLabel htmlFor={`${formId}-origins`}>
                    Authoritative origins <span className="text-danger">*</span>
                  </FieldLabel>
                  <Textarea
                    id={`${formId}-origins`}
                    className="font-mono"
                    value={origins}
                    onChange={(event) => setOrigins(event.target.value)}
                    aria-invalid={Boolean(validation.origins)}
                    aria-describedby={`${formId}-origins-help${validation.origins ? ` ${formId}-origins-error` : ""}`}
                  />
                  <FieldDescription id={`${formId}-origins-help`}>
                    One exact HTTP(S) origin per line; do not include paths.
                  </FieldDescription>
                  <FieldError id={`${formId}-origins-error`}>{validation.origins}</FieldError>
                </Field>
                <RowEditor
                  bare
                  title="Internal links"
                  addLabel="Add link"
                  onAdd={() =>
                    setLinks((current) => [
                      ...current,
                      {
                        id: createRowId("link"),
                        url: "",
                        status: "200",
                        hierarchy: "collection",
                      },
                    ])
                  }
                >
                  {links.map((link, index) => (
                    <div
                      key={link.id}
                      className="mt-4 grid gap-3 border-b border-rule py-4 sm:grid-cols-[minmax(0,1fr)_96px_160px_auto]"
                    >
                      <TextField
                        label={`Entry ${index + 1} URL`}
                        id={`${formId}-${link.id}-url`}
                        value={link.url}
                        onChange={(value) => updateLink(index, "url", value)}
                        mono
                      />
                      <ValidatedStatusField
                        id={`${formId}-${link.id}-status`}
                        value={link.status}
                        error={validation[`link-${link.id}-status`]}
                        onChange={(value) => updateLink(index, "status", value)}
                      />
                      <HierarchyField
                        id={`${formId}-${link.id}-hierarchy`}
                        value={link.hierarchy}
                        onChange={(value) => updateLink(index, "hierarchy", value)}
                      />
                      {links.length > 1 && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="self-end"
                          onClick={() =>
                            setLinks((current) => current.filter((_, i) => i !== index))
                          }
                          aria-label={`Remove link ${index + 1}`}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                </RowEditor>
              </Disclosure>
            </div>

            <Button
              type="submit"
              className="mt-6 w-full sm:w-auto"
              disabled={state === "loading"}
              loading={state === "loading"}
            >
              {state === "loading" ? "Running checks…" : "Run checks →"}
            </Button>
          </div>

          <aside className="xl:sticky xl:top-20" aria-labelledby="results-heading">
            <div className="rounded-group border border-rule bg-paper">
              <div className="border-b border-rule p-4">
                <h2 id="results-heading" className="text-h2 font-semibold">
                  Results
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Deterministic findings from the supplied draft.
                </p>
                {findings && findings.length > 0 && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {groups
                      .filter(({ findings: severityFindings }) => severityFindings.length > 0)
                      .map(({ severity, findings: severityFindings }) => (
                        <span key={severity} className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={`size-1.5 shrink-0 rounded-full ${SEVERITY_DOT[severity]}`}
                          />
                          <span className="font-semibold text-ink">
                            {severityFindings.length}{" "}
                            {severityCountLabel(severity, severityFindings.length)}
                          </span>
                        </span>
                      ))}
                  </p>
                )}
              </div>

              <div className="min-h-52" aria-busy={state === "loading"} aria-live="polite">
                {state === "idle" && (
                  <EmptyState
                    icon={ClipboardList}
                    text="Run checks to see structured findings here."
                  />
                )}
                {state === "loading" && <EmptyState icon={Loader2} spin text="Running checks…" />}
                {state === "error" && findings === null && (
                  <EmptyState
                    icon={CircleAlert}
                    tone="danger"
                    text="Checks could not be completed. Review the message and try again."
                  />
                )}
                {state === "success" && findings?.length === 0 && (
                  <EmptyState
                    icon={CircleCheck}
                    tone="success"
                    text="No findings — the draft passed every check."
                  />
                )}
                {orderedFindings.length > 0 && (
                  <ul>
                    {orderedFindings.map((finding) => (
                      <FindingRow key={finding.id} finding={finding} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </aside>
        </div>
      </form>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
    </div>
  );
}

function FaqAnswerField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field className="mt-3">
      <FieldLabel htmlFor={id}>Answer</FieldLabel>
      <Textarea
        id={id}
        className="min-h-24"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function HierarchyField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: InternalLinkHierarchy;
  onChange: (value: InternalLinkHierarchy) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Hierarchy</FieldLabel>
      <Select
        value={value}
        onValueChange={(selected) => onChange(selected as InternalLinkHierarchy)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose hierarchy" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {hierarchyOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ValidatedStatusField({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>Status</FieldLabel>
      <Input
        id={id}
        className="font-mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function fieldIdForValidation(formId: string, key: string) {
  if (key === "primaryKeyword") return `${formId}-primary-keyword`;
  if (key === "relatedKeywords") return `${formId}-related-keywords`;
  if (key === "origins") return `${formId}-origins`;
  if (key.startsWith("link-") && key.endsWith("-status")) return `${formId}-${key.slice(5)}`;
  return null;
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <li className="border-b border-rule px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-muted">{finding.rule}</code>
        <span className="flex items-center gap-1 text-xs font-semibold text-ink">
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${SEVERITY_DOT[finding.severity]}`}
          />
          {severitySingular[finding.severity]}
        </span>
        {finding.provisional && (
          <span className="text-xs font-semibold text-warning">Provisional</span>
        )}
      </div>
      <p className="mt-2 text-sm font-medium">{finding.issue}</p>
      <p className="mt-1 text-sm text-muted">{finding.suggested_fix}</p>
    </li>
  );
}

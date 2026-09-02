import { useEffect, useId, useMemo, useState } from "react";
import { CircleAlert, ClipboardList, FilterX, Inbox } from "lucide-react";
import type { FindingRecord } from "../../../shared/milestone-three.js";
import { BoxedEmptyState, EmptyState } from "../../components/EmptyState.js";
import { SEVERITY_META } from "../../components/severity.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Textarea } from "../../components/ui/textarea.js";
import { apiFetch } from "../../lib/api.js";
import {
  findingCategoryLabel,
  isFindingCategory,
  type FindingCategory,
} from "./finding-category-labels.js";

type LoadState = "idle" | "loading" | "success" | "error";
type Decision = "accepted" | "rejected";

/**
 * Re-reads the server's recorded dispositions after a 409, to tell a harmless
 * duplicate submit (already saved) from a real conflict. Returns a map of
 * finding id → recorded decision; an empty map on any fetch failure, so the
 * caller falls back to showing the original conflict error.
 */
async function fetchAuthoritativeFindings(runId: string): Promise<FindingRecord[] | null> {
  try {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/findings`);
    const result = (await response.json()) as { findings?: FindingRecord[] } | unknown;
    if (!response.ok || !("findings" in Object(result))) return null;
    return (result as { findings?: FindingRecord[] }).findings ?? [];
  } catch {
    return null;
  }
}
type DispositionFilter = "all" | "pending" | Decision;
type SeverityFilter = "all" | FindingRecord["severity"];
type CategoryFilter = "all" | FindingCategory;

interface StagedDecision {
  decision: Decision;
  rationale: string;
}

const severityOrder: FindingRecord["severity"][] = ["blocker", "warning", "info"];
const severityLabels = { blocker: "Blockers", warning: "Warnings", info: "Information" };
const SEVERITY_DOT: Record<FindingRecord["severity"], string> = {
  blocker: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};
const STEP_NUMBER: Partial<Record<FindingRecord["step"], string>> = {
  automated_checks: "1.4",
  review_writing_style: "1.5",
  review_information_gain: "1.6",
  review_fact_checking: "1.7",
  review_link_conversion: "1.8",
};
function stepNumber(step: FindingRecord["step"]): string {
  return STEP_NUMBER[step] ?? step;
}

function errorMessage(value: unknown, fallback: string) {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = value.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      return String(error.message);
    }
  }
  return fallback;
}

export function FindingsReview({
  runId,
  onSubmitted,
}: {
  /** The focused article; findings load automatically for it. */
  runId: string;
  /** Notified after a successful disposition submission. */
  onSubmitted?: () => void;
}) {
  const formId = useId().replaceAll(":", "");
  const [loadedRunId, setLoadedRunId] = useState("");
  const [findings, setFindings] = useState<FindingRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<Record<string, StagedDecision>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("Loading findings for this blog post…");
  const [submitError, setSubmitError] = useState("");

  const categories = useMemo(
    () => [...new Set(findings.map((finding) => finding.category as FindingCategory))].sort(),
    [findings],
  );
  const visible = useMemo(
    () =>
      findings.filter((finding) => {
        const effectiveDisposition =
          staged[finding.id]?.decision ?? finding.disposition ?? "pending";
        return (
          (severity === "all" || finding.severity === severity) &&
          (category === "all" || finding.category === category) &&
          (disposition === "all" || effectiveDisposition === disposition)
        );
      }),
    [category, disposition, findings, severity, staged],
  );
  const grouped = useMemo(
    () =>
      severityOrder
        .map((level) => ({
          severity: level,
          categories: categories
            .map((name) => ({
              name,
              findings: visible.filter(
                (finding) => finding.severity === level && finding.category === name,
              ),
            }))
            .filter((group) => group.findings.length),
        }))
        .filter((group) => group.categories.length),
    [categories, visible],
  );
  const selectableVisible = visible.filter((finding) => finding.disposition === null);
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((finding) => selected.has(finding.id));
  const stagedEntries = Object.entries(staged);
  const stagedCount = stagedEntries.length;
  const filtersActive = severity !== "all" || category !== "all" || disposition !== "all";

  useEffect(() => {
    void loadFindingsFor(runId);
  }, [runId]);

  async function loadFindingsFor(cleanRunId: string) {
    setLoadState("loading");
    setNotice("Loading findings for that blog post…");
    setSubmitError("");
    try {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(cleanRunId)}/findings`);
      const result = (await response.json()) as { findings?: FindingRecord[] } | unknown;
      if (
        !response.ok ||
        !("findings" in Object(result)) ||
        !Array.isArray((result as { findings?: unknown }).findings)
      ) {
        throw new Error(errorMessage(result, "Findings could not be loaded."));
      }
      const loaded = (result as { findings: FindingRecord[] }).findings;
      if (loaded.some((finding) => !isFindingCategory(finding.category)))
        throw new Error("A finding category has no approved operator-facing label.");
      setFindings(loaded);
      setLoadedRunId(cleanRunId);
      setSelected(new Set());
      setStaged({});
      setSeverity("all");
      setCategory("all");
      setDisposition("all");
      setLoadState("success");
      setNotice(
        loaded.length
          ? `${loaded.length} ${loaded.length === 1 ? "finding" : "findings"} loaded.`
          : "No findings were returned for this blog post.",
      );
    } catch (error) {
      setFindings([]);
      setLoadedRunId("");
      setLoadState("error");
      const message = error instanceof Error ? error.message : "Findings could not be loaded.";
      setNotice(message);
    }
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableVisible.forEach((finding) => next.delete(finding.id));
      else selectableVisible.forEach((finding) => next.add(finding.id));
      return next;
    });
  }

  function stageOne(id: string, decision: Decision) {
    setStaged((current) => ({
      ...current,
      [id]: { decision, rationale: current[id]?.rationale ?? "" },
    }));
  }

  function acceptAllPending() {
    setStaged((current) => {
      const next = { ...current };
      findings.forEach((finding) => {
        if (finding.disposition === null && !next[finding.id])
          next[finding.id] = { decision: "accepted", rationale: "" };
      });
      return next;
    });
    setSubmitError("");
    setNotice("All pending findings marked accepted. Reject exceptions before submitting.");
  }

  function undoStaged() {
    setStaged({});
    setNotice("Staged decisions cleared. Recorded decisions were not changed.");
  }

  function stageSelected(decision: Decision) {
    if (!selected.size) return;
    setStaged((current) => {
      const next = { ...current };
      selected.forEach((id) => {
        if (findings.some((finding) => finding.id === id && finding.disposition === null))
          next[id] = { decision, rationale: next[id]?.rationale ?? "" };
      });
      return next;
    });
    setSubmitError("");
    const count = `${selected.size} selected ${selected.size === 1 ? "finding" : "findings"}`;
    setNotice(`${count} marked ${decision}. Submit to confirm.`);
  }

  async function submitDecisions() {
    const documentVersionId = findings[0]?.document_version_id;
    const entries = findings
      .filter((finding) => finding.disposition === null)
      .map((finding) => [finding.id, staged[finding.id]] as const)
      .filter((entry): entry is readonly [string, StagedDecision] => Boolean(entry[1]));
    if (!entries.length || !loadedRunId || !documentVersionId || effectivePendingCount > 0) return;
    setSubmitting(true);
    setSubmitError("");
    setNotice(`Submitting ${entries.length} ${entries.length === 1 ? "decision" : "decisions"}…`);
    try {
      const response = await apiFetch(
        `/api/runs/${encodeURIComponent(loadedRunId)}/findings/dispositions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_version_id: documentVersionId,
            idempotency_key: `findings-${loadedRunId}-${documentVersionId}`,
            dispositions: entries.map(([findingId, value]) => {
              const rationale = value.rationale.trim();
              return {
                finding_id: findingId,
                decision: value.decision,
                ...(rationale ? { rationale } : {}),
              };
            }),
          }),
        },
      );
      const result = (await response.json()) as { submitted?: number } | unknown;
      if (!response.ok) {
        // A 409 here usually means the decisions were already recorded — e.g. a
        // duplicate submit or a refresh race. Re-read the server state: when every
        // staged finding already has the same recorded disposition, treat it as a
        // successful replay rather than surfacing a conflict to the operator.
        if (response.status === 409) {
          const authoritative = await fetchAuthoritativeFindings(loadedRunId);
          const recorded = new Map(authoritative?.map((finding) => [finding.id, finding]));
          const alreadySaved = entries.every(([findingId, value]) => {
            const saved = recorded.get(findingId);
            return (
              saved?.disposition === value.decision &&
              (saved.rationale ?? "") === value.rationale.trim()
            );
          });
          if (alreadySaved && entries.length > 0 && authoritative) {
            setFindings(authoritative);
            setSelected(new Set());
            setStaged({});
            onSubmitted?.();
            setNotice(
              `These ${entries.length} ${entries.length === 1 ? "decision" : "decisions"} were already saved. Accepted findings are queued for the later controlled revision step.`,
            );
            return;
          }
        }
        throw new Error(errorMessage(result, "Decisions could not be submitted."));
      }
      const authoritative = await fetchAuthoritativeFindings(loadedRunId);
      if (!authoritative)
        throw new Error("Decisions were saved, but the recorded findings could not be reloaded.");
      setFindings(authoritative);
      setSelected(new Set());
      setStaged({});
      onSubmitted?.();
      setNotice(
        `${entries.length} ${entries.length === 1 ? "decision" : "decisions"} saved. Accepted findings are queued for the later controlled revision step.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Decisions could not be submitted.";
      setSubmitError(message);
      setNotice(message);
    } finally {
      setSubmitting(false);
    }
  }

  const pendingCount = findings.filter((finding) => !finding.disposition).length;
  const effectivePendingCount = findings.filter(
    (finding) => finding.disposition === null && !staged[finding.id]?.decision,
  ).length;
  const acceptedCount = findings.filter(
    (finding) => (staged[finding.id]?.decision ?? finding.disposition) === "accepted",
  ).length;
  const rejectedCount = findings.filter(
    (finding) => (staged[finding.id]?.decision ?? finding.disposition) === "rejected",
  ).length;

  return (
    <div className="min-w-0 max-w-full flex-1">
      {loadState === "success" && findings.length > 0 && (
        <>
          <p className="mb-6 max-w-[70ch] text-muted">
            {pendingCount === 0
              ? "All findings have a recorded disposition."
              : `${pendingCount} ${pendingCount === 1 ? "finding needs" : "findings need"} a recorded disposition before the revision pass can continue.`}
          </p>

          <SeverityStatRow findings={findings} pendingCount={pendingCount} />

          <div className="mb-6 min-w-0 max-w-full border-y border-rule bg-paper">
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-rule px-4 py-3">
              <Filter
                label="Severity"
                value={severity}
                onChange={(value) => setSeverity(value as SeverityFilter)}
                options={[
                  { value: "all", label: "All severities" },
                  { value: "blocker", label: "Blocker" },
                  { value: "warning", label: "Warning" },
                  { value: "info", label: "Information" },
                ]}
              />
              <Filter
                label="Category"
                value={category}
                onChange={(value) => setCategory(value as CategoryFilter)}
                options={[
                  { value: "all", label: "All categories" },
                  ...categories.map((option) => ({
                    value: option,
                    label: findingCategoryLabel(option),
                  })),
                ]}
              />
              <Filter
                label="Disposition"
                value={disposition}
                onChange={(value) => setDisposition(value as DispositionFilter)}
                options={[
                  { value: "all", label: "All dispositions" },
                  { value: "pending", label: "Pending" },
                  { value: "accepted", label: "Accepted" },
                  { value: "rejected", label: "Rejected" },
                ]}
              />
              <span className="ml-auto text-sm tabular-nums text-muted">
                {visible.length} of {findings.length} shown
              </span>
            </div>

            {visible.length === 0 ? (
              <EmptyState
                icon={FilterX}
                text={
                  filtersActive
                    ? "No findings match these filters. Try clearing one of them."
                    : "No findings match right now."
                }
              />
            ) : (
              grouped.map((severityGroup) => {
                const meta = SEVERITY_META[severityGroup.severity];
                return (
                  <section
                    key={severityGroup.severity}
                    aria-labelledby={`review-${severityGroup.severity}`}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-rule bg-subtle px-4 py-2">
                      <h2
                        id={`review-${severityGroup.severity}`}
                        className="flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere] text-sm font-semibold"
                      >
                        <meta.icon aria-hidden="true" className={`size-4 ${meta.icon_tone}`} />
                        {severityLabels[severityGroup.severity]}
                      </h2>
                      <span className="font-mono text-xs tabular-nums text-muted">
                        {severityGroup.categories.reduce(
                          (total, group) => total + group.findings.length,
                          0,
                        )}
                      </span>
                    </div>
                    {severityGroup.categories.map((categoryGroup) => (
                      <section
                        key={categoryGroup.name}
                        aria-labelledby={`category-${severityGroup.severity}-${categoryGroup.name.replaceAll(" ", "-")}`}
                      >
                        <h3
                          id={`category-${severityGroup.severity}-${categoryGroup.name.replaceAll(" ", "-")}`}
                          className="min-w-0 [overflow-wrap:anywhere] border-b border-rule px-4 py-2 text-xs font-semibold tracking-[0.08em] text-muted"
                        >
                          {findingCategoryLabel(categoryGroup.name)}
                        </h3>
                        <ul>
                          {categoryGroup.findings.map((finding) => (
                            <ReviewRow
                              key={finding.id}
                              finding={finding}
                              selected={selected.has(finding.id)}
                              staged={staged[finding.id]}
                              onSelect={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(finding.id);
                                  else next.delete(finding.id);
                                  return next;
                                })
                              }
                              onDecision={(decision) => stageOne(finding.id, decision)}
                              onRationale={(rationale) =>
                                setStaged((current) => {
                                  const decision = current[finding.id]?.decision;
                                  if (!decision) return current;
                                  return { ...current, [finding.id]: { decision, rationale } };
                                })
                              }
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </section>
                );
              })
            )}
          </div>

          <div className="sticky bottom-0 z-10 mt-6 min-w-0 max-w-full border border-rule bg-paper/95 px-4 py-3 shadow-[0_-4px_18px_oklch(0.22_0.015_55/0.08)] backdrop-blur-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-sm tabular-nums text-muted">
                {effectivePendingCount} pending · {acceptedCount} accepted · {rejectedCount}{" "}
                rejected
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={!visible.length || submitting}
                onClick={toggleVisible}
                aria-pressed={allVisibleSelected}
              >
                {allVisibleSelected ? "Deselect all visible" : "Select all visible"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pendingCount === 0 || submitting}
                onClick={acceptAllPending}
              >
                Accept all pending
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!selected.size || submitting}
                onClick={() => stageSelected("accepted")}
              >
                Accept selected
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!selected.size || submitting}
                onClick={() => stageSelected("rejected")}
              >
                Reject selected
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!stagedCount || submitting}
                onClick={undoStaged}
              >
                Undo staged
              </Button>
              <Button
                type="button"
                disabled={!stagedCount || effectivePendingCount > 0 || submitting}
                loading={submitting}
                onClick={submitDecisions}
              >
                {submitting ? "Submitting…" : "Submit decisions →"}
              </Button>
            </div>
            {submitError && <p className="mt-2 text-sm font-medium text-danger">{submitError}</p>}
          </div>
        </>
      )}

      {loadState === "idle" && (
        <BoxedEmptyState
          icon={ClipboardList}
          text="Loading structured findings for this blog post…"
        />
      )}
      {loadState === "loading" && <FindingsSkeleton />}
      {loadState === "error" && <BoxedEmptyState icon={CircleAlert} text={notice} tone="danger" />}
      {loadState === "success" && findings.length === 0 && (
        <BoxedEmptyState icon={Inbox} text="No findings were returned for this blog post." />
      )}
      <p
        id={`${formId}-status`}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {notice}
      </p>
    </div>
  );
}

/** A compact severity breakdown — one restrained stat per level, not a KPI card. */
function SeverityStatRow({
  findings,
  pendingCount,
}: {
  findings: FindingRecord[];
  pendingCount: number;
}) {
  const total = findings.length;
  const counts = severityOrder.map((level) => ({
    level,
    count: findings.filter((finding) => finding.severity === level).length,
  }));

  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-y border-rule py-4">
      <div className="flex divide-x divide-rule">
        {counts.map(({ level, count }) => {
          const meta = SEVERITY_META[level];
          return (
            <div key={level} className="px-4 first:pl-0">
              <p className={`text-h2 font-semibold tabular-nums ${meta.icon_tone}`}>{count}</p>
              <p className="mt-1 text-xs text-muted">{severityLabels[level]}</p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        <span className="tabular-nums text-ink">{total}</span>{" "}
        {total === 1 ? "finding" : "findings"} ·{" "}
        <span className="tabular-nums text-ink">{pendingCount}</span> require a response
      </p>
    </div>
  );
}

/** Shaped like the stat row + toolbar + grouped rows below, so real findings settle into place without a layout jump. */
function FindingsSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="mb-6 flex items-start justify-between gap-4 border-y border-rule py-4">
        <div className="flex divide-x divide-rule">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-1.5 px-4 first:pl-0">
              <Skeleton className="h-7 w-6" />
              <Skeleton className="h-3 w-14" />
            </div>
          ))}
        </div>
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="border-y border-rule bg-paper">
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-24" />
          ))}
        </div>
        {Array.from({ length: 2 }, (_, groupIndex) => (
          <div key={groupIndex}>
            <div className="flex items-center justify-between border-b border-rule bg-subtle px-4 py-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-6" />
            </div>
            {Array.from({ length: 2 }, (_, rowIndex) => (
              <div
                key={rowIndex}
                className="grid min-h-52 grid-cols-[24px_minmax(0,1fr)] gap-3 border-b border-rule px-4 py-4 sm:grid-cols-[24px_minmax(0,1fr)_210px]"
              >
                <Skeleton className="mt-1 size-4" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
                <div className="hidden space-y-2 sm:block">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const generatedId = useId().replaceAll(":", "");
  const id = `findings-filter-${generatedId}`;

  return (
    <Field className="w-auto min-w-0 gap-0">
      <FieldLabel htmlFor={id} className="sr-only">
        {label}
      </FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          size="sm"
          className="w-auto max-w-full min-w-32 text-xs font-semibold"
        >
          <SelectValue placeholder={`Choose ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
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

function ReviewRow({
  finding,
  selected,
  staged,
  onSelect,
  onDecision,
  onRationale,
}: {
  finding: FindingRecord;
  selected: boolean;
  staged: StagedDecision | undefined;
  onSelect: (checked: boolean) => void;
  onDecision: (decision: Decision) => void;
  onRationale: (value: string) => void;
}) {
  const generatedId = useId().replaceAll(":", "");
  const rationaleId = `finding-rationale-${generatedId}`;
  const hardFlag = finding.hard_flag;
  const readOnly = finding.disposition !== null;
  const decision = staged?.decision ?? finding.disposition;
  const severityMeta = SEVERITY_META[finding.severity];
  const location = `${finding.location.field}${finding.location.section ? ` · ${finding.location.section}` : ""}${finding.location.line_start ? ` · line ${finding.location.line_start}${finding.location.line_end && finding.location.line_end !== finding.location.line_start ? `–${finding.location.line_end}` : ""}` : ""}`;
  return (
    <li className="grid min-h-52 min-w-0 max-w-full grid-cols-[24px_minmax(0,1fr)] gap-3 border-b border-rule px-4 py-4 sm:grid-cols-[24px_minmax(0,1fr)_210px]">
      <input
        type="checkbox"
        className="mt-1 cursor-pointer"
        checked={selected}
        disabled={readOnly}
        onChange={(event) => onSelect(event.target.checked)}
        aria-label={`Select finding: ${finding.issue}`}
      />
      <div className="min-w-0 max-w-[75ch]">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${severityMeta.icon_tone}`}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${SEVERITY_DOT[finding.severity]}`}
          />
          {severityMeta.label}
        </span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-muted">
            Step {stepNumber(finding.step)}
          </code>
          <code className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-muted">
            {finding.rule_reference}
          </code>
          {hardFlag && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />
              Hard flag · provenance/attribution
            </span>
          )}
          {decision && (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${decision === "accepted" ? "border-success/40 bg-success/10 text-success" : "border-rule bg-subtle text-muted"}`}
            >
              {decision}
            </span>
          )}
        </div>
        <p className="mt-2 [overflow-wrap:anywhere] font-medium">{finding.issue}</p>
        {finding.evidence && (
          <p className="mt-2 [overflow-wrap:anywhere] text-sm text-muted">
            <span className="font-sans font-semibold text-ink">Evidence:</span> {finding.evidence}
          </p>
        )}
        <p className="mt-2 [overflow-wrap:anywhere] text-sm text-muted">
          <span className="font-sans font-semibold text-ink">Suggested fix:</span>{" "}
          {finding.suggested_fix}
        </p>
        <p className="mt-2 [overflow-wrap:anywhere] font-mono text-xs text-muted">{location}</p>
        {finding.evidence_sources?.map((source) => (
          <dl
            key={`${source.url}:${source.evidence_hash}`}
            className="mt-3 grid min-w-0 gap-x-3 gap-y-1 border-t border-rule pt-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]"
            aria-label="Source evidence details"
          >
            <dt className="font-semibold text-ink">Source URL</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              <a
                className="text-action underline"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.url}
              </a>
            </dd>
            <dt className="font-semibold text-ink">Extraction</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{source.extraction_method}</dd>
            <dt className="font-semibold text-ink">Retrieved</dt>
            <dd>{new Date(source.retrieved_at).toLocaleString("en-GB")}</dd>
            <dt className="font-semibold text-ink">Content hash</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{source.content_hash}</dd>
            <dt className="font-semibold text-ink">Evidence hash</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{source.evidence_hash}</dd>
            <dt className="font-semibold text-ink">Excerpt</dt>
            <dd className="[overflow-wrap:anywhere]">{source.excerpt}</dd>
            <dt className="font-semibold text-ink">Selection reason</dt>
            <dd className="[overflow-wrap:anywhere]">{source.selection_reason}</dd>
          </dl>
        ))}
        {hardFlag && (
          <p className="mt-2 text-xs font-semibold text-danger">
            Always requires an explicit operator decision.
          </p>
        )}
      </div>
      <div className="min-w-0 col-start-2 sm:col-start-3 sm:row-start-1">
        <div
          className="grid grid-cols-2 gap-2"
          role="group"
          aria-label={`Decision for: ${finding.issue}`}
        >
          <Button
            type="button"
            variant="outline"
            aria-pressed={decision === "accepted"}
            className={
              decision === "accepted" ? "border-success bg-success/10 text-success" : undefined
            }
            disabled={readOnly}
            onClick={() => onDecision("accepted")}
          >
            Accept
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-pressed={decision === "rejected"}
            className={decision === "rejected" ? "border-ink bg-subtle" : undefined}
            disabled={readOnly}
            onClick={() => onDecision("rejected")}
          >
            Reject
          </Button>
        </div>
        <Field className="mt-3 gap-1">
          <FieldLabel htmlFor={rationaleId} className="text-xs text-muted">
            Rationale (optional)
          </FieldLabel>
          <Textarea
            id={rationaleId}
            value={staged?.rationale ?? finding.rationale ?? ""}
            readOnly={finding.disposition !== null}
            disabled={finding.disposition === null && !decision}
            onChange={(event) => onRationale(event.target.value)}
            aria-label={`Rationale for: ${finding.issue}`}
            aria-describedby={`${rationaleId}-help`}
          />
          <FieldDescription id={`${rationaleId}-help`}>
            Rationale adds context only. Choose Accept or Reject separately.
          </FieldDescription>
        </Field>
      </div>
    </li>
  );
}

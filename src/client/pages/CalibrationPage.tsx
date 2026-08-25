import { type FormEvent, useEffect, useId, useState } from "react";
import { Inbox, Loader2 } from "lucide-react";
import type {
  CalibrationCombinedReport,
  CalibrationPostResult,
  CalibrationRunDetail,
} from "../../shared/contracts/calibration.js";
import { AsyncNotice } from "../components/AsyncNotice.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader } from "../components/PageHeader.js";
import { Button } from "../components/ui/button.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { CalibrationReport } from "../features/calibration/CalibrationReport.js";
import {
  calibrationApi,
  CalibrationApiError,
  type ProposalVersions,
} from "../lib/calibration-api.js";

type Busy = "list" | "start" | "load" | "resume" | "report" | "proposals" | null;

/**
 * The key exists to make a repeated submission return the same run rather than
 * starting a second one. That is a transport concern, not a decision for the
 * operator, so it is generated here and only surfaced under advanced options.
 */
const newCalibrationKey = () => `calibration-${crypto.randomUUID()}`;

export function CalibrationPage() {
  const formId = useId().replaceAll(":", "");
  const [runs, setRuns] = useState<CalibrationRunDetail[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newCalibrationKey);
  const [keyCopied, setKeyCopied] = useState(false);
  const [run, setRun] = useState<CalibrationRunDetail | null>(null);
  const [results, setResults] = useState<CalibrationPostResult[]>([]);
  const [report, setReport] = useState<CalibrationCombinedReport | null>(null);
  const [busy, setBusy] = useState<Busy>("list");
  const [notice, setNotice] = useState("Loading local calibration runs…");
  const [tone, setTone] = useState<"neutral" | "error" | "warning" | "success">("neutral");
  const [confirmProposals, setConfirmProposals] = useState(false);
  const [versions, setVersions] = useState<ProposalVersions>([]);
  const [startError, setStartError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void listRuns();
  }, []);

  async function listRuns() {
    setBusy("list");
    try {
      const loaded = await calibrationApi.list();
      setRuns(loaded);
      setNotice(
        loaded.length
          ? `${loaded.length} calibration ${loaded.length === 1 ? "run" : "runs"} available.`
          : "No calibration runs yet. Start the fixed two-post set when the local database is available.",
      );
      setTone("neutral");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    const key = idempotencyKey.trim();
    if (!key) {
      setStartError("Enter an idempotency key before starting calibration.");
      setNotice("Enter an idempotency key before starting calibration.");
      setTone("error");
      return;
    }
    setStartError("");
    setBusy("start");
    setNotice("Starting the fixed two-post calibration set…");
    setTone("neutral");
    try {
      const started = await calibrationApi.start(key);
      setRun(started);
      setSelectedId(started.id);
      setResults([]);
      setReport(null);
      setRuns((current) => [started, ...current.filter((item) => item.id !== started.id)]);
      setNotice(`Calibration started. Status: ${humanise(started.status)}.`);
      // Retire the key now that it has produced a run: submitting again is a
      // deliberate new calibration, not a replay of this one.
      setIdempotencyKey(newCalibrationKey());
      setKeyCopied(false);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard?.writeText(idempotencyKey);
      setKeyCopied(true);
    } catch {
      // Clipboard access can be refused; the key stays selectable in the field.
      setKeyCopied(false);
    }
  }

  async function load(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedId) {
      setLoadError("Choose a calibration run before loading it.");
      setNotice("Choose a calibration run before loading it.");
      setTone("error");
      return;
    }
    setLoadError("");
    setBusy("load");
    setNotice("Loading calibration checkpoint…");
    setTone("neutral");
    try {
      const loaded = await calibrationApi.load(selectedId);
      setRun(loaded);
      setResults([]);
      setReport(null);
      setConfirmProposals(false);
      setVersions([]);
      setNotice(`Calibration loaded. Status: ${humanise(loaded.status)}.`);
      setTone(
        loaded.status === "retryable_failed"
          ? "warning"
          : loaded.status === "succeeded"
            ? "success"
            : "neutral",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The calibration run could not be loaded.";
      setLoadError(message);
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    if (!run) return;
    setBusy("resume");
    setNotice("Resuming from the saved checkpoint…");
    setTone("neutral");
    try {
      const resumed = await calibrationApi.resume(run.id);
      setRun(resumed);
      setNotice(`Calibration resumed. Status: ${humanise(resumed.status)}.`);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function loadReport() {
    if (!run) return;
    setBusy("report");
    setNotice("Loading both post results and combined report…");
    setTone("neutral");
    try {
      const [loadedResults, loadedReport] = await Promise.all([
        calibrationApi.results(run.id),
        calibrationApi.report(run.id),
      ]);
      setResults(loadedResults);
      setReport(loadedReport);
      setNotice(
        loadedResults.length === 2
          ? "Comparison report loaded. Findings remain provisional until Aaron approves them."
          : `Loaded ${loadedResults.length} of 2 post results.`,
      );
      setTone(loadedResults.length === 2 ? "success" : "warning");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function createProposals() {
    if (!run || run.status !== "succeeded") return;
    setBusy("proposals");
    setNotice("Creating proposal versions…");
    setTone("neutral");
    try {
      const created = await calibrationApi.createProposalVersions(run.id);
      setVersions(created);
      setConfirmProposals(false);
      setNotice(
        `${created.length} proposal ${created.length === 1 ? "version" : "versions"} created with pending editorial approval. Nothing was activated.`,
      );
      setTone("success");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  function showError(error: unknown) {
    setNotice(
      error instanceof Error ? error.message : "The calibration request could not be completed.",
    );
    setTone(error instanceof CalibrationApiError && error.status === 503 ? "warning" : "error");
  }

  return (
    <div className="min-w-0 flex-1 px-4 py-8 sm:px-6 xl:px-8">
      <PageHeader id="calibration-heading" eyebrow="Quality control" title="Calibration">
        Compare two fixed published posts with their latest generated pipeline output before
        proposing reference changes.
      </PageHeader>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
        <div className="rounded-group border border-rule bg-paper p-4 sm:p-6">
          <h2 className="text-h2 font-semibold">Start calibration</h2>
          <form onSubmit={start} className="mt-3">
            <Field data-invalid={Boolean(startError)}>
              <FieldLabel htmlFor={`${formId}-idempotency-key`}>Idempotency key</FieldLabel>
              <div className="flex flex-wrap items-start gap-2">
                {/* Read-only: the key exists to make a repeated submission return
                    the same run, so editing it can only cause a duplicate. */}
                <Input
                  id={`${formId}-idempotency-key`}
                  className="min-w-0 flex-1 font-mono"
                  value={idempotencyKey}
                  readOnly
                  aria-invalid={Boolean(startError)}
                  {...(startError ? { "aria-describedby": `${formId}-idempotency-error` } : {})}
                />
                {/* The label itself confirms the copy: a second live region
                    would compete with the page's status announcements. */}
                <Button type="button" variant="outline" onClick={() => void copyKey()}>
                  {keyCopied ? "Copied" : "Copy"}
                </Button>
              </div>
              <FieldError id={`${formId}-idempotency-error`}>{startError}</FieldError>
            </Field>
            <p className="mt-3 text-sm text-muted">
              A unique key is created automatically to prevent duplicate runs.
            </p>
            <Button
              className="mt-3"
              disabled={busy !== null}
              loading={busy === "start"}
              type="submit"
            >
              {busy === "start" ? "Starting…" : "Start calibration →"}
            </Button>
          </form>

          <div className="mt-6 border-t border-rule pt-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Recent runs</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void listRuns()}
                disabled={busy !== null}
              >
                Refresh
              </Button>
            </div>
            <form onSubmit={load} className="mt-3">
              <Field data-invalid={Boolean(loadError)}>
                <FieldLabel htmlFor={`${formId}-run`}>Run</FieldLabel>
                <Select
                  value={selectedId}
                  onValueChange={setSelectedId}
                  disabled={busy === "list" || runs.length === 0}
                >
                  <SelectTrigger
                    id={`${formId}-run`}
                    aria-invalid={Boolean(loadError)}
                    aria-describedby={`${formId}-run-description${loadError ? ` ${formId}-run-error` : ""}`}
                  >
                    <SelectValue placeholder={busy === "list" ? "Loading runs…" : "Choose a run"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {runs.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {humanise(item.status)} · {item.id}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription id={`${formId}-run-description`}>
                  Choose a recent calibration run to inspect or resume.
                </FieldDescription>
                <FieldError id={`${formId}-run-error`}>{loadError}</FieldError>
              </Field>
              <Button
                variant="outline"
                className="mt-3"
                disabled={busy !== null || !selectedId}
                loading={busy === "load"}
                type="submit"
              >
                {busy === "load" ? "Loading…" : "Load run"}
              </Button>
            </form>
          </div>
        </div>

        <div className="rounded-group border border-rule bg-paper p-4 sm:p-6">
          {run ? (
            <RunSummary run={run} busy={busy} onResume={resume} onReport={loadReport} />
          ) : busy === "list" ? (
            <EmptyState icon={Loader2} spin text="Loading calibration runs…" />
          ) : (
            <EmptyState icon={Inbox} text="No calibration run loaded." />
          )}
        </div>
      </div>
      <div className="mt-4">
        <AsyncNotice message={notice} tone={tone} />
      </div>

      {run && report && results.length > 0 && (
        <CalibrationReport results={results} report={report} />
      )}
      {run?.status === "succeeded" && report && (
        <ProposalAction
          busy={busy}
          confirm={confirmProposals}
          versions={versions}
          onConfirm={() => setConfirmProposals(true)}
          onCancel={() => setConfirmProposals(false)}
          onCreate={createProposals}
        />
      )}
    </div>
  );
}

function RunSummary({
  run,
  busy,
  onResume,
  onReport,
}: {
  run: CalibrationRunDetail;
  busy: Busy;
  onResume: () => void;
  onReport: () => void;
}) {
  const statusDot =
    run.status === "succeeded"
      ? "bg-success"
      : run.status === "retryable_failed"
        ? "bg-danger"
        : "bg-info";
  const statusText =
    run.status === "succeeded"
      ? "text-success"
      : run.status === "retryable_failed"
        ? "text-danger"
        : "text-info";
  return (
    <section aria-labelledby="run-status-heading">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-3">
        <div>
          <h2 id="run-status-heading" className="text-h2 font-semibold">
            Calibration run
          </h2>
          <p className="mt-1 break-all font-mono text-xs text-muted">{run.id}</p>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-semibold ${statusText}`}>
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDot}`} />
          {humanise(run.status)}
        </span>
      </div>
      <dl className="grid border-b border-rule sm:grid-cols-4">
        <Count label="Checkpoint" value={humanise(run.checkpoint)} />
        <Count label="Snapshots" value={`${run.snapshot_count} / 2`} />
        <Count label="Results" value={`${run.result_count} / 2`} />
        <Count label="Combined report" value={run.has_combined_report ? "Available" : "Pending"} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {run.status === "retryable_failed" && (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            loading={busy === "resume"}
            onClick={onResume}
          >
            {busy === "resume" ? "Resuming…" : "Resume retryable run"}
          </Button>
        )}
        {run.status === "succeeded" && (
          <Button
            type="button"
            disabled={busy !== null}
            loading={busy === "report"}
            onClick={onReport}
          >
            {busy === "report" ? "Loading report…" : "Load comparison report"}
          </Button>
        )}
      </div>
      {run.status !== "succeeded" && run.status !== "retryable_failed" && (
        <p className="mt-3 text-sm text-muted">
          The worker is {humanise(run.status).toLowerCase()}. Reload the run to retrieve its latest
          checkpoint.
        </p>
      )}
    </section>
  );
}

function ProposalAction({
  busy,
  confirm,
  versions,
  onConfirm,
  onCancel,
  onCreate,
}: {
  busy: Busy;
  confirm: boolean;
  versions: ProposalVersions;
  onConfirm: () => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <section aria-labelledby="proposal-heading" className="mt-12 border-t-2 border-ink pt-4">
      <h2 id="proposal-heading" className="text-h2 font-semibold">
        Reference proposal versions
      </h2>
      <p className="mt-2 max-w-[72ch] text-sm text-muted">
        This creates immutable versions with{" "}
        <code className="font-mono text-xs text-ink">pending_editorial_approval</code>. It does not
        activate them. Aaron must review and approve separately.
      </p>
      {versions.length > 0 ? (
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {versions.map((version) => (
            <li key={version.reference_version_id} className="py-2 text-sm">
              <span className="font-mono text-xs">{version.reference_version_id}</span> · Pending
              editorial approval
            </li>
          ))}
        </ul>
      ) : confirm ? (
        <div className="mt-4 rounded-group border border-warning/50 bg-warning/10 p-4">
          <p className="text-sm font-semibold">Create proposal versions now?</p>
          <p className="mt-1 text-sm">
            They will remain inactive and pending Aaron’s editorial approval.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy !== null}
              loading={busy === "proposals"}
              onClick={onCreate}
            >
              {busy === "proposals" ? "Creating…" : "Confirm creation"}
            </Button>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" className="mt-4" onClick={onConfirm}>
          Create proposal versions
        </Button>
      )}
    </section>
  );
}
function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule py-4 sm:border-r sm:px-4 sm:first:pl-0 sm:last:border-r-0">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
function humanise(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

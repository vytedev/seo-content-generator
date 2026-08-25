import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { HandoffSchema } from "../../../shared/pipeline.js";
import { AsyncNotice } from "../../components/AsyncNotice.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { IngestApiError, parseIngestResponse } from "../../lib/ingest-api.js";
import { apiFetch } from "../../lib/api.js";
import { fetchRecentRuns } from "../../lib/run-list-api.js";

const newKey = () => `run-${crypto.randomUUID()}`;
const MAX_HANDOFF_FILE_BYTES = 100 * 1024;

export function NewRun({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const id = useId().replaceAll(":", "");
  const [json, setJson] = useState("");
  const [key, setKey] = useState(newKey);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [notice, setNotice] = useState("Paste a handoff or choose a local JSON file.");
  const [successId, setSuccessId] = useState("");
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);
  const requestSequence = useRef(0);
  const progressPollRef = useRef(0);

  // Ingest runs steps 1.1–1.9 synchronously, so the POST can stay in flight for
  // minutes with a real model. Stop polling when the form unmounts or is reset.
  useEffect(() => () => window.clearInterval(progressPollRef.current), []);

  function edit(value: string) {
    if (attempted) {
      setKey(newKey());
      setAttempted(false);
      requestSequence.current += 1;
      setBusy(false);
      window.clearInterval(progressPollRef.current);
    }
    setJson(value);
    setErrors([]);
    setSuccessId("");
    setWarnings([]);
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const control = event.currentTarget;
    const file = control.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setErrors([{ path: "file", message: "Choose a .json file." }]);
      control.value = "";
      return;
    }
    if (file.size > MAX_HANDOFF_FILE_BYTES) {
      setErrors([{ path: "file", message: "Choose a JSON file no larger than 100KB." }]);
      control.value = "";
      return;
    }
    try {
      edit(await file.text());
      setNotice(`${file.name} loaded locally. It has not been uploaded.`);
    } catch {
      setErrors([{ path: "file", message: "The selected file could not be read." }]);
      control.value = "";
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    setErrors([]);
    let input: unknown;
    try {
      input = JSON.parse(json);
    } catch {
      setErrors([{ path: "handoff", message: "Enter valid JSON." }]);
      setNotice("Correct the linked syntax error and try again.");
      return;
    }
    const validation = HandoffSchema.safeParse(input);
    if (!validation.success) {
      setErrors(
        validation.error.issues.map((issue) => ({
          path: issue.path.join(".") || "handoff",
          message: issue.message,
        })),
      );
      setNotice("Correct the linked schema errors and try again.");
      return;
    }
    const sequence = ++requestSequence.current;
    setBusy(true);
    setSuccessId("");
    setWarnings([]);
    setNotice("Starting your blog post…");
    // The ingest POST runs steps 1.1–1.9 synchronously and can stay in flight
    // for minutes. Poll the run list in parallel and focus the run the moment
    // it appears, so the operator watches live progress in 02 Production
    // instead of staring at a submitting button. The POST result still governs
    // warnings and errors when it lands.
    let opened = false;
    const maybeOpen = (runId: string) => {
      if (opened || sequence !== requestSequence.current) return;
      opened = true;
      onOpenRun(runId);
    };
    window.clearInterval(progressPollRef.current);
    progressPollRef.current = window.setInterval(() => {
      if (sequence !== requestSequence.current) {
        window.clearInterval(progressPollRef.current);
        return;
      }
      void fetchRecentRuns()
        .then((list) => {
          const match = list.find((run) => run.plane_ticket === validation.data.plane_ticket);
          if (match) {
            window.clearInterval(progressPollRef.current);
            maybeOpen(match.run_id);
          }
        })
        .catch(() => {});
    }, 2000);
    try {
      const response = await apiFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(validation.data),
      });
      const body: unknown = await response.json();
      const result = parseIngestResponse(body, response.ok);
      window.clearInterval(progressPollRef.current);
      if (sequence !== requestSequence.current) return;
      if (!result.warnings.length) {
        // A clean handoff has nothing left to confirm — go straight to production
        // rather than making the operator click a second "View progress" button.
        maybeOpen(result.run_id);
        return;
      }
      // A non-blocking warning (e.g. a SERP composition mismatch) is exactly the
      // kind of thing the operator should actually see before continuing, so this
      // path stops here and waits for a deliberate "View progress" click instead.
      setSuccessId(result.run_id);
      setWarnings(result.warnings);
      setNotice(
        `Blog post started with ${result.warnings.length} non-blocking ${result.warnings.length === 1 ? "warning" : "warnings"}.`,
      );
    } catch (error) {
      window.clearInterval(progressPollRef.current);
      if (sequence !== requestSequence.current) return;
      if (error instanceof IngestApiError) setErrors(error.details);
      setNotice(error instanceof Error ? error.message : "The handoff could not be ingested.");
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }

  const handoffErrors = errors.filter((error) => error.path !== "file");
  return (
    <div className="min-w-0 max-w-full">
      <form onSubmit={submit} className="min-w-0 space-y-6">
        <div className="space-y-4 rounded-group border border-rule bg-paper p-4">
          <Field data-invalid={errors.some((error) => error.path === "file")}>
            <FieldLabel htmlFor={`${id}-file`}>Local JSON file</FieldLabel>
            <Input
              id={`${id}-file`}
              type="file"
              accept="application/json,.json"
              onChange={chooseFile}
              disabled={busy}
              aria-invalid={errors.some((error) => error.path === "file")}
              aria-describedby={`${id}-file-help${errors.some((error) => error.path === "file") ? ` ${id}-file-error` : ""}`}
            />
            <FieldDescription id={`${id}-file-help`}>
              The browser reads this file client-side; no multipart upload is stored.
            </FieldDescription>
            <FieldError id={`${id}-file-error`}>
              {errors.find((error) => error.path === "file")?.message}
            </FieldError>
          </Field>
          <Field data-invalid={handoffErrors.length > 0}>
            <FieldLabel htmlFor={`${id}-handoff`}>Handoff JSON</FieldLabel>
            <Textarea
              id={`${id}-handoff`}
              className="min-h-80 font-mono text-sm"
              value={json}
              onChange={(event) => edit(event.target.value)}
              disabled={busy}
              aria-invalid={handoffErrors.length > 0}
              aria-describedby={handoffErrors.length ? `${id}-errors` : `${id}-help`}
            />
            <FieldDescription id={`${id}-help`}>
              Required: plane_ticket, primary_keyword, related_keywords, page_type "blog",
              word_count_target and locales_for_translation. client_insights is optional.
            </FieldDescription>
            <FieldError id={`${id}-errors`} errors={handoffErrors} />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-key`} className="text-xs text-muted">
            Idempotency key
          </FieldLabel>
          <Input id={`${id}-key`} value={key} readOnly className="font-mono text-xs" />
          <FieldDescription>
            Preserved across retries. Editing after an attempted submit generates a key for a
            distinct blog post.
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>
            {busy ? "Starting…" : "Start blog post"}
          </Button>
          {successId && (
            <Button type="button" variant="outline" onClick={() => onOpenRun(successId)}>
              View progress
            </Button>
          )}
        </div>
      </form>
      <div className="mt-6 space-y-3">
        <AsyncNotice
          message={notice}
          tone={successId ? "success" : errors.length ? "error" : "neutral"}
        />
        {warnings.length > 0 && (
          <ul aria-label="Non-blocking ingest warnings" className="space-y-2 text-sm text-ink">
            {warnings.map((warning) => (
              <li
                key={warning.code}
                className="min-w-0 [overflow-wrap:anywhere] border border-warning/60 bg-warning/10 px-3 py-2"
              >
                <span className="font-semibold">Warning:</span> {warning.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

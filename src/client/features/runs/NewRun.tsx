import { type ChangeEvent, type FormEvent, useId, useRef, useState } from "react";
import { HandoffSchema } from "../../../shared/pipeline.js";
import { AsyncNotice } from "../../components/AsyncNotice.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { IngestApiError, parseIngestResponse } from "../../lib/ingest-api.js";
import { apiFetch } from "../../lib/api.js";

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

  function edit(value: string) {
    if (attempted) {
      setKey(newKey());
      setAttempted(false);
      requestSequence.current += 1;
      setBusy(false);
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
    try {
      const response = await apiFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(validation.data),
      });
      const body: unknown = await response.json();
      const result = parseIngestResponse(body, response.status);
      if (sequence !== requestSequence.current) return;
      // Rotate only after the server durably accepts this exact command. A
      // disconnect or other ambiguous failure leaves the key unchanged so the
      // operator's retry is a replay, never a second run.
      setKey(newKey());
      setAttempted(false);
      if (!result.result.warnings.length) {
        setNotice("Blog post accepted. Loading progress…");
        onOpenRun(result.run_id);
        return;
      }
      setSuccessId(result.run_id);
      setWarnings(result.result.warnings);
      setNotice(
        `Blog post started with ${result.result.warnings.length} non-blocking ${result.result.warnings.length === 1 ? "warning" : "warnings"}.`,
      );
    } catch (error) {
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

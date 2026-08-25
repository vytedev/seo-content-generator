import { useEffect, useState } from "react";
import { CircleAlert, FileText, Inbox, Loader2 } from "lucide-react";
import { BoxedEmptyState } from "../../components/EmptyState.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Button } from "../../components/ui/button.js";
import {
  fetchReferenceVersions,
  type ReferenceVersionRow,
} from "../../lib/reference-approval-api.js";

type LoadState = "loading" | "loaded" | "error";
type Tone = "success" | "info" | "warning" | "neutral";

const KIND_ORDER = [
  "blog_writing_guide",
  "writer_submission_sample",
  "keyword_placement_guidelines",
  "internal_linking_guidelines",
  "fact_checking_rules",
  "pipeline_workflow",
];

/** Dot colour (or icon colour for the attention states) — see .xevy/design.md §10, Status treatment. */
const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  neutral: "bg-muted",
};

const TONE_TEXT: Record<Tone, string> = {
  success: "text-ink",
  info: "text-ink",
  warning: "text-ink",
  neutral: "text-muted",
};

/**
 * Truthful, in-order precedence: a claimed approver name is never enough on
 * its own — only `trusted_verified` (recorded out-of-band, never through this
 * app's public API) can produce an "Approved" status. See src/shared/approval.ts.
 */
function approvalStatus(row: ReferenceVersionRow): { text: string; tone: Tone } {
  if (row.effective_approval_status === "trusted_verified_active")
    return { text: "Approved (verified)", tone: "success" };
  if (row.attestation_state === "trusted_verified")
    return { text: "Verified, but not the active version", tone: "info" };
  if (row.attestation_state === "pending_unverified")
    return { text: "Approval recorded, awaiting verification", tone: "warning" };
  if (row.provisional_local) return { text: "Provisional for local work only", tone: "neutral" };
  return { text: "Awaiting editorial approval", tone: "neutral" };
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function WritingGuides() {
  const [state, setState] = useState<LoadState>("loading");
  const [rows, setRows] = useState<ReferenceVersionRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchReferenceVersions()
      .then((versions) => {
        if (cancelled) return;
        setRows(versions);
        setState("loaded");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof Error ? caught.message : "The writing guides could not be loaded.",
        );
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = KIND_ORDER.map((kind) => ({
    kind,
    title: rows.find((row) => row.kind === kind)?.title ?? kind,
    versions: [...rows.filter((row) => row.kind === kind)].sort((a, b) => b.version - a.version),
  })).filter((group) => group.versions.length > 0);

  const statusMessage =
    state === "loading"
      ? "Loading the writing guides…"
      : state === "error"
        ? error
        : groups.length === 0
          ? "No writing guides have been recorded yet."
          : `${groups.length} writing ${groups.length === 1 ? "guide" : "guides"} loaded.`;

  return (
    <div className="min-w-0 flex-1 px-4 py-8 sm:px-6 xl:px-8">
      <PageHeader id="writing-guides-heading" eyebrow="Workspace reference" title="Writing guides">
        Versioned documents used by the editorial pipeline. Approval states apply at run start.
      </PageHeader>

      {state === "loading" && (
        <BoxedEmptyState icon={Loader2} spin text="Loading the writing guides…" />
      )}
      {state === "error" && <BoxedEmptyState icon={CircleAlert} tone="danger" text={error} />}
      {state === "loaded" && groups.length === 0 && (
        <BoxedEmptyState icon={Inbox} text="No writing guides have been recorded yet." />
      )}

      {state === "loaded" && groups.length > 0 && (
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {groups.map((group) => (
            <GuideRow key={group.kind} title={group.title} versions={group.versions} />
          ))}
        </ul>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </p>
    </div>
  );
}

function GuideRow({ title, versions }: { title: string; versions: ReferenceVersionRow[] }) {
  const [open, setOpen] = useState(false);
  const active = versions[0]!;
  const status = approvalStatus(active);
  const historyId = `${active.version_id}-history`;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`}
            />
            <span className={TONE_TEXT[status.tone]}>{status.text}</span>
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted">Version {active.version}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={historyId}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide history" : "View history"}
        </Button>
      </div>
      {open && (
        <ul id={historyId} className="mt-3 space-y-3 border-t border-rule pt-3">
          {versions.map((version) => (
            <VersionDetail key={version.version_id} version={version} />
          ))}
        </ul>
      )}
    </li>
  );
}

function VersionDetail({ version }: { version: ReferenceVersionRow }) {
  const status = approvalStatus(version);

  return (
    <li>
      <p className="flex items-center gap-1.5 text-xs">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`}
        />
        <span className="font-mono tabular-nums text-muted">Version {version.version}</span>
        <span className={TONE_TEXT[status.tone]}>{status.text}</span>
      </p>
      <dl className="mt-2 space-y-2 pl-3 text-sm">
        <DetailRow label="Recorded by" value={version.recorder_identity} />
        <DetailRow label="Claimed approver" value={version.approver_identity} />
        <DetailRow label="Evidence" value={version.evidence_reference} />
        <DetailRow label="Note" value={version.note} />
        <DetailRow label="Recorded on" value={formatDate(version.attested_at)} />
        {version.attestation_state === "none" && (
          <p className="text-muted">No approval has been recorded for this version yet.</p>
        )}
      </dl>
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="max-w-[60%] text-right break-words">{value}</dd>
    </div>
  );
}

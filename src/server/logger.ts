import { randomUUID } from "node:crypto";

/**
 * Structured operational logging with a deliberately narrow data contract.
 * Callers may pass convenient objects, but only allowlisted scalar diagnostics
 * are emitted. Error messages, stacks, content and transport data are never
 * accepted by the logger.
 */

const configuredLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const severityRank = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Severity = keyof typeof severityRank;

const SAFE_FIELD_NAMES = new Set([
  "attempt",
  "attempts",
  "attempt47_decoder_exact_match",
  "canonical_operations_match_expected",
  "category",
  "code",
  "reason_code",
  "connected",
  "context",
  "decoder_order",
  "decoder_rejection_reason",
  "duration_ms",
  "event_order",
  "expected_hash_matches_render_hash",
  "expected_received_counts",
  "exact_prefix_match",
  "forward_decoder_rejection_reason",
  "historical_repair_eligible",
  "issue_path_counts",
  "failure_category",
  "method",
  "merged_cell_heading_style_matches",
  "merged_cell_expected_prefix_matches",
  "merged_heading_suffix_matches",
  "misplaced_bullet_states",
  "misplaced_exact_expected_operation_indexes",
  "misplaced_marker_states",
  "misplaced_mapping_truncated",
  "misplaced_structural_types",
  "misplaced_text_lengths",
  "mismatch_actual_type",
  "mismatch_expected_type",
  "model",
  "next_step",
  "outcome",
  "paragraph_count_consumed",
  "path",
  "port",
  "pipeline_configured",
  "database_configured",
  "phase",
  "provider",
  "reason",
  "replayed",
  "reported_request_type",
  "request_type",
  "retained_cell_terminator_matches",
  "reverse_decoder_rejection_reason",
  "reversed_suffix_recovery",
  "retryable",
  "round",
  "stage",
  "state",
  "status",
  "span_style_categories",
  "step",
  "transition",
  "expected_operation_type",
  "actual_structural_type",
  "worker_status",
  "accepted_count",
  "active_round",
  "applied_count",
  "baseline_checker_version",
  "baseline_equals_current",
  "baseline_rule_inventory_count",
  "baseline_version_id",
  "binding_version",
  "body_control_marker_count",
  "changed_audit_count",
  "checker_version",
  "completion_metadata_matches_expected",
  "content_hash_matches",
  "correction_source_version_id",
  "current_descends_from_baseline",
  "current_parent_id",
  "current_revision",
  "current_version_id",
  "deterministic_count",
  "document_line_count",
  "document_version_id",
  "expected_operation_count",
  "failure_count",
  "final_cell_style_restored",
  "finding_count",
  "introduced_blockers",
  "legacy_control_range_count",
  "legacy_list_marker_count",
  "model_count",
  "operation_count",
  "operation_id",
  "phase_index",
  "planning_version",
  "queue_job_id",
  "request_count",
  "request_id",
  "request_index",
  "reserved_document_reused",
  "retained_blockers",
  "reverted_count",
  "revision_fence_present",
  "run_id",
  "source_is_current",
  "source_round",
  "unable_count",
  "waiting_findings_review_count",
  "completion_present",
  "completion_matches_expected",
  "mismatch_index",
  "misplaced_paragraph_count",
  "misplaced_operation_count",
  "misplaced_mapping_count",
  "expected_operation_index",
  "actual_misplaced_paragraph_index",
  "table_row_count",
  "issue_count",
  "nullable_issue_count",
  "in_cell_completion_matches_expected",
  "bullet_metadata_present",
  "list_marker_present",
  "span_count",
  "text_length_matches_expected",
  "text_hash_matches_expected",
]);
const SAFE_STRING = /^(?:[a-zA-Z0-9/:])[a-zA-Z0-9 ._,:;/<>{}()=+-]*$/;
const SENSITIVE_FIELD =
  /(?:body|content|cookie|credential|error|header|message|password|prompt|query|response|secret|stack|token)/i;
const MAX_EVENT_LENGTH = 80;
const MAX_STRING_LENGTH = 160;

export function normalizeLogEvent(event: string): string {
  const normalized = event
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, MAX_EVENT_LENGTH);
  return normalized || "unknown_event";
}

function safeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, MAX_STRING_LENGTH);
  return SAFE_STRING.test(bounded) ? bounded : undefined;
}

export function safeLogFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    if ((key === "request" || key === "previous_request") && value && typeof value === "object") {
      const type = safeValue((value as { type?: unknown }).type);
      if (typeof type === "string") safe[key] = { type };
      continue;
    }
    if (!SAFE_FIELD_NAMES.has(key)) continue;
    const accepted = safeValue(value);
    if (accepted !== undefined) safe[key] = accepted;
  }
  return safe;
}

function write(severity: Severity, event: string, fields: Record<string, unknown> = {}): void {
  if (severityRank[severity] < (severityRank[configuredLevel as Severity] ?? severityRank.info))
    return;
  try {
    process.stdout.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: severity,
        event: normalizeLogEvent(event),
        ...safeLogFields(fields),
      })}\n`,
    );
  } catch {
    // Observability is deliberately best-effort and must never alter application control flow.
  }
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

/** Classifies an exception without retaining attacker/provider-controlled prose. */
export function classifyError(error: unknown): {
  category: string;
  reason_code: string;
  code?: string;
} {
  if (typeof error !== "object" || error === null)
    return { category: "internal", reason_code: "internal_error" };
  const record = error as { code?: unknown; name?: unknown };
  const rawCode = typeof record.code === "string" ? record.code : undefined;
  const code = rawCode && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : undefined;
  const name = typeof record.name === "string" ? record.name : "";
  const category =
    name === "AbortError" || code === "ETIMEDOUT"
      ? "timeout"
      : name.includes("Validation") || name === "ZodError" || name === "SyntaxError"
        ? "validation_failure"
        : name.includes("Conflict")
          ? "conflict"
          : name.includes("NotFound")
            ? "not_found"
            : name.includes("Unprocessable")
              ? "validation_failure"
              : name.includes("ServiceUnavailable")
                ? "service_unavailable"
                : name.includes("LeaseLost")
                  ? "lease_lost"
                  : code?.startsWith("ECONN")
                    ? "connection_failure"
                    : "internal_failure";
  return {
    category: category === "internal_failure" ? "internal" : category,
    reason_code: category === "internal_failure" ? "internal_error" : category,
    ...(code ? { code } : {}),
  };
}

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function safeRequestId(candidate: unknown): string {
  return typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

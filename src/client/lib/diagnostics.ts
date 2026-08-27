const reportedDiagnostics = new Set<string>();

export type ClientFailureFields = {
  request_id?: string;
  run_id?: string;
  step?: string;
  attempt?: number;
  category?: string;
  reason_code?: string;
  http_status?: number;
};

/** Development-only diagnostics with a fixed, content-free contract and session deduplication. */
export function reportClientFailure(
  event: string,
  fields: ClientFailureFields,
  enabled = import.meta.env.DEV,
): void {
  if (!enabled || typeof console === "undefined") return;
  const safe: ClientFailureFields = {
    ...(fields.request_id && /^[A-Za-z0-9_-]{8,64}$/.test(fields.request_id)
      ? { request_id: fields.request_id }
      : {}),
    ...(fields.run_id && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(fields.run_id)
      ? { run_id: fields.run_id }
      : {}),
    ...(fields.step && /^[a-z0-9_]{1,64}$/.test(fields.step) ? { step: fields.step } : {}),
    ...(Number.isSafeInteger(fields.attempt) ? { attempt: fields.attempt } : {}),
    ...(fields.category && /^[a-z_]{1,64}$/.test(fields.category)
      ? { category: fields.category }
      : {}),
    ...(fields.reason_code && /^[a-z0-9_]{1,64}$/.test(fields.reason_code)
      ? { reason_code: fields.reason_code }
      : {}),
    ...(Number.isSafeInteger(fields.http_status) ? { http_status: fields.http_status } : {}),
  };
  const key = `${event}:${JSON.stringify(safe)}`;
  if (reportedDiagnostics.has(key)) return;
  reportedDiagnostics.add(key);
  try {
    console.error(event, safe);
  } catch {
    // Diagnostics are best-effort and must never change application control flow.
  }
}

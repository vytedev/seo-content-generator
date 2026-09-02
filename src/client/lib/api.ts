import { reportClientFailure } from "./diagnostics.js";

let csrfToken = "";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const AUTH_EXPIRED_EVENT = "mm03:auth-expired";

function safeDiagnosticContext(input: RequestInfo | URL): { run_id?: string; step?: string } {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(raw, "http://local.invalid").pathname;
  const segments = pathname.split("/");
  const runsIndex = segments.indexOf("runs");
  const candidate = runsIndex >= 0 ? segments[runsIndex + 1] : undefined;
  const runId =
    candidate && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(candidate) ? candidate : undefined;
  const knownSteps = new Set([
    "keyword_research",
    "serp_analysis",
    "internal_link_discovery",
    "deterministic_baseline",
    "draft",
    "seo_review",
    "fact_review",
    "brand_review",
    "findings_review",
    "controlled_revision",
    "deterministic_rerun",
    "final_coherence_export",
  ]);
  const step = segments.find((segment) => knownSteps.has(segment));
  return { ...(runId ? { run_id: runId } : {}), ...(step ? { step } : {}) };
}

function failureClassification(status: number): { category: string; reason_code: string } {
  if (status === 401 || status === 403) return { category: "auth", reason_code: "access_denied" };
  if (status === 404) return { category: "not_found", reason_code: "resource_not_found" };
  if (status === 409) return { category: "conflict", reason_code: "state_conflict" };
  if (status === 413) return { category: "validation", reason_code: "payload_too_large" };
  if (status === 422) return { category: "validation", reason_code: "unprocessable" };
  if (status === 429) return { category: "rate_limit", reason_code: "rate_limited" };
  if (status >= 500) return { category: "server", reason_code: "server_error" };
  return { category: "request", reason_code: "request_failed" };
}

function reportDevelopmentFailure(input: RequestInfo | URL, response: Response): void {
  if (response.ok) return;
  const requestId = response.headers.get("X-Request-ID");
  reportClientFailure("pipeline.request.failed", {
    ...(requestId ? { request_id: requestId } : {}),
    ...safeDiagnosticContext(input),
    ...failureClassification(response.status),
    http_status: response.status,
  });
}

export function setCsrfToken(value: string): void {
  csrfToken = value;
}

export function clearCsrfToken(): void {
  csrfToken = "";
}

/** Authenticated API transport. Tokens stay in memory; the session token remains HttpOnly. */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { suppressAuthExpiry?: boolean } = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  let requestInit: RequestInit | undefined = Object.keys(init).length ? init : undefined;
  if (!SAFE_METHODS.has(method) && csrfToken) {
    const headers = new Headers(init.headers);
    headers.set("X-CSRF-Token", csrfToken);
    requestInit = { ...init, headers };
  }
  // Relative /api calls are same-origin in both the Vite proxy and built app,
  // so the browser's default credentials mode carries the HttpOnly cookie.
  const response = requestInit ? await fetch(input, requestInit) : await fetch(input);
  reportDevelopmentFailure(input, response);
  if (
    response.status === 401 &&
    csrfToken &&
    !options.suppressAuthExpiry &&
    typeof window !== "undefined"
  ) {
    clearCsrfToken();
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
  return response;
}

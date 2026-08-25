let csrfToken = "";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const AUTH_EXPIRED_EVENT = "mm03:auth-expired";

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

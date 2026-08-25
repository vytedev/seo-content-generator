import { AuthSessionSchema, type AuthSession } from "../../shared/contracts/auth.js";
import { apiFetch, clearCsrfToken, setCsrfToken } from "./api.js";

export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function parseSession(response: Response): Promise<AuthSession> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof body === "object" && body && "error" in body
        ? (body as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
    throw new AuthApiError(
      typeof error?.message === "string" ? error.message : "Sign in could not be completed.",
      response.status,
      typeof error?.code === "string" ? error.code : "AUTH_ERROR",
    );
  }
  const session = AuthSessionSchema.parse(body);
  setCsrfToken(session.csrf_token);
  return session;
}

const SESSION_CHECK_TIMEOUT_MS = 8_000;

export async function fetchAuthSession(): Promise<AuthSession> {
  // Never leave the application on the opening screen indefinitely when the
  // local API/proxy accepts a connection but does not complete the request.
  const controller = new AbortController();
  let timeout = 0;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      controller.abort();
      reject(new DOMException("The session check timed out.", "TimeoutError"));
    }, SESSION_CHECK_TIMEOUT_MS);
  });
  try {
    const request = apiFetch(
      "/api/auth/session",
      { signal: controller.signal },
      { suppressAuthExpiry: true },
    );
    return await parseSession(await Promise.race([request, timedOut]));
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function login(email: string, password: string): Promise<AuthSession> {
  return parseSession(
    await apiFetch(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
      { suppressAuthExpiry: true },
    ),
  );
}

export async function logout(): Promise<void> {
  const response = await apiFetch("/api/auth/logout", { method: "POST" });
  if (!response.ok && response.status !== 401)
    throw new AuthApiError("Sign out could not be completed.", response.status, "LOGOUT_FAILED");
  clearCsrfToken();
}

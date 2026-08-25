import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { AuthConfig } from "./config.js";
import {
  csrfToken,
  keyedTokenHash,
  newSessionToken,
  safeStringEqual,
  verifyPassword,
} from "./crypto.js";
import type { SessionStore } from "./session-store.js";

export const SESSION_COOKIE = "mm03_operator_session";
export const AUTH_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3100",
  "https://content-generator.vyte.dev",
] as const;
const loginSchema = z
  .object({ email: z.string().trim().email(), password: z.string().min(1).max(1024) })
  .strict();
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_ORIGINS = new Set<string>(AUTH_ALLOWED_ORIGINS);

export interface AuthServiceOptions {
  config: AuthConfig;
  store: SessionStore;
  now?: () => Date;
  throttle?: LoginThrottle;
  operatorName?: string;
  secureCookies?: boolean;
}

export interface AuthService {
  publicRoutes(app: Express): void;
  protect: RequestHandler;
}

type AuthenticatedRequest = Request & { operatorSession?: { token: string; tokenHash: string } };

export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly maximum = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly capacity = 1_000,
  ) {}

  allowed(ip: string, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.attempts.get(ip);
    return !entry || entry.resetAt <= now || entry.count < this.maximum;
  }

  fail(ip: string, now = Date.now()): void {
    this.prune(now);
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now)
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
    while (this.attempts.size > this.capacity)
      this.attempts.delete(this.attempts.keys().next().value as string);
  }

  succeed(ip: string): void {
    this.attempts.delete(ip);
  }

  private prune(now: number): void {
    for (const [ip, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(ip);
  }
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => new Date());
  const throttle = options.throttle ?? new LoginThrottle();
  const secureCookies = options.secureCookies ?? false;
  const config = options.config;
  const store = options.store;
  const operator = {
    id: "local-operator" as const,
    display_name: options.operatorName?.trim() || "Aaron",
    email: config.OPERATOR_EMAIL,
    account_type: "Local operator" as const,
  };

  const loadSession = async (request: AuthenticatedRequest): Promise<boolean> => {
    const token = cookie(request, SESSION_COOKIE);
    if (!token) return false;
    const tokenHash = keyedTokenHash(token, config.SESSION_SECRET);
    const session = await store.findActive(tokenHash, now());
    if (!session) return false;
    request.operatorSession = { token, tokenHash };
    return true;
  };

  const protect = async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    try {
      if (!(await loadSession(request))) return unauthorised(response);
      if (!SAFE_METHODS.has(request.method)) {
        if (!originAllowed(request)) {
          response.status(403).json({
            error: { code: "ORIGIN_INVALID", message: "The request origin is not allowed." },
          });
          return;
        }
        const supplied = request.header("x-csrf-token") ?? "";
        const expected = csrfToken(request.operatorSession!.token, config.SESSION_SECRET);
        if (!safeStringEqual(supplied, expected)) {
          response.status(403).json({
            error: { code: "CSRF_INVALID", message: "The request could not be verified." },
          });
          return;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  return {
    protect,
    publicRoutes(app) {
      app.post("/api/auth/login", async (request, response, next) => {
        try {
          if (!originAllowed(request)) return credentialsError(response);
          if (!throttle.allowed(request.ip ?? "unknown"))
            return response.status(429).json({
              error: {
                code: "AUTH_RATE_LIMITED",
                message: "Too many sign-in attempts. Wait before trying again.",
              },
            });
          const parsed = loginSchema.safeParse(request.body);
          const emailMatches =
            parsed.success && parsed.data.email.toLowerCase() === config.OPERATOR_EMAIL;
          const passwordMatches =
            parsed.success &&
            (await verifyPassword(parsed.data.password, config.OPERATOR_PASSWORD_HASH));
          if (!emailMatches || !passwordMatches) {
            throttle.fail(request.ip ?? "unknown");
            return credentialsError(response);
          }
          throttle.succeed(request.ip ?? "unknown");
          // Revoke any valid cookie presented at login before issuing a fresh,
          // unrelated token. This prevents fixation and makes re-authentication
          // a true session rotation rather than accumulating active sessions.
          const priorToken = cookie(request, SESSION_COOKIE);
          if (priorToken)
            await store.revoke(keyedTokenHash(priorToken, config.SESSION_SECRET), now());
          const token = newSessionToken();
          const expiresAt = new Date(now().getTime() + config.SESSION_TTL_HOURS * 3_600_000);
          await store.create({
            tokenHash: keyedTokenHash(token, config.SESSION_SECRET),
            expiresAt,
          });
          setSessionCookie(response, token, config.SESSION_TTL_HOURS, secureCookies);
          response.status(200).json({
            authenticated: true,
            operator,
            csrf_token: csrfToken(token, config.SESSION_SECRET),
            expires_at: expiresAt.toISOString(),
          });
        } catch (error) {
          next(error);
        }
      });

      app.get("/api/auth/session", async (request: AuthenticatedRequest, response, next) => {
        try {
          if (!(await loadSession(request))) return unauthorised(response);
          const session = await store.findActive(request.operatorSession!.tokenHash, now());
          if (!session) return unauthorised(response);
          response.json({
            authenticated: true,
            operator,
            csrf_token: csrfToken(request.operatorSession!.token, config.SESSION_SECRET),
            expires_at: session.expiresAt.toISOString(),
          });
        } catch (error) {
          next(error);
        }
      });

      app.post(
        "/api/auth/logout",
        protect,
        async (request: AuthenticatedRequest, response, next) => {
          try {
            await store.revoke(request.operatorSession!.tokenHash, now());
            clearSessionCookie(response, secureCookies);
            response.status(204).end();
          } catch (error) {
            next(error);
          }
        },
      );
    },
  };
}

function originAllowed(request: Request): boolean {
  const origin = request.header("origin");
  return origin !== undefined && ALLOWED_ORIGINS.has(origin);
}
function credentialsError(response: Response) {
  return response.status(401).json({
    error: { code: "INVALID_CREDENTIALS", message: "The email or password is incorrect." },
  });
}
function unauthorised(response: Response) {
  return response
    .status(401)
    .json({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } });
}
function setSessionCookie(
  response: Response,
  token: string,
  ttlHours: number,
  secure: boolean,
): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: ttlHours * 3_600_000,
  });
}
function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
  });
}
function cookie(request: Request, name: string): string {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

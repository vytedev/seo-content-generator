import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import {
  GOOGLE_DOCS_SCOPES,
  GOOGLE_GSC_SCOPES,
  type GoogleConsentPurpose,
  type GoogleOAuthClient,
  type GoogleTokenStore,
} from "../providers/google-oauth.js";

const callbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
const denialSchema = z.object({ error: z.string().min(1), state: z.string().min(1) });
const states = new Map<
  string,
  { verifier: string; expiresAt: number; purpose: GoogleConsentPurpose }
>();
const STATE_TTL_MS = 10 * 60_000;
const MAX_STATES = 100;
const STATE_COOKIE = "google_oauth_state";

export interface GoogleOAuthRoutes {
  configured: boolean;
  client?: GoogleOAuthClient;
  store?: GoogleTokenStore;
  /** Where to send the browser after the callback finishes — see registerGoogleOAuthRoutes. */
  clientOrigin?: string;
  secureCookies?: boolean;
}

export function registerGoogleOAuthRoutes(app: Express, service: GoogleOAuthRoutes): void {
  app.get("/api/integrations/google/status", async (_request, response, next) => {
    try {
      if (!service.configured || !service.store) {
        response.json({
          configured: false,
          connected: false,
          docs_connected: false,
          gsc_connected: false,
          connected_at: null,
        });
        return;
      }
      const status = await service.store.status();
      const tokens = status.connected ? await service.store.load() : null;
      const granted = new Set(tokens?.scope.split(/\s+/u).filter(Boolean) ?? []);
      const docsConnected = GOOGLE_DOCS_SCOPES.every((scope) => granted.has(scope));
      const gscConnected = GOOGLE_GSC_SCOPES.every((scope) => granted.has(scope));
      response.json({
        configured: true,
        connected: docsConnected,
        docs_connected: docsConnected,
        gsc_connected: gscConnected,
        connected_at: status.connectedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/integrations/google/connect", (request, response) => {
    if (!service.configured || !service.client) return unavailable(response);
    const parsedPurpose = z.enum(["docs", "gsc"]).safeParse(request.query.purpose ?? "docs");
    if (!parsedPurpose.success)
      return response.status(400).json({ error: { code: "INVALID_GOOGLE_PURPOSE" } });
    const purpose = parsedPurpose.data;
    pruneStates();
    while (states.size >= MAX_STATES) states.delete(states.keys().next().value as string);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    states.set(state, { verifier, expiresAt: Date.now() + STATE_TTL_MS, purpose });
    response.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      // OAuth returns through a top-level cross-site navigation from Google.
      // Lax sends the state cookie on that safe GET callback; Strict does not.
      sameSite: "lax",
      secure: service.secureCookies ?? false,
      maxAge: STATE_TTL_MS,
      path: "/api/integrations/google/callback",
    });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    response.redirect(303, service.client.authorisationUrl(state, challenge, purpose));
  });

  app.get("/api/integrations/google/callback", async (request, response) => {
    if (!service.configured || !service.client) return unavailable(response);
    const back = (path: string) => response.redirect(303, `${service.clientOrigin ?? ""}${path}`);
    const queryState = typeof request.query.state === "string" ? request.query.state : "";
    const state = states.get(queryState);
    const cookieState = parseCookie(request, STATE_COOKIE);
    // Consume before any await and clear on every callback path: callback replay is impossible.
    if (queryState) states.delete(queryState);
    response.clearCookie(STATE_COOKIE, { path: "/api/integrations/google/callback" });
    if (!state || state.expiresAt <= Date.now() || !safeEqual(queryState, cookieState)) {
      return back("/?google=error&code=invalid_callback");
    }
    if (denialSchema.safeParse(request.query).success) {
      return back("/?google=error&code=access_denied");
    }
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) return back("/?google=error&code=invalid_callback");
    try {
      await service.client.exchangeCode(parsed.data.code, state.verifier, state.purpose);
      return back(
        `/?google=success&code=${state.purpose === "gsc" ? "gsc_connected" : "connected"}`,
      );
    } catch {
      return back("/?google=error&code=exchange_failed");
    }
  });

  app.delete("/api/integrations/google", async (_request, response, next) => {
    if (!service.configured || !service.client) return unavailable(response);
    try {
      const outcome = await service.client.disconnect();
      if (outcome === "local_only") {
        logger.warn("google_oauth.disconnect_local_only", {
          provider: "google",
          outcome: "local_connection_cleared_without_remote_revoke",
          reason_code: "stored_connection_unreadable",
        });
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function unavailable(response: Response) {
  return response.status(503).json({
    error: { code: "GOOGLE_NOT_CONFIGURED", message: "Google Docs is not configured." },
  });
}

function parseCookie(request: Request, name: string): string {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pruneStates(): void {
  for (const [key, value] of states) if (value.expiresAt <= Date.now()) states.delete(key);
}

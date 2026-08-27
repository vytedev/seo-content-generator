import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { logger } from "../src/server/logger.js";
import {
  GOOGLE_SCOPES,
  type GoogleOAuthClient,
  type GoogleTokenStore,
} from "../src/server/providers/google-oauth.js";

describe("Google OAuth API", () => {
  it("requests Search Console read-only alongside existing export scopes", () => {
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/webmasters.readonly");
    expect(GOOGLE_SCOPES).not.toContain("https://www.googleapis.com/auth/webmasters");
  });

  it("reports explicitly unavailable when credentials are not configured", async () => {
    const app = createApp({ serveClient: false });
    await request(app).get("/api/integrations/google/status").expect(200, {
      configured: false,
      connected: false,
      connected_at: null,
    });
    await request(app).get("/api/integrations/google/connect").expect(503);
  });

  it("revokes through the client before returning disconnected", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const store = {
      status: vi.fn().mockResolvedValue({
        connected: true,
        connectedAt: "2026-08-20T10:00:00.000Z",
      }),
    } as unknown as GoogleTokenStore;
    const client = { disconnect } as unknown as GoogleOAuthClient;
    const app = createApp({
      serveClient: false,
      googleOAuth: { configured: true, store, client },
    });
    await request(app).get("/api/integrations/google/status").expect(200, {
      configured: true,
      connected: true,
      connected_at: "2026-08-20T10:00:00.000Z",
    });
    await request(app).delete("/api/integrations/google").expect(204);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("returns 204 and safely logs when only an unreadable local connection was cleared", async () => {
    const disconnect = vi.fn().mockResolvedValue("local_only");
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const app = createApp({
      serveClient: false,
      googleOAuth: {
        configured: true,
        store: {} as GoogleTokenStore,
        client: { disconnect } as unknown as GoogleOAuthClient,
      },
    });

    await request(app).delete("/api/integrations/google").expect(204);

    expect(warning).toHaveBeenCalledWith("google_oauth.disconnect_local_only", {
      provider: "google",
      outcome: "local_connection_cleared_without_remote_revoke",
      reason_code: "stored_connection_unreadable",
    });
    warning.mockRestore();
  });

  it("binds state to a cross-site-callback-safe one-use cookie and rejects missing, mismatched, and replayed cookies", async () => {
    const exchangeCode = vi.fn().mockResolvedValue(undefined);
    const client = {
      authorisationUrl: (state: string) => `https://accounts.google.test/auth?state=${state}`,
      exchangeCode,
    } as unknown as GoogleOAuthClient;
    const app = createApp({
      serveClient: false,
      googleOAuth: { configured: true, client, store: {} as GoogleTokenStore },
    });
    const start = await request(app).get("/api/integrations/google/connect").expect(303);
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]?.[0]);
    expect(cookie).toContain("HttpOnly");
    // Google's top-level redirect is cross-site, so Strict would omit this cookie
    // and make every legitimate callback fail as invalid_callback.
    expect(cookie).toContain("SameSite=Lax");

    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${state}`)
      .expect("Location", "/?google=error&code=invalid_callback")
      .expect(303);

    const second = await request(app).get("/api/integrations/google/connect");
    const secondState = new URL(String(second.headers.location)).searchParams.get("state")!;
    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${secondState}`)
      .set("Cookie", "google_oauth_state=wrong")
      .expect("Location", "/?google=error&code=invalid_callback")
      .expect(303);

    const third = await request(app).get("/api/integrations/google/connect");
    const thirdState = new URL(String(third.headers.location)).searchParams.get("state")!;
    const thirdCookie = String(third.headers["set-cookie"]?.[0]).split(";")[0]!;
    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${thirdState}`)
      .set("Cookie", thirdCookie)
      .expect("Location", "/?google=success&code=connected")
      .expect(303);
    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${thirdState}`)
      .set("Cookie", thirdCookie)
      .expect("Location", "/?google=error&code=invalid_callback")
      .expect(303);
    expect(exchangeCode).toHaveBeenCalledOnce();
  });

  it("rejects an expired state and consumes it", async () => {
    const client = {
      authorisationUrl: (state: string) => `https://accounts.google.test/auth?state=${state}`,
      exchangeCode: vi.fn(),
    } as unknown as GoogleOAuthClient;
    const app = createApp({
      serveClient: false,
      googleOAuth: { configured: true, client, store: {} as GoogleTokenStore },
    });
    const start = await request(app).get("/api/integrations/google/connect");
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]?.[0]).split(";")[0]!;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${state}`)
      .set("Cookie", cookie)
      .expect("Location", "/?google=error&code=invalid_callback")
      .expect(303);
    expect(client.exchangeCode).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("redirects to the configured client origin, not the API's own origin, once one is set", async () => {
    // The callback always lives on the API origin (it must match
    // GOOGLE_OAUTH_REDIRECT_URI exactly), but in local dev the SPA is served
    // from a different origin (Vite). Without clientOrigin, a bare relative
    // redirect resolves against the API's own origin and dead-ends there.
    const exchangeCode = vi.fn().mockResolvedValue(undefined);
    const client = {
      authorisationUrl: (state: string) => `https://accounts.google.test/auth?state=${state}`,
      exchangeCode,
    } as unknown as GoogleOAuthClient;
    const app = createApp({
      serveClient: false,
      googleOAuth: {
        configured: true,
        client,
        store: {} as GoogleTokenStore,
        clientOrigin: "http://127.0.0.1:5173",
      },
    });
    const start = await request(app).get("/api/integrations/google/connect");
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]?.[0]).split(";")[0]!;
    await request(app)
      .get(`/api/integrations/google/callback?code=x&state=${state}`)
      .set("Cookie", cookie)
      .expect("Location", "http://127.0.0.1:5173/?google=success&code=connected")
      .expect(303);
    expect(exchangeCode).toHaveBeenCalledOnce();
  });

  it("handles OAuth denial with an explicit UI code", async () => {
    const client = {
      authorisationUrl: (state: string) => `https://accounts.google.test/auth?state=${state}`,
      exchangeCode: vi.fn(),
    } as unknown as GoogleOAuthClient;
    const app = createApp({
      serveClient: false,
      googleOAuth: { configured: true, client, store: {} as GoogleTokenStore },
    });
    const start = await request(app).get("/api/integrations/google/connect");
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]?.[0]).split(";")[0]!;
    await request(app)
      .get(`/api/integrations/google/callback?error=access_denied&state=${state}`)
      .set("Cookie", cookie)
      .expect("Location", "/?google=error&code=access_denied")
      .expect(303);
  });
});

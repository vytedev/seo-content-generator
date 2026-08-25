import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { authConfigFromEnv } from "../src/server/auth/config.js";
import { encodePassword, verifyPassword } from "../src/server/auth/crypto.js";
import { LoginThrottle } from "../src/server/auth/auth.js";
import { MemorySessionStore } from "../src/server/auth/session-store.js";

async function authenticatedApp() {
  const store = new MemorySessionStore();
  const app = createApp({
    serveClient: false,
    auth: {
      mode: "enabled",
      store,
      config: {
        OPERATOR_EMAIL: "operator@example.com",
        OPERATOR_PASSWORD_HASH: await encodePassword("correct horse battery staple"),
        SESSION_SECRET: "test-secret-that-is-at-least-32-characters",
        SESSION_TTL_HOURS: 12,
      },
    },
  });
  return { app, store };
}

describe("operator authentication", () => {
  it("loads fail-closed all-or-nothing configuration", () => {
    expect(authConfigFromEnv({})).toBeUndefined();
    expect(() => authConfigFromEnv({ OPERATOR_EMAIL: "operator@example.com" })).toThrow(
      "incomplete or invalid",
    );
  });

  it("encodes and verifies bounded scrypt hashes", async () => {
    const hash = await encodePassword("password");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword("password", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("password", "invalid")).toBe(false);
  });

  it("logs in with a host-only strict cookie and protects APIs with session and CSRF", async () => {
    const { app, store } = await authenticatedApp();
    await request(app).post("/api/checker").send({}).expect(401);
    await request(app)
      .post("/api/checker")
      .set("Content-Type", "application/json")
      .send("{malformed")
      .expect(401);
    await request(app).get("/api/integrations/google/status").expect(401);
    await request(app).get("/api/integrations/google/callback").expect(503);
    const login = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ email: "operator@example.com", password: "correct horse battery staple" })
      .expect(200);
    const setCookie = String(login.headers["set-cookie"]?.[0]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
    expect(login.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(login.headers["access-control-allow-credentials"]).toBe("true");
    const cookie = setCookie.split(";")[0]!;
    const csrf = login.body.csrf_token as string;
    expect(store.sessions.size).toBe(1);
    expect([...store.sessions.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(setCookie).not.toContain([...store.sessions.keys()][0]!);

    const session = await request(app).get("/api/auth/session").set("Cookie", cookie).expect(200);
    expect(session.body).toMatchObject({
      authenticated: true,
      operator: {
        id: "local-operator",
        display_name: "Aaron",
        email: "operator@example.com",
        account_type: "Local operator",
      },
    });
    await request(app).post("/api/checker").set("Cookie", cookie).send({}).expect(403);
    await request(app)
      .post("/api/checker")
      .set("Cookie", cookie)
      .set("Origin", "http://127.0.0.1:5173")
      .set("X-CSRF-Token", csrf)
      .send({})
      .expect(400);
    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("Origin", "http://127.0.0.1:5173")
      .set("X-CSRF-Token", csrf)
      .expect(204);
    await request(app).get("/api/auth/session").set("Cookie", cookie).expect(401);

    const rotationLogin = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie)
      .send({ email: "operator@example.com", password: "correct horse battery staple" })
      .expect(200);
    expect(String(rotationLogin.headers["set-cookie"]?.[0]).split(";")[0]).not.toBe(cookie);
  });

  it("uses generic errors, an origin allowlist and bounded per-IP throttling", async () => {
    const { app } = await authenticatedApp();
    await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:5173")
      .send({ email: "operator@example.com", password: "correct horse battery staple" })
      .expect(401, {
        error: { code: "INVALID_CREDENTIALS", message: "The email or password is incorrect." },
      });
    const throttle = new LoginThrottle(2, 60_000, 2);
    expect(throttle.allowed("a", 0)).toBe(true);
    throttle.fail("a", 0);
    throttle.fail("a", 0);
    expect(throttle.allowed("a", 1)).toBe(false);
    throttle.fail("b", 0);
    throttle.fail("c", 0);
    expect(throttle.allowed("a", 1)).toBe(true);

    const limitedStore = new MemorySessionStore();
    const limitedApp = createApp({
      serveClient: false,
      auth: {
        mode: "enabled",
        store: limitedStore,
        throttle: new LoginThrottle(1, 60_000),
        config: {
          OPERATOR_EMAIL: "operator@example.com",
          OPERATOR_PASSWORD_HASH: await encodePassword("correct horse battery staple"),
          SESSION_SECRET: "test-secret-that-is-at-least-32-characters",
          SESSION_TTL_HOURS: 12,
        },
      },
    });
    await request(limitedApp)
      .post("/api/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ email: "operator@example.com", password: "wrong" })
      .expect(401);
    await request(limitedApp)
      .post("/api/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ email: "operator@example.com", password: "wrong" })
      .expect(429, {
        error: {
          code: "AUTH_RATE_LIMITED",
          message: "Too many sign-in attempts. Wait before trying again.",
        },
      });
  });
});

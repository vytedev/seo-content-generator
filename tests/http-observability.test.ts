import { createServer, request as httpRequest } from "node:http";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { ConflictError } from "../src/shared/errors.js";
import { encodePassword } from "../src/server/auth/crypto.js";

function loggedEvents(write: { mock: { calls: unknown[][] } }) {
  return write.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

function terminalFor(events: Record<string, unknown>[], requestId: string) {
  return events.filter(
    (event) =>
      event.request_id === requestId &&
      String(event.event).startsWith("http.request_") &&
      event.event !== "http.request_started",
  );
}

function expectSafeTerminal(event: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(event).toMatchObject({
    request_id: expect.any(String),
    path: expect.any(String),
    ...expected,
  });
  expect(event).toHaveProperty("category");
  expect(event).toHaveProperty("reason_code");
  expect(JSON.stringify(event)).not.toMatch(/private|do-not-log|raw-identifier/);
}

describe("HTTP request correlation", () => {
  it("accepts strict request IDs and correlates started/completed events", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const response = await request(createApp({ serveClient: false }))
      .get("/api/health?private=do-not-log")
      .set("X-Request-ID", "request_12345678")
      .expect(200);
    expect(response.headers["x-request-id"]).toBe("request_12345678");
    const events = loggedEvents(write).filter((event) => event.request_id === "request_12345678");
    expect(events.map((event) => event.event)).toEqual([
      "http.request_started",
      "http.request_completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("do-not-log");
    write.mockRestore();
  });

  it("redacts unknown path segments so client-chosen values never enter logs", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const response = await request(createApp({ serveClient: false }))
      .get("/api/missing/do-not-log?private=yes")
      .expect(404);
    const events = loggedEvents(write).filter(
      (event) => event.request_id === response.headers["x-request-id"],
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.path)).toEqual(["/api/:value/:value", "/api/:value/:value"]);
    expect(JSON.stringify(events)).not.toMatch(/do-not-log|missing|private/);
    write.mockRestore();
  });

  it("classifies status-derived terminal failures exactly once without unsafe paths", async () => {
    const calibrationApp = (failure?: Error) =>
      createApp({
        serveClient: false,
        calibration: {
          repository: {} as never,
          service: {
            start: async () => {
              if (failure) throw failure;
              return {};
            },
          } as never,
        },
      });
    const cases = [
      {
        status: 404,
        app: createApp({ serveClient: false }),
        send: (app: ReturnType<typeof createApp>) =>
          request(app).get("/api/missing/raw-identifier-123456789?private=yes"),
        expected: { category: "not_found", reason_code: "resource_not_found" },
      },
      {
        status: 409,
        app: calibrationApp(new ConflictError("race")),
        send: (app: ReturnType<typeof createApp>) =>
          request(app).post("/api/calibrations").send({ idempotency_key: "safe-key" }),
        expected: { category: "conflict", reason_code: "state_conflict" },
      },
      {
        status: 422,
        app: calibrationApp(),
        send: (app: ReturnType<typeof createApp>) =>
          request(app).post("/api/calibrations").send({}),
        expected: { category: "validation", reason_code: "unprocessable" },
      },
      {
        status: 503,
        app: createApp({ serveClient: false, workerHealth: () => ({ status: "failed" }) }),
        send: (app: ReturnType<typeof createApp>) => request(app).get("/api/health"),
        expected: { category: "server", reason_code: "server_error" },
      },
      {
        status: 500,
        app: calibrationApp(new Error("sentinel-private")),
        send: (app: ReturnType<typeof createApp>) =>
          request(app).post("/api/calibrations").send({ idempotency_key: "safe-key" }),
        expected: { category: "internal", reason_code: "internal_error" },
      },
    ];
    for (const testCase of cases) {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const response = await testCase.send(testCase.app).expect(testCase.status);
      const terminal = terminalFor(loggedEvents(write), String(response.headers["x-request-id"]));
      expect(terminal).toHaveLength(1);
      expectSafeTerminal(terminal[0]!, testCase.expected);
      write.mockRestore();
    }
  });

  it("classifies 401, 403 preflight and 413 exactly once", async () => {
    const auth = {
      mode: "enabled" as const,
      store: new (await import("../src/server/auth/session-store.js")).MemorySessionStore(),
      config: {
        OPERATOR_EMAIL: "operator@example.com",
        OPERATOR_PASSWORD_HASH: await encodePassword("correct horse battery staple"),
        SESSION_SECRET: "test-secret-that-is-at-least-32-characters",
        SESSION_TTL_HOURS: 12,
      },
    };
    const app = createApp({ serveClient: false, auth });
    const calls = [
      () => request(app).post("/api/checker").send({}).expect(401),
      () =>
        request(app).options("/api/health").set("Origin", "https://invalid.example").expect(403),
    ];
    for (const call of calls) {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const response = await call();
      const terminal = terminalFor(loggedEvents(write), String(response.headers["x-request-id"]));
      expect(terminal).toHaveLength(1);
      expectSafeTerminal(terminal[0]!, { category: "auth", reason_code: "access_denied" });
      write.mockRestore();
    }

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const response = await request(createApp({ serveClient: false }))
      .post("/api/checker")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ private: "x".repeat(110_000) }))
      .expect(413);
    const terminal = terminalFor(loggedEvents(write), String(response.headers["x-request-id"]));
    expect(terminal).toHaveLength(1);
    expectSafeTerminal(terminal[0]!, { category: "validation", reason_code: "payload_too_large" });
    write.mockRestore();
  });

  it("records successful OPTIONS preflight exactly once", async () => {
    const app = createApp({
      serveClient: false,
      auth: {
        mode: "enabled",
        store: new (await import("../src/server/auth/session-store.js")).MemorySessionStore(),
        config: {
          OPERATOR_EMAIL: "operator@example.com",
          OPERATOR_PASSWORD_HASH: await encodePassword("correct horse battery staple"),
          SESSION_SECRET: "test-secret-that-is-at-least-32-characters",
          SESSION_TTL_HOURS: 12,
        },
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const response = await request(app)
      .options("/api/health")
      .set("Origin", "http://127.0.0.1:5173")
      .expect(204);
    expect(terminalFor(loggedEvents(write), String(response.headers["x-request-id"]))).toHaveLength(
      1,
    );
    write.mockRestore();
  });

  it("records an aborted request exactly once with safe classification", async () => {
    const app = createApp({
      serveClient: false,
      calibration: {
        repository: {} as never,
        service: { start: () => new Promise(() => undefined) } as never,
      },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address unavailable");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/calibrations?private=yes",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "30",
        "X-Request-ID": "aborted_request_123",
      },
    });
    client.on("error", () => undefined);
    client.write('{"idempotency_key":"safe-key"}');
    await vi.waitFor(() =>
      expect(loggedEvents(write).some((event) => event.event === "http.request_started")).toBe(
        true,
      ),
    );
    client.destroy();
    await vi.waitFor(() =>
      expect(terminalFor(loggedEvents(write), "aborted_request_123")).toHaveLength(1),
    );
    expectSafeTerminal(terminalFor(loggedEvents(write), "aborted_request_123")[0]!, {
      event: "http.request_aborted",
      category: "request_aborted",
      reason_code: "request_aborted",
      path: "/api/calibrations",
    });
    write.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("replaces invalid IDs and correlates a safely classified failed request", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = createApp({ serveClient: false });
    const response = await request(app)
      .post("/api/checker")
      .set("X-Request-ID", "bad id with spaces")
      .set("Content-Type", "application/json")
      .send('{"private":')
      .expect(400);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const events = loggedEvents(write).filter(
      (event) => event.request_id === response.headers["x-request-id"],
    );
    expect(events.map((event) => event.event)).toEqual([
      "http.request_started",
      "http.request_failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    write.mockRestore();
  });
});

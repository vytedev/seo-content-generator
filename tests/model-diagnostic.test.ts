import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { SESSION_COOKIE } from "../src/server/auth/auth.js";
import { encodePassword } from "../src/server/auth/crypto.js";
import { MemorySessionStore } from "../src/server/auth/session-store.js";
import { MemoryModelDiagnosticStore } from "../src/server/repositories/model-diagnostic-repository.js";
import { ModelDiagnosticService } from "../src/server/services/model-diagnostic-service.js";

const key = "123e4567-e89b-42d3-a456-426614174000";
const secret = "diagnostic-secret-value-that-must-never-leak";
const model = "provider/pinned-model";

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service(fetcher = vi.fn().mockResolvedValue(response(200, successBody()))) {
  return {
    fetcher,
    store: new MemoryModelDiagnosticStore(),
    diagnostic: new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher,
      timeoutMs: 10,
    }),
  };
}

function successBody() {
  return {
    choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 4, completion_tokens: 1, cost: 0.000001 },
  };
}

async function authenticatedDiagnosticApp(diagnostic: ModelDiagnosticService) {
  const store = new MemorySessionStore();
  const app = createApp({
    serveClient: false,
    modelDiagnostic: diagnostic,
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
  const login = await request(app)
    .post("/api/auth/login")
    .set("Origin", "http://127.0.0.1:5173")
    .send({ email: "operator@example.com", password: "correct horse battery staple" });
  return {
    app,
    cookie: String(login.headers["set-cookie"]?.[0]).split(";")[0]!,
    csrf: login.body.csrf_token as string,
  };
}

function post(
  app: ReturnType<typeof createApp>,
  cookie: string,
  csrf: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post("/api/integrations/model/diagnostic")
    .set("Cookie", cookie)
    .set("Origin", "http://127.0.0.1:5173")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .set("Content-Type", "application/json")
    .send(body);
}

describe("OpenRouter diagnostic endpoint", () => {
  it("requires operator authentication, CSRF, strict JSON, confirmation and an idempotency key", async () => {
    const { diagnostic, fetcher } = service();
    const { app, cookie, csrf } = await authenticatedDiagnosticApp(diagnostic);
    await request(app).post("/api/integrations/model/diagnostic").send({}).expect(401);
    await request(app)
      .post("/api/integrations/model/diagnostic")
      .set("Cookie", cookie)
      .set("Origin", "http://127.0.0.1:5173")
      .set("Idempotency-Key", key)
      .send({ explicit_confirmation: true })
      .expect(403);
    await post(app, cookie, csrf, {}).expect(400);
    await post(app, cookie, csrf, { explicit_confirmation: false }).expect(400);
    await post(app, cookie, csrf, { explicit_confirmation: true, prompt: "unsafe" }).expect(400);
    await request(app)
      .post("/api/integrations/model/diagnostic")
      .set("Cookie", cookie)
      .set("Origin", "http://127.0.0.1:5173")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", key)
      .set("Content-Type", "text/plain")
      .send('{"explicit_confirmation":true}')
      .expect(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("makes one tiny fixed request and replays the safe result without creating a run", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, successBody()));
    const store = new MemoryModelDiagnosticStore();
    const diagnostic = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store,
      fetcher,
    });
    const { app, cookie, csrf } = await authenticatedDiagnosticApp(diagnostic);
    const first = await post(app, cookie, csrf, { explicit_confirmation: true }).expect(200);
    const replay = await post(app, cookie, csrf, { explicit_confirmation: true }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toEqual({
      provider: "openrouter",
      model,
      status: "success",
      error_category: null,
      message: "OpenRouter responded successfully.",
      input_tokens: 4,
      output_tokens: 1,
      cost_micros: 1,
      latency_ms: expect.any(Number),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model,
      messages: [{ role: "user", content: "Return exactly OK" }],
      max_tokens: 5,
      temperature: 0,
    });
    expect(String((init.headers as Record<string, string>).Authorization)).toContain(secret);
    expect(first.text).not.toContain(secret);
    expect(store.operations.size).toBe(1);
    expect(store.operations.get(key)?.status).toBe("succeeded");
    // No run service is involved or registered by this diagnostic-only app.
    await request(app).get("/api/runs").set("Cookie", cookie).expect(404);
  });

  it("fails closed for a concurrent double click and never starts a second request", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const diagnostic = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher,
    });
    const first = diagnostic.run(key);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await expect(diagnostic.run(key)).resolves.toMatchObject({
      status: "failed",
      error_category: "ambiguous_previous_attempt",
    });
    release(response(200, successBody()));
    await expect(first).resolves.toMatchObject({ status: "success" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "request_rejected"],
    [401, "invalid_credentials"],
    [402, "billing_required"],
    [403, "access_denied"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
  ])("maps HTTP %s safely without retries", async (status, category) => {
    const fetcher = vi.fn().mockResolvedValue(response(status, { secret, raw: "unsafe" }));
    const store = new MemoryModelDiagnosticStore();
    const diagnostic = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store,
      fetcher,
    });
    const result = await diagnostic.run(crypto.randomUUID());
    expect(result).toMatchObject({ status: "failed", error_category: category });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("unsafe");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps invalid successful responses safely with no retry", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { secret, choices: [] }));
    const diagnostic = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher,
    });
    const result = await diagnostic.run(crypto.randomUUID());
    expect(result).toMatchObject({ error_category: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps timeout and network failures safely with no retry", async () => {
    const abortingFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error(secret), { name: "AbortError" })),
          );
        }),
    );
    const timeout = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher: abortingFetch as typeof fetch,
      timeoutMs: 1,
    });
    expect(await timeout.run(crypto.randomUUID())).toMatchObject({ error_category: "timeout" });
    expect(abortingFetch).toHaveBeenCalledTimes(1);

    const networkFetch = vi.fn().mockRejectedValue(new Error(secret));
    const network = new ModelDiagnosticService({
      provider: {
        token: secret,
        model,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        providerName: "openrouter",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher: networkFetch,
    });
    const result = await network.run(crypto.randomUUID());
    expect(result).toMatchObject({ error_category: "network_error" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it("does not request OpenRouter when absent or Hugging Face is active", async () => {
    const fetcher = vi.fn();
    const absent = new ModelDiagnosticService({
      store: new MemoryModelDiagnosticStore(),
      fetcher,
    });
    expect(await absent.run(key)).toMatchObject({ error_category: "unavailable", model: null });
    const hf = new ModelDiagnosticService({
      provider: {
        token: secret,
        model: "hf/model",
        baseUrl: "https://router.huggingface.co/v1/chat/completions",
        providerName: "huggingface",
      },
      store: new MemoryModelDiagnosticStore(),
      fetcher,
    });
    expect(await hf.run(key)).toMatchObject({ error_category: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

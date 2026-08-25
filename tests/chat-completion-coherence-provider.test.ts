import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoherenceRequest } from "../src/shared/milestone-four.js";
import { CoherenceResponseSchema } from "../src/shared/milestone-four.js";
import {
  CoherenceProviderError,
  ChatCompletionCoherenceProvider,
  buildCoherenceMessages,
} from "../src/server/providers/chat-completion-coherence-provider.js";
const TEST_MODEL = "provider/configured-model";
import type { StructuredDraft } from "../src/shared/milestone-two.js";

const TOKEN = "openrouter_test_key_not_real";
const noSleep = () => Promise.resolve();

function validDraft(): StructuredDraft {
  return {
    title: "A guide to walnut dining tables",
    slug: "walnut-dining-tables",
    meta_description: "A practical Mobelaris guide to walnut dining tables.",
    og_title: "Walnut dining tables",
    og_description: "A practical guide.",
    images: [
      {
        alt: "A walnut dining table",
        filename: "walnut-dining-table",
        placement: { marker: "walnut-table" },
      },
    ],
    faqs: [{ question: "How do I care for walnut?", answer: "Oil it seasonally." }],
    markdown:
      "# Walnut dining tables\n\n<!-- MOBELARIS_IMAGE:walnut-table -->\n\nConsider your proportions before choosing a table.",
    claims: [{ text: "Solid walnut is a hardwood", type: "material", status: "unverified" }],
  };
}

function validRequest(model = TEST_MODEL): CoherenceRequest {
  return {
    operation_id: "coherence-op-1",
    run_id: "run-1",
    parent_document_version_id: "docver-1",
    document_version_id: "docver-2",
    revision_reason: "operator_findings",
    coherence_cycle: 0,
    handoff: {
      plane_ticket: "MOB-123",
      primary_keyword: "walnut dining tables",
      related_keywords: ["walnut table"],
      page_type: "blog",
      word_count_target: 1200,
      locales_for_translation: [],
      notes: "Focus on modern interiors",
    },
    parent_document: validDraft(),
    current_document: validDraft(),
    revision_audits: [
      {
        finding_id: "finding-1",
        status: "applied",
        reason: "Applied.",
        location: { field: "body_markdown", line_start: 5 },
        hunks: [
          {
            source_start: 5,
            source_end: 5,
            proposed_start: 5,
            proposed_end: 5,
            before_hash: "b".repeat(64),
            after_hash: "c".repeat(64),
          },
        ],
        changed: true,
        before_hash: "b".repeat(64),
        after_hash: "c".repeat(64),
      },
    ],
    deterministic_result_hash: "a".repeat(64),
    reference_snapshots: [],
    prompt: { template_id: "mobelaris.final_coherence", template_version: "1.0.0" },
    model,
    temperature: 0.1,
  };
}

function modelFinding(): Record<string, unknown> {
  return {
    k: "grammar-revision-introduced",
    q: "change-0001",
    c: "grammar",
    v: "warning",
    i: "The revision introduced a sentence fragment.",
    x: "Restore the full sentence structure from before the revision.",
  };
}

function completion(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function wire(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    id: "openrouter-chatcmpl-test",
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  };
}

function makeProvider(fetcher: typeof fetch) {
  return new ChatCompletionCoherenceProvider({
    token: TOKEN,
    model: TEST_MODEL,
    fetcher,
    sleep: noSleep,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatCompletionCoherenceProvider construction", () => {
  it("throws a clear typed error when the token is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    expect(() => new ChatCompletionCoherenceProvider()).toThrow(CoherenceProviderError);
    expect(() => new ChatCompletionCoherenceProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("pins the default model and records it in provider identity", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    const provider = makeProvider(vi.fn());
    expect(provider.provider).toBe("openrouter");
    expect(provider.model).toBe(TEST_MODEL);
  });
});

describe("ChatCompletionCoherenceProvider.review", () => {
  it("fails explicitly when the provider reports token-limit truncation", async () => {
    const fetcher = vi.fn(async () =>
      completion({
        choices: [{ message: { content: '{"findings":[' }, finish_reason: "length" }],
      }),
    );
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toMatchObject({
      code: "COHERENCE_PROVIDER_TRUNCATED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("parses valid findings, normalises section locations and maps usage", async () => {
    const fetcher = vi.fn(async () =>
      completion(
        wire(JSON.stringify({ f: [modelFinding()] }), {
          prompt_tokens: 44,
          completion_tokens: 21,
        }),
      ),
    );
    const response = await makeProvider(fetcher).review(validRequest());
    expect(() => CoherenceResponseSchema.parse(response)).not.toThrow();
    expect(response.findings).toHaveLength(1);
    expect(response.findings[0]?.location).toEqual({
      field: "body_markdown",
      line_start: 5,
      line_end: 5,
    });
    expect(response.usage).toEqual({
      input_units: 44,
      output_units: 21,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body).model).toBe(TEST_MODEL);
  });

  it("preserves the exact persisted markdown field on app-owned targets", async () => {
    const request = validRequest();
    request.revision_audits[0]!.location.field = "markdown";
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ f: [modelFinding()] }))));
    const response = await makeProvider(fetcher).review(request);
    expect(response.findings[0]?.location).toEqual({
      field: "markdown",
      line_start: 5,
      line_end: 5,
    });
  });

  it("accepts an empty findings array for a coherent document", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ f: [] }))));
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.findings).toEqual([]);
  });

  it("rejects fenced, markdown-wrapped JSON after one correction", async () => {
    const fetcher = vi.fn(async () =>
      completion(wire("```json\n" + JSON.stringify({ f: [modelFinding()] }) + "\n```")),
    );
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toThrow(
      "unparseable output after 2 attempts",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the single bounded corrective re-request after invalid JSON", async () => {
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(completion(wire("prose without any object")))
      .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [modelFinding()] }))));
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.findings).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetcher.mock.calls[1] as unknown as [{}, { body: string }])[1].body,
    );
    expect(
      secondBody.messages.some((m: { content: string }) =>
        /previous reply was invalid/.test(m.content),
      ),
    ).toBe(true);
  });

  it("throws a typed redacted error when all attempts return unparseable output", async () => {
    const fetcher = vi.fn(async () => completion(wire("{ definitely not json")));
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CoherenceProviderError);
        expect((error as CoherenceProviderError).code).toBe("COHERENCE_PROVIDER_UNPARSEABLE");
        expect((error as CoherenceProviderError).message).toMatch(
          /unparseable output after 2 attempts/,
        );
        expect((error as CoherenceProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 once and then succeeds", async () => {
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [modelFinding()] }))));
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.findings).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps an aborted request to a redacted timeout error", async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CoherenceProviderError);
        expect((error as CoherenceProviderError).code).toBe("COHERENCE_PROVIDER_TIMEOUT");
        expect((error as CoherenceProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
  });

  it("gives a clear billing message for a 402, not a raw status code", async () => {
    const fetcher = vi.fn(async () => new Response("payment required", { status: 402 }));
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CoherenceProviderError);
        expect((error as CoherenceProviderError).code).toBe("COHERENCE_PROVIDER_HTTP_STATUS");
        expect((error as CoherenceProviderError).message).toBe(
          "Coherence provider account has no billing configured for model usage",
        );
        expect((error as CoherenceProviderError).message).not.toMatch(/HTTP 402/);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a request whose model does not match the pinned model", async () => {
    const fetcher = vi.fn();
    await expect(makeProvider(fetcher).review(validRequest("other/model"))).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CoherenceProviderError);
        expect((error as CoherenceProviderError).code).toBe("COHERENCE_PROVIDER_MODEL_MISMATCH");
        return true;
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("coherence prompt contract", () => {
  it("instructs revision-scoped findings, blocker discipline and UK English", () => {
    const messages = buildCoherenceMessages(validRequest());
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toMatch(/INTRODUCED by the revision/);
    expect(messages[0]?.content).toMatch(/blocker/);
    expect(messages[0]?.content).toMatch(/British English/);
    expect(messages[0]?.content).toMatch(/never rewritten prose/);
    expect(messages[0]?.content).toContain('"k":"unique-key"');
    expect(messages[0]?.content).toContain('"x":"bounded correction"');
    const user = messages[1]?.content ?? "";
    expect(user).toContain("walnut dining tables");
    expect(user).toContain("App-issued changed targets");
    expect(user).toContain('"id":"change-0001"');
    expect(user).not.toContain("Revised document");
  });
});

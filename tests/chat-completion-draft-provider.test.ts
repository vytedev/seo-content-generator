import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftProviderRequest, StructuredDraft } from "../src/shared/milestone-two.js";
import { mapDeterministicInput } from "../src/shared/milestone-three.js";
import { runDeterministicChecks } from "../src/shared/checker/index.js";
import { buildMockDraft } from "../src/server/providers/draft-provider.js";
import { DraftProviderResponseSchema } from "../src/shared/milestone-two.js";
import {
  DraftProviderError,
  ChatCompletionDraftProvider,
  buildDraftMessages,
  extractJsonObject,
} from "../src/server/providers/chat-completion-draft-provider.js";
const TEST_MODEL = "provider/configured-model";
import { createLocalServices } from "../src/server/local-services.js";

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
      "# Walnut dining tables\n\n<!-- MOBELARIS_IMAGE:walnut-table -->\n\nConsider your space before choosing a table.",
    claims: [{ text: "Solid walnut is a hardwood", type: "material", status: "unverified" }],
  };
}

function validRequest(model = TEST_MODEL): DraftProviderRequest {
  return {
    handoff: {
      plane_ticket: "MOB-123",
      primary_keyword: "walnut dining tables",
      related_keywords: ["walnut table"],
      page_type: "blog",
      word_count_target: 1200,
      locales_for_translation: [],
      notes: "Focus on modern interiors",
    },
    internal_links: [
      {
        url: "https://www.mobelaris.com/blogs/furniture-guides",
        title: "Furniture guides",
        relevance: 0.9,
      },
    ],
    model,
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
  return new ChatCompletionDraftProvider({
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

describe("ChatCompletionDraftProvider construction", () => {
  it("throws a clear typed error when the token is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    expect(() => new ChatCompletionDraftProvider()).toThrow(DraftProviderError);
    expect(() => new ChatCompletionDraftProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("pins the default model and records it in provider identity", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    const provider = makeProvider(vi.fn());
    expect(provider.provider).toBe("openrouter");
    expect(provider.model).toBe(TEST_MODEL);
  });

  it("calls the injected Hugging Face endpoint, not the OpenRouter default, when configured for it", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify(validDraft()))));
    const provider = new ChatCompletionDraftProvider({
      token: "hf_test_key_not_real",
      model: "openai/gpt-oss-20b:fireworks-ai",
      baseUrl: "https://router.huggingface.co/v1/chat/completions",
      providerName: "huggingface",
      fetcher,
      sleep: noSleep,
    });
    expect(provider.provider).toBe("huggingface");

    await provider.generate(validRequest("openai/gpt-oss-20b:fireworks-ai"));

    expect(fetcher).toHaveBeenCalledWith(
      "https://router.huggingface.co/v1/chat/completions",
      expect.anything(),
    );
  });
});

describe("ChatCompletionDraftProvider.generate", () => {
  it("parses valid JSON, records the pinned model call and maps usage", async () => {
    const draft = validDraft();
    const fetcher = vi.fn(async () =>
      completion(wire(JSON.stringify(draft), { prompt_tokens: 41, completion_tokens: 97 })),
    );
    const response = await makeProvider(fetcher).generate(validRequest());
    expect(() => DraftProviderResponseSchema.parse(response)).not.toThrow();
    expect(response.draft).toEqual(draft);
    expect(response.usage).toEqual({
      input_units: 41,
      output_units: 97,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
    expect(response.request_id).toBe("openrouter-chatcmpl-test");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const requestBody = JSON.parse(init.body);
    expect(requestBody.model).toBe(TEST_MODEL);
    expect(requestBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "mobelaris_draft_v1", strict: true },
    });
    expect(requestBody.provider).toEqual({ require_parameters: true });
  });

  it("fails explicitly when the provider reports token-limit truncation", async () => {
    const fetcher = vi.fn(async () =>
      completion({
        choices: [{ message: { content: '{"title":' }, finish_reason: "length" }],
      }),
    );
    await expect(makeProvider(fetcher).generate(validRequest())).rejects.toMatchObject({
      code: "DRAFT_PROVIDER_TRUNCATED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still parses fenced, markdown-wrapped JSON", async () => {
    const draft = validDraft();
    const fetcher = vi.fn(async () =>
      completion(wire("```json\n" + JSON.stringify(draft) + "\n```")),
    );
    const response = await makeProvider(fetcher).generate(validRequest());
    expect(response.draft).toEqual(draft);
  });

  it("succeeds on the single bounded corrective re-request after invalid JSON", async () => {
    const draft = validDraft();
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(completion(wire("sorry, here is prose instead")))
      .mockResolvedValueOnce(completion(wire(JSON.stringify(draft))));
    const response = await makeProvider(fetcher).generate(validRequest());
    expect(response.draft).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetcher.mock.calls[1] as unknown as [{}, { body: string }])[1].body,
    );
    expect(
      secondBody.messages.some((m: { content: string }) =>
        /not a single valid JSON object/.test(m.content),
      ),
    ).toBe(true);
  });

  it("throws a typed redacted error when all attempts return unparseable output", async () => {
    const fetcher = vi.fn(async () => completion(wire("{ definitely not json")));
    await expect(makeProvider(fetcher).generate(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DraftProviderError);
        expect((error as DraftProviderError).code).toBe("DRAFT_PROVIDER_UNPARSEABLE");
        expect((error as DraftProviderError).message).toMatch(
          /unparseable output after 2 attempts/,
        );
        expect((error as DraftProviderError).message).not.toContain(TOKEN);
        expect((error as DraftProviderError).message).not.toContain("definitely not json");
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a 500 once and then succeeds", async () => {
    const draft = validDraft();
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("upstream exploded", { status: 500 }))
      .mockResolvedValueOnce(completion(wire(JSON.stringify(draft))));
    const response = await makeProvider(fetcher).generate(validRequest());
    expect(response.draft).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 and throws a redacted error", async () => {
    const fetcher = vi.fn(
      async () => new Response("bad request detail with secret", { status: 400 }),
    );
    await expect(makeProvider(fetcher).generate(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DraftProviderError);
        expect((error as DraftProviderError).code).toBe("DRAFT_PROVIDER_HTTP_STATUS");
        expect((error as DraftProviderError).message).toBe(
          "Draft provider request failed with HTTP 400",
        );
        expect((error as DraftProviderError).message).not.toContain("bad request detail");
        expect((error as DraftProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives a clear billing message for a 402, not a raw status code", async () => {
    const fetcher = vi.fn(async () => new Response("payment required", { status: 402 }));
    await expect(makeProvider(fetcher).generate(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DraftProviderError);
        expect((error as DraftProviderError).code).toBe("DRAFT_PROVIDER_HTTP_STATUS");
        expect((error as DraftProviderError).message).toBe(
          "Draft provider account has no billing configured for model usage",
        );
        expect((error as DraftProviderError).message).not.toMatch(/HTTP 402/);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a redacted timeout error", async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(makeProvider(fetcher).generate(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DraftProviderError);
        expect((error as DraftProviderError).code).toBe("DRAFT_PROVIDER_TIMEOUT");
        expect((error as DraftProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
  });

  it("rejects a request whose model does not match the pinned model", async () => {
    const fetcher = vi.fn();
    await expect(makeProvider(fetcher).generate(validRequest("other/model"))).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DraftProviderError);
        expect((error as DraftProviderError).code).toBe("DRAFT_PROVIDER_MODEL_MISMATCH");
        return true;
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to a deterministic request id when the wire response has none", async () => {
    const draft = validDraft();
    const fetcher = vi.fn(async () =>
      completion({ choices: [{ message: { content: JSON.stringify(draft) } }] }),
    );
    const response = await makeProvider(fetcher).generate(validRequest());
    expect(response.request_id).toMatch(/^request_[a-f0-9]{64}$/);
    expect(response.usage).toEqual({
      input_units: 0,
      output_units: 0,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
  });
});

describe("draft prompt contract", () => {
  it("includes only supplied frozen reference snapshots and prompt metadata", () => {
    const request = {
      ...validRequest(),
      prompt: { template_id: "mobelaris.draft" as const, template_version: "2.0.0" },
      reference_snapshots: [
        {
          kind: "blog_writing_guide",
          version_id: "reference-v1",
          content_hash: "a".repeat(64),
          immutable_pointer: "postgres://reference_versions/reference-v1",
          content: "Concise approved writing guidance.",
        },
      ],
    };
    const user = buildDraftMessages(request)[1]?.content ?? "";
    expect(user).toContain("mobelaris.draft@2.0.0");
    expect(user).toContain("blog_writing_guide");
    expect(user).toContain("Concise approved writing guidance.");
    expect(user).not.toContain("fact_checking_rules");
  });

  it("instructs UK English, carries the handoff and fixes the JSON shape", () => {
    const messages = buildDraftMessages(validRequest());
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toMatch(/British English/);
    expect(messages[0]?.content).toMatch(/exactly one H1/);
    const user = messages[1]?.content ?? "";
    expect(user).toContain("walnut dining tables");
    expect(user).toContain("Focus on modern interiors");
    expect(user).toContain("https://www.mobelaris.com/blogs/furniture-guides");
    expect(user).toContain("og_description");
    expect(user).toContain("claims");
    expect(user).toContain("unverified");
    for (const requirement of [
      "55–60 characters",
      "150–155 characters",
      "40–70 word direct answer",
      "first 100 body words",
      "## Key Takeaways",
      "3–5 unordered",
      "1–3 Markdown blockquote",
      "## Conclusion",
      "3–6 structured FAQ",
      "40–80 word answer",
      "Flesch-Kincaid Grade 8",
      "use only these internal URLs",
    ])
      expect(user).toContain(requirement);
    for (const type of [
      "dimension",
      "material",
      "price",
      "delivery",
      "statistic",
      "provenance",
      "general",
    ])
      expect(user).toContain(type);
  });

  it("builds a local mock draft with no deterministic blockers", () => {
    const request = validRequest("local-no-network");
    const draft = buildMockDraft(request);
    const fixture = {
      internal_origins: ["https://www.mobelaris.com"],
      link_verification: [
        {
          url: request.internal_links[0]!.url,
          status: 200,
          hierarchy: "collection" as const,
          hierarchy_rank: 1,
        },
      ],
    };
    const findings = runDeterministicChecks(
      mapDeterministicInput({
        run_id: "run-mock",
        document_version_id: "version-mock",
        handoff: request.handoff,
        draft,
        persisted_links: request.internal_links,
        fixture,
      }),
    );
    expect(findings.filter((finding) => finding.severity === "blocker")).toEqual([]);
  });
});

describe("extractJsonObject", () => {
  it("finds the outermost object inside fences and prose", () => {
    const value = extractJsonObject('Sure!\n```json\n{"a": {"b": 1}}\n```\nHope this helps.');
    expect(value).toEqual({ a: { b: 1 } });
    expect(extractJsonObject("no object here")).toBeUndefined();
    expect(extractJsonObject("{ broken")).toBeUndefined();
  });
});

describe("local-services draft provider selection", () => {
  const localDatabaseUrl = "postgresql://localhost:5432/mm0301_test";

  it("constructs the real provider when key and pinned model are present", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter_local_test_only");
    vi.stubEnv("OPENROUTER_MODEL", TEST_MODEL);
    const services = createLocalServices({
      databaseUrl: localDatabaseUrl,
      authMode: "disabled-test",
    });
    const drafts = (
      services.appOptions.milestoneTwo?.orchestrator as unknown as {
        drafts: { provider: string; model: string };
      }
    ).drafts;
    expect(drafts.provider).toBe("openrouter");
    expect(drafts.model).toBe(TEST_MODEL);
    await services.close();
  });

  it("fails closed when a provider key has no model", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter_local_test_only");
    vi.stubEnv("OPENROUTER_MODEL", undefined);
    expect(() =>
      createLocalServices({
        databaseUrl: localDatabaseUrl,
        authMode: "disabled-test",
      }),
    ).toThrow("openrouter requires both OPENROUTER_API_KEY and OPENROUTER_MODEL");
  });

  it("keeps the deterministic mock when no token is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    const services = createLocalServices({
      databaseUrl: localDatabaseUrl,
      authMode: "disabled-test",
    });
    const drafts = (
      services.appOptions.milestoneTwo?.orchestrator as unknown as {
        drafts: { provider: string; model: string };
      }
    ).drafts;
    expect(drafts.provider).toBe("mock");
    expect(drafts.model).toBe("local-no-network");
    await services.close();
  });
});

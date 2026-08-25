import { describe, expect, it, vi } from "vitest";
import { ChatCompletionDraftProvider } from "../src/server/providers/chat-completion-draft-provider.js";
const DEFAULT_OPENROUTER_MODEL = "openrouter/test-model";
import { ChatCompletionCoherenceProvider } from "../src/server/providers/chat-completion-coherence-provider.js";
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  openRouterOptionsFromEnv,
} from "../src/server/providers/openrouter.js";
import type { DraftProviderRequest } from "../src/shared/milestone-two.js";
import type { CoherenceRequest } from "../src/shared/milestone-four.js";

const noSleep = () => Promise.resolve();

const validDraft = {
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

const handoff = {
  plane_ticket: "MOB-123",
  primary_keyword: "walnut dining tables",
  related_keywords: ["walnut table"],
  page_type: "blog",
  word_count_target: 1200,
  locales_for_translation: [],
};

function draftRequest(model: string): DraftProviderRequest {
  return {
    handoff,
    internal_links: [],
    model,
  } as unknown as DraftProviderRequest;
}

function coherenceRequest(model: string): CoherenceRequest {
  return {
    operation_id: "coherence-op-1",
    run_id: "run-1",
    parent_document_version_id: "docver-1",
    document_version_id: "docver-2",
    revision_reason: "operator_findings",
    coherence_cycle: 0,
    handoff: { ...handoff, notes: "Focus on modern interiors" },
    parent_document: validDraft,
    current_document: validDraft,
    revision_audits: [],
    deterministic_result_hash: "a".repeat(64),
    reference_snapshots: [],
    prompt: { template_id: "mobelaris.final_coherence", template_version: "1.0.0" },
    model,
    temperature: 0.1,
  } as unknown as CoherenceRequest;
}

function completion(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("openRouterOptionsFromEnv", () => {
  it("returns undefined when no key is configured", () => {
    expect(openRouterOptionsFromEnv({})).toBeUndefined();
    expect(openRouterOptionsFromEnv({ OPENROUTER_API_KEY: "   " })).toBeUndefined();
  });

  it("returns undefined without an explicit pinned model", () => {
    expect(openRouterOptionsFromEnv({ OPENROUTER_API_KEY: "sk-test" })).toBeUndefined();
    expect(
      openRouterOptionsFromEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "  " }),
    ).toBeUndefined();
  });

  it("resolves the fixed endpoint, explicit model and provenance label", () => {
    expect(openRouterOptionsFromEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m/x" })).toEqual({
      token: "k",
      model: "m/x",
      baseUrl: OPENROUTER_CHAT_COMPLETIONS_URL,
      providerName: "openrouter",
    });
    expect(OPENROUTER_CHAT_COMPLETIONS_URL).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("OpenRouter wiring through the provider classes", () => {
  it("posts to the OpenRouter endpoint, labels usage openrouter and uses the reported cost", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      completion({
        id: "or-chatcmpl-1",
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      }),
    );
    const options = openRouterOptionsFromEnv({
      OPENROUTER_API_KEY: "sk-test",
      OPENROUTER_MODEL: DEFAULT_OPENROUTER_MODEL,
    })!;
    const provider = new ChatCompletionDraftProvider({
      ...options,
      fetcher: fetchMock,
      sleep: noSleep,
    });
    expect(provider.provider).toBe("openrouter");
    const response = await provider.generate(draftRequest(options.model));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      OPENROUTER_CHAT_COMPLETIONS_URL,
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.usage.cost_micros).toBe(1_000);
    expect(response.usage.input_units).toBe(10);
    expect(response.usage.output_units).toBe(5);
  });

  it("uses the OpenRouter label and endpoint by default", () => {
    const provider = new ChatCompletionCoherenceProvider({
      token: "openrouter-test-key",
      model: DEFAULT_OPENROUTER_MODEL,
      fetcher: vi.fn(),
      sleep: noSleep,
    });
    expect(provider.provider).toBe("openrouter");
  });

  it("bounds output tokens with max_tokens and reports measured latency", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      completion({
        id: "or-chatcmpl-2",
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      }),
    );
    const options = openRouterOptionsFromEnv({
      OPENROUTER_API_KEY: "sk-test",
      OPENROUTER_MODEL: DEFAULT_OPENROUTER_MODEL,
    })!;
    const provider = new ChatCompletionDraftProvider({
      ...options,
      fetcher: fetchMock,
      sleep: noSleep,
      maxOutputTokens: 4096,
    });
    const response = await provider.generate(draftRequest(options.model));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
    expect(body.model).toBe(options.model);
    expect(response.usage.latency_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(response.usage.latency_ms)).toBe(true);
  });

  it("reports zero invented cost when the endpoint sends no cost field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      completion({
        choices: [{ message: { content: JSON.stringify({ f: [] }) } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );
    const options = openRouterOptionsFromEnv({
      OPENROUTER_API_KEY: "sk-test",
      OPENROUTER_MODEL: "unknown/model",
    })!;
    const provider = new ChatCompletionCoherenceProvider({
      ...options,
      fetcher: fetchMock,
      sleep: noSleep,
    });
    const response = await provider.review(coherenceRequest("unknown/model"));
    expect(response.usage.cost_micros).toBe(0);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      OPENROUTER_CHAT_COMPLETIONS_URL,
      expect.anything(),
    );
  });
});

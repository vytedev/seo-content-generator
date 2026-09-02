import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/server/logger.js";
import {
  HUGGING_FACE_CHAT_COMPLETIONS_URL,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  logModelProviderHttpFailure,
  logModelProviderOutputInvalid,
  modelProviderOptionsFromEnv,
} from "../src/server/providers/model-provider.js";

describe("modelProviderOptionsFromEnv", () => {
  it("uses deterministic mocks when neither provider is configured", () => {
    expect(modelProviderOptionsFromEnv({})).toBeUndefined();
  });

  it("selects an explicit OpenRouter key and model pair", () => {
    expect(
      modelProviderOptionsFromEnv({
        OPENROUTER_API_KEY: "or-key",
        OPENROUTER_MODEL: "provider/model",
      }),
    ).toEqual({
      token: "or-key",
      model: "provider/model",
      baseUrl: OPENROUTER_CHAT_COMPLETIONS_URL,
      providerName: "openrouter",
    });
  });

  it("selects an explicit Hugging Face token and model pair", () => {
    expect(
      modelProviderOptionsFromEnv({ HF_TOKEN: "hf-key", HF_MODEL: "provider/model:route" }),
    ).toEqual({
      token: "hf-key",
      model: "provider/model:route",
      baseUrl: HUGGING_FACE_CHAT_COMPLETIONS_URL,
      providerName: "huggingface",
    });
  });

  it("fails closed for a partial provider configuration", () => {
    expect(() => modelProviderOptionsFromEnv({ HF_TOKEN: "hf-key" })).toThrow(
      "huggingface requires both HF_TOKEN and HF_MODEL",
    );
    expect(() => modelProviderOptionsFromEnv({ OPENROUTER_MODEL: "provider/model" })).toThrow(
      "openrouter requires both OPENROUTER_API_KEY and OPENROUTER_MODEL",
    );
  });

  it("refuses ambiguous dual-provider configuration", () => {
    expect(() =>
      modelProviderOptionsFromEnv({
        OPENROUTER_API_KEY: "or-key",
        OPENROUTER_MODEL: "provider/model",
        HF_TOKEN: "hf-key",
        HF_MODEL: "provider/model",
      }),
    ).toThrow("Configure exactly one model provider");
  });

  it("rejects an assignment-like Hugging Face model value pasted with its own key", () => {
    expect(() =>
      modelProviderOptionsFromEnv({
        HF_TOKEN: "hf-key",
        HF_MODEL: "HF_MODEL=openai/gpt-oss-20b:fireworks-ai",
      }),
    ).toThrow(/HF_MODEL must contain only the model ID/);
  });

  it("rejects an OpenRouter model value that starts with the wrong key's assignment", () => {
    expect(() =>
      modelProviderOptionsFromEnv({
        OPENROUTER_API_KEY: "or-key",
        OPENROUTER_MODEL: "OPENROUTER_MODEL=provider/model",
      }),
    ).toThrow(/OPENROUTER_MODEL must contain only the model ID/);
  });

  it("accepts a real model ID containing a colon route, which is not assignment-like", () => {
    expect(
      modelProviderOptionsFromEnv({
        HF_TOKEN: "hf-key",
        HF_MODEL: "openai/gpt-oss-20b:fireworks-ai",
      }),
    ).toMatchObject({ model: "openai/gpt-oss-20b:fireworks-ai" });
  });
});

describe("safe model-provider diagnostics", () => {
  it("logs the precise invalid-success reason and no unsafe response data", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    logModelProviderOutputInvalid("openrouter", "review", "provider/model", 2, "invalid_json");

    expect(warn).toHaveBeenCalledWith("model_provider.output_invalid", {
      provider: "openrouter",
      context: "review",
      model: "provider/model",
      attempts: 2,
      category: "structured_output_invalid",
      reason: "invalid_json",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("logs only the safe, documented field set — never a token, prompt, header or body", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    logModelProviderHttpFailure("huggingface", "coherence", "openai/gpt-oss-20b:fireworks-ai", 402);

    expect(warn).toHaveBeenCalledOnce();
    const [event, fields] = warn.mock.calls[0]!;
    expect(event).toBe("model_provider.request_rejected");
    expect(fields).toEqual({
      provider: "huggingface",
      context: "coherence",
      model: "openai/gpt-oss-20b:fireworks-ai",
      status: 402,
      category: "billing_required",
      connected: true,
    });
  });

  it("categorises each status into a safe, non-numeric failure category", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const cases: Array<[number, string]> = [
      [401, "invalid_credentials"],
      [403, "permission_guardrail_or_moderation"],
      [404, "endpoint_or_model_not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
      [418, "request_rejected"],
    ];
    for (const [status, category] of cases) {
      logModelProviderHttpFailure("openrouter", "draft", "provider/model", status);
      expect(warn).toHaveBeenLastCalledWith(
        "model_provider.request_rejected",
        expect.objectContaining({ category }),
      );
    }
  });
});

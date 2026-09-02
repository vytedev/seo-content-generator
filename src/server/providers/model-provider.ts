import { logger } from "../logger.js";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
export const HUGGING_FACE_CHAT_COMPLETIONS_URL =
  "https://router.huggingface.co/v1/chat/completions";

export interface ModelProviderOptions {
  readonly token: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly providerName: "openrouter" | "huggingface";
}

export type ModelProviderFailureContext = "draft" | "review" | "revision" | "coherence";
export type ModelProviderInvalidOutputReason =
  | "invalid_envelope"
  | "empty_content"
  | "invalid_json"
  | "schema_validation_failure"
  | "truncation";

/** Identifies the selected provider/model before a model operation begins. */
export function logModelProviderOperationStarted(
  provider: string,
  context: ModelProviderFailureContext,
  model: string,
): void {
  logger.info("model_provider.operation_started", { provider, context, model });
}

/** Explains a rejected model response without logging its potentially unsafe body. */
export function logModelProviderOutputInvalid(
  provider: string,
  context: ModelProviderFailureContext,
  model: string,
  attempts: number,
  reason: ModelProviderInvalidOutputReason,
): void {
  logger.warn("model_provider.output_invalid", {
    provider,
    context,
    model,
    attempts,
    category: "structured_output_invalid",
    reason,
  });
}

/** Logs safe diagnostics only: never bearer tokens, prompts, headers or response bodies. */
export function logModelProviderHttpFailure(
  provider: string,
  context: ModelProviderFailureContext,
  model: string,
  status: number,
): void {
  const category =
    status === 401
      ? "invalid_credentials"
      : status === 402
        ? "billing_required"
        : status === 403
          ? "permission_guardrail_or_moderation"
          : status === 404
            ? "endpoint_or_model_not_found"
            : status === 429
              ? "rate_limited"
              : status >= 500
                ? "provider_unavailable"
                : "request_rejected";
  logger.warn("model_provider.request_rejected", {
    provider,
    context,
    model,
    status,
    category,
    connected: true,
  });
}

/**
 * Catches the classic copy-paste mistake of pasting a whole "KEY=value" line into
 * the value slot (e.g. `HF_MODEL=HF_MODEL=openai/gpt-oss-20b:fireworks-ai`, or a
 * model value that starts with `OPENROUTER_MODEL=`). No real model ID ever
 * contains "=", so any occurrence is treated as malformed.
 */
const ASSIGNMENT_LIKE_VALUE = /=/;

const configuredPair = (
  env: NodeJS.ProcessEnv,
  tokenKey: "OPENROUTER_API_KEY" | "HF_TOKEN",
  modelKey: "OPENROUTER_MODEL" | "HF_MODEL",
  providerName: ModelProviderOptions["providerName"],
  baseUrl: string,
): ModelProviderOptions | undefined => {
  const token = env[tokenKey]?.trim();
  const model = env[modelKey]?.trim();
  if (!token && !model) return undefined;
  if (!token || !model) {
    throw new Error(`${providerName} requires both ${tokenKey} and ${modelKey}`);
  }
  if (ASSIGNMENT_LIKE_VALUE.test(model)) {
    throw new Error(
      `${modelKey} must contain only the model ID (for example openai/gpt-oss-20b:fireworks-ai) — ` +
        `it looks like a "KEY=value" pair was pasted into the value instead of just the model ID.`,
    );
  }
  return { token, model, baseUrl, providerName };
};

/** Selects exactly one explicitly configured OpenAI-compatible model provider. */
export function modelProviderOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderOptions | undefined {
  const openrouter = configuredPair(
    env,
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "openrouter",
    OPENROUTER_CHAT_COMPLETIONS_URL,
  );
  const huggingface = configuredPair(
    env,
    "HF_TOKEN",
    "HF_MODEL",
    "huggingface",
    HUGGING_FACE_CHAT_COMPLETIONS_URL,
  );
  if (openrouter && huggingface) {
    throw new Error(
      "Configure exactly one model provider: comment out either OpenRouter or Hugging Face",
    );
  }
  return openrouter ?? huggingface;
}

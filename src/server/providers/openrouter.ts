/**
 * Server-only OpenRouter configuration for all model-backed pipeline steps.
 * The API key is read only from the environment, passed to provider
 * constructors and never logged, echoed or included in error messages.
 */

import { OPENROUTER_CHAT_COMPLETIONS_URL, type ModelProviderOptions } from "./model-provider.js";

export { OPENROUTER_CHAT_COMPLETIONS_URL } from "./model-provider.js";

export type OpenRouterProviderOptions = ModelProviderOptions & {
  readonly providerName: "openrouter";
};

/** Resolves OpenRouter options from the environment; undefined when either key or model is absent. */
export function openRouterOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterProviderOptions | undefined {
  const token = env.OPENROUTER_API_KEY?.trim();
  const model = env.OPENROUTER_MODEL?.trim();
  if (!token || !model) return undefined;
  return {
    token,
    model,
    baseUrl: OPENROUTER_CHAT_COMPLETIONS_URL,
    providerName: "openrouter",
  };
}

/**
 * Server-only cost derivation for OpenRouter calls when a response omits cost.
 * Per-call cost is derived from real token usage and environment-configured
 * prices in USD per million tokens. Without both rates, the cost stays at 0 —
 * a cost figure is never invented.
 */

export interface ModelTokenPrices {
  /** USD per million input (prompt) tokens. */
  readonly inputUsdPerMtok: number;
  /** USD per million output (completion) tokens. */
  readonly outputUsdPerMtok: number;
}

const parseNonNegativeNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Cost in micro-USD for one real model call. Returns 0 when no price is known
 * for the model and no env override applies — never an invented figure.
 */
export function computeCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const inputOverride = parseNonNegativeNumber(env.OPENROUTER_INPUT_COST_PER_MTOK);
  const outputOverride = parseNonNegativeNumber(env.OPENROUTER_OUTPUT_COST_PER_MTOK);
  // Retain the model parameter in the API so callers bind usage to an exact
  // configured model, even though pricing is intentionally model-agnostic.
  void model;
  if (inputOverride === undefined || outputOverride === undefined) return 0;
  const inputUsdPerMtok = inputOverride;
  const outputUsdPerMtok = outputOverride;
  const usd = (inputTokens * inputUsdPerMtok + outputTokens * outputUsdPerMtok) / 1_000_000;
  return Math.round(usd * 1_000_000);
}

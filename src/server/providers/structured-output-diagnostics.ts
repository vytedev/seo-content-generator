import type { ModelProviderInvalidOutputReason } from "./model-provider.js";

export function isJson(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  try {
    JSON.parse(content.trim());
    return true;
  } catch {
    return false;
  }
}

/** Classifies unusable assistant content without retaining or logging any raw text. */
export function classifyStructuredContent(
  content: string | undefined,
  parsesAsJson: boolean,
): ModelProviderInvalidOutputReason {
  if (!content?.trim()) return "empty_content";
  return parsesAsJson ? "schema_validation_failure" : "invalid_json";
}

/** Classifies an unusable successful chat-completion response using safe metadata only. */
export function classifyInvalidSuccess(
  envelopeValid: boolean,
  finishReason: string | null | undefined,
  content: string | undefined,
  parsesAsJson: boolean,
): ModelProviderInvalidOutputReason {
  if (!envelopeValid) return "invalid_envelope";
  if (finishReason === "length") return "truncation";
  return classifyStructuredContent(content, parsesAsJson);
}

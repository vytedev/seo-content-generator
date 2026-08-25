import { z } from "zod";
import {
  ModelDiagnosticResultSchema,
  type ModelDiagnosticErrorCategory,
  type ModelDiagnosticResult,
} from "../../shared/contracts/model-diagnostic.js";
import type { ModelProviderOptions } from "../providers/model-provider.js";

const MAX_OUTPUT_TOKENS = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32_768;
const PROMPT = "Return exactly OK";

const responseSchema = z
  .object({
    choices: z.array(
      z.object({ message: z.object({ content: z.string() }).passthrough() }).passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        cost: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ModelDiagnosticStore {
  claim(
    idempotencyKey: string,
    model: string,
  ): Promise<
    | { kind: "claimed" }
    | { kind: "replay"; result: ModelDiagnosticResult }
    | { kind: "in_progress" | "ambiguous" }
  >;
  complete(idempotencyKey: string, result: ModelDiagnosticResult): Promise<void>;
}

export interface ModelDiagnosticServiceOptions {
  provider?: ModelProviderOptions;
  store: ModelDiagnosticStore;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class ModelDiagnosticService {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ModelDiagnosticServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async run(idempotencyKey: string): Promise<ModelDiagnosticResult> {
    const provider = this.options.provider;
    if (!provider || provider.providerName !== "openrouter") {
      return failed(
        provider?.model ?? null,
        "unavailable",
        provider?.providerName === "huggingface"
          ? "OpenRouter diagnostics are unavailable while Hugging Face is active."
          : "OpenRouter is not configured locally.",
        0,
      );
    }

    const claim = await this.options.store.claim(idempotencyKey, provider.model);
    if (claim.kind === "replay") return ModelDiagnosticResultSchema.parse(claim.result);
    if (claim.kind === "in_progress")
      return failed(
        provider.model,
        "operation_in_progress",
        "A diagnostic is already in progress. Wait for it to finish before trying again.",
        0,
      );
    if (claim.kind === "ambiguous")
      return failed(
        provider.model,
        "ambiguous_previous_attempt",
        "The previous attempt has an uncertain outcome. Use a new key only after checking OpenRouter activity.",
        0,
      );

    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result: ModelDiagnosticResult;
    let responseReceived = false;
    try {
      const response = await this.fetcher(provider.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: PROMPT }],
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      responseReceived = true;
      const latency = elapsed(startedAt, this.now());
      if (!response.ok) {
        result = failed(
          provider.model,
          categoryForStatus(response.status),
          messageForStatus(response.status),
          latency,
        );
      } else {
        const raw = await readBoundedJson(response);
        const parsed = responseSchema.safeParse(raw);
        const content = parsed.success ? parsed.data.choices[0]?.message.content.trim() : undefined;
        if (!parsed.success || content !== "OK") {
          result = failed(
            provider.model,
            "invalid_response",
            "OpenRouter returned an unexpected diagnostic response.",
            latency,
          );
        } else {
          const usage = parsed.data.usage;
          result = ModelDiagnosticResultSchema.parse({
            provider: "openrouter",
            model: provider.model,
            status: "success",
            error_category: null,
            message: "OpenRouter responded successfully.",
            input_tokens: usage?.prompt_tokens ?? 0,
            output_tokens: usage?.completion_tokens ?? 0,
            cost_micros: Math.max(0, Math.round((usage?.cost ?? 0) * 1_000_000)),
            latency_ms: latency,
          });
        }
      }
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      const category = timeout
        ? "timeout"
        : responseReceived
          ? "invalid_response"
          : "network_error";
      result = failed(
        provider.model,
        category,
        timeout
          ? "OpenRouter did not respond within the diagnostic time limit."
          : responseReceived
            ? "OpenRouter returned an invalid diagnostic response."
            : "OpenRouter could not be reached for the diagnostic.",
        elapsed(startedAt, this.now()),
      );
    } finally {
      clearTimeout(timer);
    }
    await this.options.store.complete(idempotencyKey, result);
    return result;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("diagnostic response too large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
    throw new Error("diagnostic response too large");
  return JSON.parse(text) as unknown;
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function failed(
  model: string | null,
  category: ModelDiagnosticErrorCategory,
  message: string,
  latencyMs: number,
): ModelDiagnosticResult {
  return ModelDiagnosticResultSchema.parse({
    provider: "openrouter",
    model,
    status: "failed",
    error_category: category,
    message,
    input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
    latency_ms: latencyMs,
  });
}

function categoryForStatus(status: number): ModelDiagnosticErrorCategory {
  if (status === 401) return "invalid_credentials";
  if (status === 402) return "billing_required";
  if (status === 403) return "access_denied";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "request_rejected";
}

function messageForStatus(status: number): string {
  if (status === 400) return "OpenRouter rejected the bounded diagnostic request.";
  if (status === 401) return "OpenRouter did not accept the configured credentials.";
  if (status === 402) return "OpenRouter reports that billing or credit is required.";
  if (status === 403) return "OpenRouter denied access to the configured model.";
  if (status === 404) return "The configured OpenRouter model was not found.";
  if (status === 429) return "OpenRouter rate-limited the diagnostic request.";
  if (status >= 500) return "OpenRouter is temporarily unavailable.";
  return "OpenRouter rejected the diagnostic request.";
}

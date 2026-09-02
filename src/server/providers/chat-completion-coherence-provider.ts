import {
  CoherenceRequestSchema,
  CoherenceResponseSchema,
  type CoherenceRequest,
  type CoherenceResponse,
} from "../../shared/milestone-four.js";
import type { CoherenceFinding } from "../../shared/milestone-four.js";
import { z } from "zod";
import { computeCostMicros } from "./model-pricing.js";
import { envMaxOutputTokens, type ChatMessage } from "./chat-completion-draft-provider.js";
import {
  logModelProviderHttpFailure,
  logModelProviderOperationStarted,
  logModelProviderOutputInvalid,
  OPENROUTER_CHAT_COMPLETIONS_URL,
} from "./model-provider.js";
import type { CoherenceProvider } from "./milestone-four-providers.js";
import { prepareCoherenceWindows } from "./compact-model-contracts.js";
import { readBoundedResponseBody } from "./http-response.js";
import { markPreDispatchProviderFailure } from "./paid-operation-lifecycle.js";
import { classifyInvalidSuccess, isJson } from "./structured-output-diagnostics.js";

/**
 * Server-only OpenRouter coherence client for step 1.11.
 *
 * Uses the OpenAI-compatible chat completions endpoint on OpenRouter with a
 * pinned, configurable model. The access token is secret: it must never appear
 * in error messages, thrown values or logs. All failures surface as redacted
 * CoherenceProviderError instances so the orchestrator's failStep records only
 * safe, bounded messages. The coherence review only reports issues introduced
 * by the revision and never rewrites prose.
 */

const TIMEOUT_MS = 60_000;
const MAX_HTTP_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;
/** Coherence findings are small structured lists. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;

/** Typed, redacted failure; the message is safe for operator-facing records. */
export class CoherenceProviderError extends Error {
  override readonly name = "CoherenceProviderError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    if (/_(?:TOKEN_MISSING|MODEL_INVALID|MODEL_MISMATCH)$/.test(code))
      markPreDispatchProviderFailure(this);
  }
}

export interface ChatCompletionCoherenceProviderOptions {
  /** Secret bearer token; falls back to process.env.OPENROUTER_API_KEY. */
  readonly token?: string;
  /** Pinned model identifier; falls back to process.env.OPENROUTER_MODEL, then the default. */
  readonly model?: string;
  /** Chat completions endpoint override for tests or compatible clients; defaults to OpenRouter. */
  readonly baseUrl?: string;
  /** Provenance label override (e.g. "openrouter"); defaults to "openrouter". */
  readonly providerName?: string;
  /** Injectable for tests; unit tests must stub this rather than touch the network. */
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Hard ceiling on generated output tokens; bounds latency and spend. */
  readonly maxOutputTokens?: number;
}

/** Minimal wire shape of the OpenAI-compatible chat completion response. */
const WireResponseSchema = z.object({
  id: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      /** OpenRouter reports the real billed cost in USD; it may be omitted. */
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});
type WireResponse = z.infer<typeof WireResponseSchema>;
const WireUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();
type WireUsage = z.infer<typeof WireUsageSchema>;
type ModelAttempt = { wire: WireResponse | null; usage?: WireUsage };

const COHERENCE_CATEGORIES = [
  "grammar",
  "broken_messaging",
  "inconsistency",
  "redundancy",
] as const;
const CoherenceWireFindingSchema = z
  .object({
    k: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
    q: z.string().trim().min(1),
    c: z.enum(COHERENCE_CATEGORIES),
    v: z.enum(["info", "warning", "blocker"]),
    i: z.string().trim().min(1),
    x: z.string().trim().min(1),
  })
  .strict();
const CoherenceWireEnvelopeSchema = z
  .object({ f: z.array(CoherenceWireFindingSchema).max(100) })
  .strict();

export const COHERENCE_RESPONSE_JSON_SCHEMA = {
  name: "mobelaris_final_coherence_v2",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["f"],
    properties: {
      f: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["k", "q", "c", "v", "i", "x"],
          properties: {
            k: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" },
            q: { type: "string", minLength: 1, maxLength: 500 },
            c: { type: "string", enum: COHERENCE_CATEGORIES },
            v: { type: "string", enum: ["info", "warning", "blocker"] },
            i: { type: "string", minLength: 1, maxLength: 2000 },
            x: { type: "string", minLength: 1, maxLength: 2000 },
          },
        },
      },
    },
  },
} as const;

export function buildCoherenceMessages(request: CoherenceRequest): ChatMessage[] {
  const system = [
    "You perform the final coherence review of a revised Mobelaris blog post.",
    "Report ONLY these exact categories INTRODUCED by the revision: grammar, broken_messaging, inconsistency, redundancy. The rule_reference must be coherence.<category>.",
    "Compare only the application-prepared changed targets. Return q as exactly one supplied target ID. The application attaches the exact persisted location; never generate a location.",
    'Use severity "blocker" only when the issue overlaps an audit row with changed=true and is eligible for controlled revision at that exact field, line range or unique section. Otherwise use info or warning.',
    "You are a reviewer, not a rewriter: return structured findings only and never rewritten prose.",
    "Write finding text in British English (UK spelling, grammar and idiom).",
    'If the revised document is coherent, return {"f":[]}.',
    "Respond with a single JSON object and nothing else — no markdown fences, no commentary.",
    'Return only {"f":[{"k":"unique-key","q":"change-0001","c":"grammar","v":"warning","i":"observed issue","x":"bounded correction"}]}. Use only supplied q target IDs.',
  ].join("\n");
  const lines = [
    `Primary keyword: ${request.handoff.primary_keyword}`,
    `Run: ${request.run_id}; parent: ${request.parent_document_version_id}; current: ${request.document_version_id}; reason: ${request.revision_reason}; cycle: ${request.coherence_cycle}`,
    `Exact successful Step 1.11 result hash: ${request.deterministic_result_hash}`,
    `App-issued changed targets: ${JSON.stringify(prepareCoherenceWindows(request))}`,
    "Reference bodies are intentionally omitted; this pass assesses only revision-introduced coherence defects.",
  ];
  lines.push("Return only { f } with q set to a supplied changed-target ID.");
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

/** Strict and all-or-nothing: target locations are application-owned. */
function parseCoherenceBody(
  content: string,
  request: CoherenceRequest,
): CoherenceFinding[] | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(content.trim());
  } catch {
    return undefined;
  }
  const envelope = CoherenceWireEnvelopeSchema.safeParse(candidate);
  if (!envelope.success) return undefined;
  const keys = envelope.data.f.map((finding) => finding.k);
  if (new Set(keys).size !== keys.length) return undefined;
  const prepared = prepareCoherenceWindows(request);
  const targets = new Map<string, CoherenceFinding["location"]>([
    ...prepared.windows.map(
      (window) =>
        [
          window.id,
          {
            field: window.field,
            line_start: window.proposed.changed_a,
            line_end: window.proposed.changed_b,
          },
        ] as const,
    ),
    ...prepared.fields.map((field) => [field.id, { field: field.field }] as const),
  ]);
  const findings = envelope.data.f.map((finding) => {
    const location = targets.get(finding.q);
    if (!location) return undefined;
    const parsed = CoherenceResponseSchema.shape.findings.element.safeParse({
      stable_key: finding.k,
      category: finding.c,
      rule_reference: `coherence.${finding.c}`,
      severity: finding.v,
      location,
      issue: finding.i,
      suggested_fix: finding.x,
    });
    return parsed.success ? parsed.data : undefined;
  });
  return findings.some((finding) => finding === undefined)
    ? undefined
    : findings.flatMap((finding) => (finding ? [finding] : []));
}

const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class ChatCompletionCoherenceProvider implements CoherenceProvider {
  readonly provider: string;
  readonly model: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ChatCompletionCoherenceProviderOptions = {}) {
    const token = options.token ?? process.env.OPENROUTER_API_KEY;
    if (!token?.trim())
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_TOKEN_MISSING",
        "OPENROUTER_API_KEY is not configured; the coherence provider cannot be constructed",
      );
    const model = options.model ?? process.env.OPENROUTER_MODEL;
    if (!model?.trim())
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_MODEL_INVALID",
        "OPENROUTER_MODEL is not configured; no default model is assumed",
      );
    if (!model.trim())
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_MODEL_INVALID",
        "Model identifier is empty",
      );
    this.token = token;
    this.model = model;
    this.provider = options.providerName?.trim() || "openrouter";
    this.baseUrl = options.baseUrl?.trim() || OPENROUTER_CHAT_COMPLETIONS_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.maxOutputTokens =
      options.maxOutputTokens ?? envMaxOutputTokens(process.env, DEFAULT_MAX_OUTPUT_TOKENS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async review(input: CoherenceRequest): Promise<CoherenceResponse> {
    const request = CoherenceRequestSchema.parse(input);
    logModelProviderOperationStarted(this.provider, "coherence", this.model);
    if (request.model !== this.model)
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_MODEL_MISMATCH",
        "Coherence request model does not match pinned provider model",
      );
    const startedAt = Date.now();
    const firstAttempt = await this.callModel(buildCoherenceMessages(request), request.temperature);
    const first = firstAttempt.wire;
    if (first?.choices[0]?.finish_reason === "length") {
      logModelProviderOutputInvalid(this.provider, "coherence", this.model, 1, "truncation");
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_TRUNCATED",
        "Coherence provider output reached the operation token limit",
      );
    }
    const findings = first
      ? parseCoherenceBody(first.choices[0]?.message.content ?? "", request)
      : undefined;
    if (first && findings)
      return this.toResponse(firstAttempt.usage ? [firstAttempt.usage] : [], findings, startedAt);
    const correctiveAttempt = await this.callModel(
      [
        ...buildCoherenceMessages(request),
        {
          role: "user",
          content:
            'Your previous reply was invalid. Reply with exactly {"f":[]} or {"f":[{"k":"unique-key","q":"a supplied target ID","c":"grammar","v":"warning","i":"observed issue","x":"bounded correction"}]}. Use only supplied q values and no other fields or text.',
        },
      ],
      request.temperature,
    );
    const corrective = correctiveAttempt.wire;
    if (corrective?.choices[0]?.finish_reason === "length") {
      logModelProviderOutputInvalid(this.provider, "coherence", this.model, 2, "truncation");
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_TRUNCATED",
        "Coherence provider output reached the operation token limit",
      );
    }
    const retriedFindings = corrective
      ? parseCoherenceBody(corrective.choices[0]?.message.content ?? "", request)
      : undefined;
    if (!corrective || retriedFindings === undefined) {
      const content = corrective?.choices[0]?.message.content;
      logModelProviderOutputInvalid(
        this.provider,
        "coherence",
        this.model,
        2,
        classifyInvalidSuccess(
          corrective !== null,
          corrective?.choices[0]?.finish_reason,
          content,
          isJson(content),
        ),
      );
      throw new CoherenceProviderError(
        "COHERENCE_PROVIDER_UNPARSEABLE",
        "Coherence provider returned unparseable output after 2 attempts",
      );
    }
    return this.toResponse(
      [firstAttempt.usage, correctiveAttempt.usage].flatMap((usage) => (usage ? [usage] : [])),
      retriedFindings,
      startedAt,
    );
  }

  private toResponse(
    billableUsage: WireUsage[],
    findings: CoherenceFinding[],
    startedAt: number,
  ): CoherenceResponse {
    const usage = billableUsage.reduce(
      (total, usage) => {
        const inputUnits = usage.prompt_tokens;
        const outputUnits = usage.completion_tokens;
        return {
          input_units: total.input_units + inputUnits,
          output_units: total.output_units + outputUnits,
          // Prefer each response's provider-reported billed cost. Derive only when that
          // successful response reports token usage; transport failures are never inferred.
          cost_micros:
            total.cost_micros +
            (usage.cost !== undefined
              ? Math.round(usage.cost * 1_000_000)
              : computeCostMicros(this.model, inputUnits, outputUnits)),
        };
      },
      { input_units: 0, output_units: 0, cost_micros: 0 },
    );
    return CoherenceResponseSchema.parse({
      findings,
      usage: {
        ...usage,
        // Measured end-to-end latency across all attempts of this operation.
        latency_ms: Math.max(0, Date.now() - startedAt),
      },
    });
  }

  /** One bounded HTTP attempt loop: initial request plus at most 2 retries on 5xx/429/network. */
  private async callModel(messages: ChatMessage[], temperature: number): Promise<ModelAttempt> {
    let lastError: CoherenceProviderError | undefined;
    for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: this.maxOutputTokens,
            response_format: { type: "json_schema", json_schema: COHERENCE_RESPONSE_JSON_SCHEMA },
            ...(this.provider === "openrouter"
              ? {
                  provider: { require_parameters: true },
                  reasoning: { effort: "none", exclude: true },
                }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbort(error))
          throw new CoherenceProviderError(
            "COHERENCE_PROVIDER_TIMEOUT",
            "Coherence provider request timed out",
          );
        lastError = new CoherenceProviderError(
          "COHERENCE_PROVIDER_NETWORK",
          "Coherence provider request failed at network level",
        );
        if (attempt === MAX_HTTP_RETRIES) throw lastError;
        await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) {
        let payload: unknown;
        try {
          payload = JSON.parse((await readBoundedResponseBody(response)).trim());
        } catch {
          return { wire: null };
        }
        const wire = WireResponseSchema.safeParse(payload);
        const usage = WireUsageSchema.safeParse(
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).usage
            : undefined,
        );
        // Usage is independently safe to retain from a successful malformed envelope. Choices and
        // content remain all-or-nothing and can only drive findings after the full wire parse.
        return {
          wire: wire.success ? wire.data : null,
          ...(usage.success ? { usage: usage.data } : {}),
        };
      }
      const status = response.status;
      logModelProviderHttpFailure(this.provider, "coherence", this.model, status);
      lastError = new CoherenceProviderError(
        "COHERENCE_PROVIDER_HTTP_STATUS",
        status === 402
          ? "Coherence provider account has no billing configured for model usage"
          : `Coherence provider request failed with HTTP ${status}`,
      );
      if (status !== 429 && status < 500) throw lastError;
      if (attempt === MAX_HTTP_RETRIES) throw lastError;
      await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
    throw (
      lastError ??
      new CoherenceProviderError("COHERENCE_PROVIDER_NETWORK", "Coherence provider request failed")
    );
  }
}

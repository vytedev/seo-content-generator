import {
  DraftProviderRequestSchema,
  DraftProviderResponseSchema,
  type DraftProviderRequest,
  type DraftProviderResponse,
} from "../../shared/milestone-two.js";
import { hashIdempotencyInput } from "../../shared/worker-contracts.js";
import { canonicalHash } from "../../shared/milestone-two.js";
import { computeCostMicros } from "./model-pricing.js";
import { z } from "zod";
import type { DraftProvider } from "./contracts.js";
import { formatDeterministicEditorialRubric } from "./editorial-rubric.js";
import { readBoundedResponseBody } from "./http-response.js";
import { classifyInvalidSuccess, isJson } from "./structured-output-diagnostics.js";
import {
  logModelProviderHttpFailure,
  logModelProviderOperationStarted,
  logModelProviderOutputInvalid,
  OPENROUTER_CHAT_COMPLETIONS_URL,
} from "./model-provider.js";

/**
 * Server-only OpenRouter draft client for step 1.3.
 *
 * Uses the OpenAI-compatible chat completions endpoint on OpenRouter with a
 * pinned, configurable model. The access token is secret: it must never appear
 * in error messages, thrown values or logs. All failures surface as redacted
 * DraftProviderError instances so the orchestrator's failStep records only
 * safe, bounded messages.
 */

const TIMEOUT_MS = 60_000;
/** Drafts produce a full structured article; cap generous enough for ~2000 words + JSON shell. */
const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;
export const DRAFT_PROMPT = {
  template_id: "mobelaris.draft" as const,
  template_version: "3.0.0-single-dispatch",
};
export const DRAFT_PROMPT_VERSION = `${DRAFT_PROMPT.template_id}@${DRAFT_PROMPT.template_version}`;
const DRAFT_REASONING_POLICY = "openrouter:none-excluded;compatible:unspecified";
const DRAFT_RETRY_POLICY = "single-http-dispatch-no-corrective-request-v1";
const DRAFT_TOKEN_POLICY = `max-output-tokens-env-v1:${DEFAULT_MAX_OUTPUT_TOKENS}`;

export const DRAFT_RESPONSE_JSON_SCHEMA = {
  name: "mobelaris_draft_v1",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "meta_title",
      "slug",
      "meta_description",
      "og_title",
      "og_description",
      "images",
      "faqs",
      "markdown",
      "claims",
    ],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      meta_title: { type: "string", minLength: 55, maxLength: 60 },
      slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 200 },
      meta_description: { type: "string", minLength: 1, maxLength: 160 },
      og_title: { type: "string", minLength: 1, maxLength: 200 },
      og_description: { type: "string", minLength: 1, maxLength: 500 },
      images: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["alt", "filename", "placement"],
          properties: {
            alt: { type: "string", maxLength: 500 },
            filename: { type: "string", maxLength: 500 },
            placement: {
              type: "object",
              additionalProperties: false,
              required: ["marker"],
              properties: { marker: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
            },
          },
        },
      },
      faqs: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer"],
          properties: {
            question: { type: "string", maxLength: 1000 },
            answer: { type: "string", maxLength: 4000 },
          },
        },
      },
      markdown: { type: "string", minLength: 1, maxLength: 100000 },
      claims: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "type", "provenance", "product_identifier", "status"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 2000 },
            type: {
              type: "string",
              enum: [
                "dimension",
                "material",
                "price",
                "delivery",
                "statistic",
                "provenance",
                "general",
              ],
            },
            provenance: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
            product_identifier: { type: ["string", "null"], minLength: 1, maxLength: 500 },
            status: { type: "string", enum: ["unverified"] },
          },
        },
      },
    },
  },
} as const;

export const DRAFT_CONTRACT_IDENTITY = canonicalHash({
  prompt: DRAFT_PROMPT,
  response_schema: DRAFT_RESPONSE_JSON_SCHEMA,
  reasoning_policy: DRAFT_REASONING_POLICY,
  retry_policy: DRAFT_RETRY_POLICY,
  token_policy: DRAFT_TOKEN_POLICY,
});

function draftContractIdentity(maxOutputTokens: number): string {
  return canonicalHash({
    prompt: DRAFT_PROMPT,
    response_schema: DRAFT_RESPONSE_JSON_SCHEMA,
    reasoning_policy: DRAFT_REASONING_POLICY,
    retry_policy: DRAFT_RETRY_POLICY,
    token_policy: `${DRAFT_TOKEN_POLICY};effective:${maxOutputTokens}`,
  });
}

/** Env override shared by all model providers (MODEL_MAX_OUTPUT_TOKENS). */
export function envMaxOutputTokens(env: NodeJS.ProcessEnv = process.env, fallback: number): number {
  const raw = env.MODEL_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error("MODEL_MAX_OUTPUT_TOKENS must be a positive integer");
  return parsed;
}

/** Typed, redacted failure; the message is safe for operator-facing records. */
export class DraftProviderError extends Error {
  override readonly name = "DraftProviderError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionDraftProviderOptions {
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
  /** Retained only as a source-compatible test option; Step 1.3 never sleeps or retries. */
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

export function buildDraftMessages(request: DraftProviderRequest): ChatMessage[] {
  const { handoff, internal_links } = request;
  const promptIdentity = request.prompt
    ? `${request.prompt.template_id}@${request.prompt.template_version}`
    : DRAFT_PROMPT_VERSION;
  const system = [
    "You draft Mobelaris blog posts about designer furniture and interior design.",
    "Write in British English (UK spelling, grammar and idiom) throughout.",
    "You are drafting, not reviewing: produce the article requested, never findings or critique.",
    "For every image include explicit typed placement and put its exact marker `<!-- MOBELARIS_IMAGE:<marker> -->` exactly once in markdown. Do not use any legacy or inferred placement.",
    "Respond with a single JSON object and nothing else — no markdown fences, no commentary.",
    "The markdown body must contain exactly one H1 heading and that H1 must include the primary keyword.",
    'Every factual claim in the body must be listed in claims with status "unverified"; do not invent provenance.',
    "Keep each FAQ question and its own answer in one object; never rotate, sort or map answers separately.",
    "Titles must be complete phrases and must not end with a connector or preposition such as for, and, with, to, of, in or the.",
  ].join("\n");
  const shape = [
    "{",
    '  "title": string,',
    '  "meta_title": string (55–60 characters, complete phrase),',
    '  "slug": string (kebab-case),',
    '  "meta_description": string (150–155 characters),',
    '  "og_title": string,',
    '  "og_description": string,',
    '  "images": [{ "alt": string, "filename": string, "placement": { "marker": kebab-case string } }],',
    '  "faqs": [{ "question": string, "answer": string (40–80 words) }],',
    '  "markdown": string (must satisfy every deterministic requirement below),',
    '  "claims": [{ "text": string, "type": "dimension" | "material" | "price" | "delivery" | "statistic" | "provenance" | "general", "status": "unverified" }]',
    "}",
  ].join("\n");
  const lines = [
    `Prompt identity: ${promptIdentity}`,
    `Primary keyword: ${handoff.primary_keyword}`,
    `Related keywords: ${handoff.related_keywords.join(", ")}`,
    `Page type: ${handoff.page_type} blog post for Mobelaris`,
    `Word count target: ${handoff.word_count_target}`,
  ];
  if (handoff.notes) lines.push(`Brief notes: ${handoff.notes}`);
  if (handoff.client_insights) lines.push(`Client insights: ${handoff.client_insights}`);
  if (internal_links.length)
    lines.push(
      `Supplied internal-link shortlist (use only these internal URLs): ${internal_links
        .map((link) => `${link.title} (${link.url})`)
        .join("; ")}`,
    );
  for (const snapshot of request.reference_snapshots ?? [])
    lines.push(
      `Approved reference snapshot ${snapshot.kind} (version ${snapshot.version_id}, sha256 ${snapshot.content_hash}):\n${snapshot.content}`,
    );
  lines.push(
    `Deterministic acceptance requirements:\n${formatDeterministicEditorialRubric()}`,
    `Draft a British English (UK) blog post targeting the primary keyword "${handoff.primary_keyword}".`,

    `Return exactly one JSON object matching this shape:\n${shape}`,
  );
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

/** Strips code fences and surrounding prose, then finds the outermost JSON object. */
export function extractJsonObject(raw: string): unknown {
  const unfenced = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class ChatCompletionDraftProvider implements DraftProvider {
  readonly provider: string;
  readonly model: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  readonly prompt = DRAFT_PROMPT;
  readonly contractIdentity: string;

  constructor(options: ChatCompletionDraftProviderOptions = {}) {
    const token = options.token ?? process.env.OPENROUTER_API_KEY;
    if (!token?.trim())
      throw new DraftProviderError(
        "DRAFT_PROVIDER_TOKEN_MISSING",
        "OPENROUTER_API_KEY is not configured; the draft provider cannot be constructed",
      );
    const model = options.model ?? process.env.OPENROUTER_MODEL;
    if (!model?.trim())
      throw new DraftProviderError(
        "DRAFT_PROVIDER_MODEL_INVALID",
        "OPENROUTER_MODEL is not configured; no default model is assumed",
      );
    if (!model.trim())
      throw new DraftProviderError("DRAFT_PROVIDER_MODEL_INVALID", "Model identifier is empty");
    this.token = token;
    this.model = model;
    this.provider = options.providerName?.trim() || "openrouter";
    this.baseUrl = options.baseUrl?.trim() || OPENROUTER_CHAT_COMPLETIONS_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.maxOutputTokens =
      options.maxOutputTokens ?? envMaxOutputTokens(process.env, DEFAULT_MAX_OUTPUT_TOKENS);
    this.contractIdentity = draftContractIdentity(this.maxOutputTokens);
  }

  async generate(input: DraftProviderRequest): Promise<DraftProviderResponse> {
    const request = DraftProviderRequestSchema.parse(input);
    logModelProviderOperationStarted(this.provider, "draft", this.model);
    if (request.model !== this.model)
      throw new DraftProviderError(
        "DRAFT_PROVIDER_MODEL_MISMATCH",
        "Draft request model does not match pinned provider model",
      );
    const startedAt = Date.now();
    const first = await this.callModel(buildDraftMessages(request));
    if (first?.choices[0]?.finish_reason === "length") {
      logModelProviderOutputInvalid(this.provider, "draft", this.model, 1, "truncation");
      throw new DraftProviderError(
        "DRAFT_PROVIDER_TRUNCATED",
        "Draft provider output reached the operation token limit",
      );
    }
    const draft = first ? this.extractDraft(first) : undefined;
    if (first && draft) return this.toResponse(request, first, draft, startedAt);
    const content = first?.choices[0]?.message.content;
    logModelProviderOutputInvalid(
      this.provider,
      "draft",
      this.model,
      1,
      classifyInvalidSuccess(
        first !== null,
        first?.choices[0]?.finish_reason,
        content,
        isJson(content),
      ),
    );
    throw new DraftProviderError(
      "DRAFT_PROVIDER_UNPARSEABLE",
      "Draft provider returned unparseable output; no automatic second request was made",
    );
  }

  private toResponse(
    request: DraftProviderRequest,
    wire: WireResponse,
    draft: unknown,
    startedAt: number,
  ): DraftProviderResponse {
    return DraftProviderResponseSchema.parse({
      request_id: wire.id?.trim() || `request_${hashIdempotencyInput(request)}`,
      draft,
      usage: {
        input_units: wire.usage?.prompt_tokens ?? 0,
        output_units: wire.usage?.completion_tokens ?? 0,
        // Measured end-to-end latency across all attempts of this operation.
        latency_ms: Math.max(0, Date.now() - startedAt),
        // Prefer the endpoint-reported billed cost (OpenRouter sends USD); fall
        // back to deriving from real tokens and list prices.
        cost_micros:
          wire.usage?.cost !== undefined
            ? Math.round(wire.usage.cost * 1_000_000)
            : computeCostMicros(
                this.model,
                wire.usage?.prompt_tokens ?? 0,
                wire.usage?.completion_tokens ?? 0,
              ),
      },
    });
  }

  /** DraftProviderResponseSchema validates the full draft shape at this boundary. */
  private extractDraft(wire: WireResponse): unknown {
    const content = wire.choices[0]?.message.content;
    if (!content) return undefined;
    const candidate = extractJsonObject(content);
    if (typeof candidate === "object" && candidate !== null) {
      const claims = (candidate as { claims?: unknown }).claims;
      if (Array.isArray(claims))
        for (const claim of claims) {
          if (typeof claim !== "object" || claim === null) continue;
          if ((claim as { provenance?: unknown }).provenance === null)
            delete (claim as { provenance?: unknown }).provenance;
          if ((claim as { product_identifier?: unknown }).product_identifier === null)
            delete (claim as { product_identifier?: unknown }).product_identifier;
        }
    }
    const parsed = DraftProviderResponseSchema.shape.draft.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }

  /** Exactly one HTTP dispatch. No network, 429, 5xx, or output-correction retry is safe here. */
  private async callModel(messages: ChatMessage[]): Promise<WireResponse | null> {
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
          max_tokens: this.maxOutputTokens,
          response_format: { type: "json_schema", json_schema: DRAFT_RESPONSE_JSON_SCHEMA },
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
        throw new DraftProviderError("DRAFT_PROVIDER_TIMEOUT", "Draft provider request timed out");
      throw new DraftProviderError(
        "DRAFT_PROVIDER_NETWORK",
        "Draft provider request failed at network level",
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const wire = WireResponseSchema.safeParse(
        extractJsonObject(await readBoundedResponseBody(response)),
      );
      return wire.success ? wire.data : null;
    }
    const status = response.status;
    logModelProviderHttpFailure(this.provider, "draft", this.model, status);
    throw new DraftProviderError(
      "DRAFT_PROVIDER_HTTP_STATUS",
      status === 402
        ? "Draft provider account has no billing configured for model usage"
        : `Draft provider request failed with HTTP ${status}`,
    );
  }
}

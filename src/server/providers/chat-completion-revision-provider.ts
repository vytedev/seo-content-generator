import {
  RevisionRequestSchema,
  RevisionResponseSchema,
  type RevisionRequest,
  type RevisionResponse,
  type RevisionSafeFailureCategory,
} from "../../shared/milestone-four.js";
import { applyCompactRevisionPlan, prepareRevisionTargets } from "./compact-model-contracts.js";
import { z } from "zod";
import { computeCostMicros } from "./model-pricing.js";
import { envMaxOutputTokens, type ChatMessage } from "./chat-completion-draft-provider.js";
import {
  logModelProviderHttpFailure,
  logModelProviderOperationStarted,
  logModelProviderOutputInvalid,
  OPENROUTER_CHAT_COMPLETIONS_URL,
} from "./model-provider.js";
import type { RevisionProvider } from "./milestone-four-providers.js";
import { formatDeterministicEditorialRubric } from "./editorial-rubric.js";
import { readBoundedResponseBody } from "./http-response.js";

/**
 * Server-only OpenRouter revision client for step 1.10.
 *
 * Uses the OpenAI-compatible chat completions endpoint on OpenRouter with a
 * pinned, configurable model. The access token is secret: it must never appear
 * in error messages, thrown values or logs. All failures surface as redacted
 * RevisionProviderError instances so the orchestrator's failStep records only
 * safe, bounded messages. The revision applies only the accepted findings in
 * one controlled edit; it never rewrites untouched sections.
 */

const TIMEOUT_MS = 60_000;
const MAX_HTTP_RETRIES = 0;
/** Finding-scoped edit plans are substantially smaller than a full article. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_500;

/** Typed, redacted failure; the message is safe for operator-facing records. */
export class RevisionProviderError extends Error {
  override readonly name = "RevisionProviderError";
  constructor(
    readonly code: string,
    message: string,
    readonly category: RevisionSafeFailureCategory = "configuration",
  ) {
    super(message);
  }
}

export interface ChatCompletionRevisionProviderOptions {
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

const DRAFT_SHAPE =
  '{ "edits": [{ "id": finding_id, "st": "applied" | "unable", "why": string, "replacement": string | null }] }';

export const REVISION_RESPONSE_JSON_SCHEMA = {
  name: "mobelaris_revision_edit_plan_v2",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["edits"],
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "st", "why", "replacement"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 500 },
            st: { type: "string", enum: ["applied", "unable"] },
            why: { type: "string", minLength: 1, maxLength: 2000 },
            replacement: { type: ["string", "null"], maxLength: 100000 },
          },
        },
      },
    },
  },
} as const;

export function buildRevisionMessages(request: RevisionRequest): ChatMessage[] {
  const system = [
    "You apply accepted review findings to a Mobelaris blog post in one controlled revision pass.",
    "Apply ONLY the accepted findings; never rewrite, rephrase or restructure sections no finding covers.",
    "Return exactly one compact edits row per accepted finding, in supplied order. Use st=applied only with a complete string replacement for the supplied target; otherwise use st=unable and replacement=null.",
    "Broad or ambiguous body locations without a unique section or line range must be unable and must not authorise an edit.",
    "Field scope discipline: copy every field character-for-character unless an accepted finding names that field. Do NOT generalise a finding about one field to other fields. The sole exception is that a meta_title or meta_description fix may be mirrored to its corresponding Open Graph field.",
    "The application builds the full candidate from these scoped replacements and rechecks the primary keyword. Never return the full document or unchanged text outside a supplied target.",
    "Image placement is server-significant: preserve each placement object and its exact `<!-- MOBELARIS_IMAGE:<marker> -->` marker byte-for-byte; never add, infer, move, remove or duplicate one.",
    "Claims are server-owned and are not part of your input or output. Do not emit claims or a document field.",
    "Write in British English (UK spelling, grammar and idiom) in any text you touch.",
    "Range discipline: when a finding gives a character or word range, count carefully and land INSIDE the range — never overshoot below or above it (e.g. a 150–155 character target must not become 137).",
    "Readability discipline: when a readability finding is accepted, aggressively simplify the affected text — split every sentence longer than ~20 words into two, replace multi-syllable words with common ones, cut subordinate clauses — until the Flesch-Kincaid grade target is genuinely met. Minor edits will not move the grade.",
    "Respond with a single JSON object and nothing else — no markdown fences, no commentary.",
    `Return exactly one JSON object matching this envelope:\n${DRAFT_SHAPE}`,
  ].join("\n");
  const lines = [
    `Primary keyword (must remain in the title and the single H1): ${request.handoff.primary_keyword}`,
    `Related keywords: ${request.handoff.related_keywords.join(", ")}`,
    `Run: ${request.run_id}, document version: ${request.document_version_id}, revision: ${request.revision}`,
    `Supplied internal-link shortlist (use only these internal URLs): ${
      request.internal_links?.length
        ? request.internal_links.map((link) => `${link.title} (${link.url})`).join("; ")
        : "No internal links were supplied; do not invent one."
    }`,
    `Deterministic acceptance requirements relevant to accepted findings:\n${formatDeterministicEditorialRubric()}`,
  ];
  lines.push(
    `Accepted finding targets (application-prepared, exact current target only):\n${JSON.stringify(prepareRevisionTargets(request))}`,
    "Return the strict compact edits envelope. Do not include claims or a full document.",
  );
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class ChatCompletionRevisionProvider implements RevisionProvider {
  readonly provider: string;
  readonly model: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;

  constructor(options: ChatCompletionRevisionProviderOptions = {}) {
    const token = options.token ?? process.env.OPENROUTER_API_KEY;
    if (!token?.trim())
      throw new RevisionProviderError(
        "REVISION_PROVIDER_TOKEN_MISSING",
        "OPENROUTER_API_KEY is not configured; the revision provider cannot be constructed",
      );
    const model = options.model ?? process.env.OPENROUTER_MODEL;
    if (!model?.trim())
      throw new RevisionProviderError(
        "REVISION_PROVIDER_MODEL_INVALID",
        "OPENROUTER_MODEL is not configured; no default model is assumed",
      );
    if (!model.trim())
      throw new RevisionProviderError(
        "REVISION_PROVIDER_MODEL_INVALID",
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
  }

  async revise(input: RevisionRequest): Promise<RevisionResponse> {
    const request = RevisionRequestSchema.parse(input);
    logModelProviderOperationStarted(this.provider, "revision", this.model);
    if (request.model !== this.model)
      throw new RevisionProviderError(
        "REVISION_PROVIDER_MODEL_MISMATCH",
        "Revision request model does not match pinned provider model",
      );
    const startedAt = Date.now();
    const wire = await this.callModel(buildRevisionMessages(request), request.temperature);
    const draft =
      wire?.choices[0]?.finish_reason === "length"
        ? undefined
        : wire
          ? this.extractDraft(wire, request)
          : undefined;
    if (wire && draft) return this.toResponse(wire, draft, startedAt);

    // HTTP 200 means the subjective operation completed, even when its body is
    // truncated, malformed or unsafe. Discard all raw output and fail every
    // requested subjective finding closed; the orchestrator can still retain
    // deterministic edits and advance through the normal gates.
    logModelProviderOutputInvalid(this.provider, "revision", this.model, 1);
    return RevisionResponseSchema.parse({
      document: request.current_document,
      finding_results: request.accepted_findings.map((finding) => ({
        finding_id: finding.id,
        status: "unable",
        reason: "The model response could not be used safely.",
      })),
      usage: this.usage(wire, startedAt),
    });
  }

  private usage(wire: WireResponse | null, startedAt: number) {
    return {
      input_units: wire?.usage?.prompt_tokens ?? 0,
      output_units: wire?.usage?.completion_tokens ?? 0,
      latency_ms: Math.max(0, Date.now() - startedAt),
      cost_micros:
        wire?.usage?.cost !== undefined
          ? Math.round(wire.usage.cost * 1_000_000)
          : computeCostMicros(
              this.model,
              wire?.usage?.prompt_tokens ?? 0,
              wire?.usage?.completion_tokens ?? 0,
            ),
    };
  }

  private toResponse(
    wire: WireResponse,
    draft: Pick<RevisionResponse, "document" | "finding_results">,
    startedAt: number,
  ): RevisionResponse {
    return RevisionResponseSchema.parse({ ...draft, usage: this.usage(wire, startedAt) });
  }

  /** Expands the transient edit plan into the full durable candidate in application code. */
  private extractDraft(
    wire: WireResponse,
    request: RevisionRequest,
  ): Pick<RevisionResponse, "document" | "finding_results"> | undefined {
    const content = wire.choices[0]?.message.content;
    if (!content) return undefined;
    try {
      return applyCompactRevisionPlan(request, JSON.parse(content.trim()));
    } catch {
      return undefined;
    }
  }

  /** Exactly one HTTP request. Every non-200 or transport failure fails safely. */
  private async callModel(
    messages: ChatMessage[],
    temperature: number,
  ): Promise<WireResponse | null> {
    let lastError: RevisionProviderError | undefined;
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
            response_format: { type: "json_schema", json_schema: REVISION_RESPONSE_JSON_SCHEMA },
            ...(this.provider === "openrouter" ? { provider: { require_parameters: true } } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        lastError = isAbort(error)
          ? new RevisionProviderError(
              "REVISION_PROVIDER_TIMEOUT",
              "Revision provider request timed out",
              "timeout",
            )
          : new RevisionProviderError(
              "REVISION_PROVIDER_NETWORK",
              "Revision provider request failed at network level",
              "transient_exhausted",
            );
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) {
        let payload: unknown;
        try {
          payload = JSON.parse((await readBoundedResponseBody(response)).trim());
        } catch {
          return null;
        }
        const wire = WireResponseSchema.safeParse(payload);
        // An unusable successful envelope is returned to revise(), which fails
        // the subjective subset closed without another model request.
        return wire.success ? wire.data : null;
      }
      const status = response.status;
      logModelProviderHttpFailure(this.provider, "revision", this.model, status);
      lastError = new RevisionProviderError(
        "REVISION_PROVIDER_HTTP_STATUS",
        status === 402
          ? "Revision provider account has no billing configured for model usage"
          : `Revision provider request failed with HTTP ${status}`,
        status === 400 || status === 401 || status === 402 || status === 403 || status === 404
          ? "configuration"
          : "transient_exhausted",
      );
      throw lastError;
    }
    throw (
      lastError ??
      new RevisionProviderError("REVISION_PROVIDER_NETWORK", "Revision provider request failed")
    );
  }
}

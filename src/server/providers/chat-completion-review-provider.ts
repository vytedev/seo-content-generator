import {
  ReviewFindingSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewResponse,
} from "../../shared/milestone-three.js";
import { hashIdempotencyInput } from "../../shared/worker-contracts.js";
import { computeCostMicros } from "./model-pricing.js";
import { z } from "zod";
import {
  envMaxOutputTokens,
  extractJsonObject,
  type ChatMessage,
} from "./chat-completion-draft-provider.js";
import {
  logModelProviderHttpFailure,
  logModelProviderOperationStarted,
  logModelProviderOutputInvalid,
  OPENROUTER_CHAT_COMPLETIONS_URL,
} from "./model-provider.js";
import type { ReviewProvider } from "./review-provider.js";
import { readBoundedResponseBody } from "./http-response.js";
import {
  CompactReviewEnvelopeSchema,
  expandCompactReviewFinding,
  prepareReviewDocument,
} from "./compact-model-contracts.js";

/**
 * Server-only OpenRouter review client for steps 1.5–1.8.
 *
 * Uses the OpenAI-compatible chat completions endpoint on OpenRouter with a
 * pinned, configurable model. The access token is secret: it must never appear
 * in error messages, thrown values or logs. All failures surface as redacted
 * ReviewProviderError instances so the orchestrator's failStep records only
 * safe, bounded messages. Reviews return structured findings only; the model
 * never rewrites prose.
 */

const TIMEOUT_MS = 60_000;
const MAX_HTTP_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

const SINGLE_ATTEMPT_REVIEW_STEPS = new Set<ReviewRequest["step"]>([
  "review_writing_style",
  "review_information_gain",
  "review_fact_checking",
]);
/** Review findings are structured lists; well below full-article size. */
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;

/** Step 1.5 receives only the mapped subjective guide section, never the countable rules. */
export const STYLE_REVIEW_CONTEXT_LIMITS = {
  writing_guide_chars: 4_000,
} as const;

/** Step 1.6 context ceilings are application-owned and independent of provider tokenisation. */
export const INFORMATION_GAIN_CONTEXT_LIMITS = {
  topic_chars: 1_000,
  handoff_notes_chars: 2_000,
  client_insights_chars: 4_000,
  reference_snapshot_chars: 4_000,
  reference_total_chars: 8_000,
} as const;

/** Typed, redacted failure; the message is safe for operator-facing records. */
export class ReviewProviderError extends Error {
  override readonly name = "ReviewProviderError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChatCompletionReviewProviderOptions {
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

const STEP_FIFTEEN_JUDGEMENT_AREAS = [
  "recommended structure",
  "answer-first writing",
  "BLUF in key takeaways",
  "BLUF in the conclusion",
  "heading specificity",
  "definition quality",
  "useful examples and use cases",
  "appropriate use of bullets",
  "appropriate use of tables",
  "conversational tone",
  "sentence readability",
  "paragraph readability",
  "callout placement",
] as const;

const STEP_BRIEF: Record<ReviewRequest["step"], string> = {
  review_writing_style: [
    "Review only the judgement-based writing format and style areas below:",
    ...STEP_FIFTEEN_JUDGEMENT_AREAS.map((area, index) => `${index + 1}. ${area}`),
    "Step 1.4 already owns every countable rule. Do not report character or word counts, H1 count/presence, heading-level sequence, FAQ count/length, callout count, metadata lengths, keyword placement/density, link HTTP status, required on-page field presence, readability-grade calculation, or the repeated-adjective threshold.",
    "Do not force a finding for each area. Return zero findings when the draft passes.",
    "Tables, examples, definitions, bullets and callouts are optional: report them only when they would materially help the reader or are currently misused.",
    "Keep findings advisory and evidence-based unless a genuine writing defect blocks safe publication.",
    "Every finding must identify a precise location and an observed issue. Every stable_key must be unique.",
    "Use rule references beginning with style.",
  ].join("\n"),
  review_information_gain: [
    "Review only unique value and information gain. Information gain means useful detail beyond obvious or common guidance about the topic.",
    "Assess what the draft adds beyond common knowledge; identify only precise sections or passages that are genuinely generic or provide little reader value; and propose a concrete, supportable addition that would make each identified passage more useful.",
    "Use optional client_insights as first-hand context when supplied, but never present it as verified factual evidence. Missing client_insights never blocks this review.",
    "Suggested additions must be achievable from the draft, handoff, client_insights or approved reference snapshots. Do not request unavailable research or invent facts, statistics, product claims, prices, dimensions, provenance, designer attribution, customer quotes, showroom evidence, survey results or business knowledge.",
    "Do not require novelty for necessary definitions, safety explanations or concise introductory context. Distinguish concise useful writing from genuinely generic filler.",
    "Do not force findings per section. Return zero findings when the draft already provides meaningful unique value. Avoid vague advice such as ‘add more detail’: identify what useful detail is missing and why it helps.",
    "Findings are advisory unless the draft is substantially generic and provides no meaningful reader value.",
    "This review has no competitor corpus. Judge only against model knowledge, acknowledge that limitation in your reasoning, and never claim competitor comparison or research.",
    "Do not repeat Step 1.4 countable checks, Step 1.5 writing-style judgements, Step 1.7 fact verification, or Step 1.8 internal-link/conversion review.",
    "Every finding must identify a precise location, the observed generic passage, why it adds limited value, and a concrete supportable addition. Every stable_key must be unique. Use rule references beginning with value.",
  ].join("\n"),
  review_fact_checking: [
    "Review the deterministic fact inventory supplied by the application and return only optional advisory findings tied to its inventory IDs.",
    "Do not return claims, evidence sources, claim status, claim type, claim location, corrected prose or unknown fields. The application owns the complete claim table and verification outcome.",
    "Never infer verification or contradiction from model knowledge, reference prose, search snippets, gateway assertions or model-emitted URLs.",
    "Findings may identify a precise factual risk only. Every inventory ID must exactly match a supplied ID; use rule references beginning with fact.",
  ].join("\n"),
  review_link_conversion: [
    "Review only the supplied draft-link occurrences for anchor-text quality, contextual suitability, and whether each commercial link supports a useful conversion path rather than acting as decoration.",
    "Hierarchy is a priority only after contextual suitability is established. Never reject a contextually suitable target solely because another shortlist item has a better hierarchy rank.",
    "Use only rule references beginning link. Return findings only; never rewrite prose.",
    "Explicit exclusions: do not judge or report shortlist membership, HTTP status, redirects, transport resolution, hierarchy classification/rank integrity, link counts, commercial body-presence, factual accuracy, writing style or information gain. Those are application-owned or belong to other steps.",
    "Treat the supplied shortlist status as unknown: the application deliberately supplies no status judgement to you.",
    "Every finding must identify the supplied anchor and precise location, explain the observed context or conversion problem, and suggest a bounded correction. Return zero findings when all supplied uses are suitable.",
  ].join("\n"),
};

const COMPACT_FINDING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["k", "c", "r", "v", "l", "i", "e", "x"],
  properties: {
    k: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" },
    c: { type: "string", minLength: 1 },
    r: { type: "string", minLength: 1 },
    v: { type: "string", enum: ["info", "warning", "blocker"] },
    l: {
      type: "object",
      additionalProperties: false,
      required: ["id", "f", "a", "b", "s"],
      properties: {
        id: { type: ["string", "null"], pattern: "^loc-[0-9]{4}$" },
        f: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
        a: { type: ["integer", "null"], minimum: 1 },
        b: { type: ["integer", "null"], minimum: 1 },
        s: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
      },
    },
    i: { type: "string", minLength: 1, maxLength: 2000 },
    e: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
    x: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

const compactEnvelopeJsonSchema = (rule: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["f"],
  properties: {
    f: {
      type: "array",
      maxItems: 100,
      items: {
        ...COMPACT_FINDING_JSON_SCHEMA,
        properties: { ...COMPACT_FINDING_JSON_SCHEMA.properties, r: rule },
      },
    },
  },
});

const STEP_FIFTEEN_RULES = [
  "style.recommended_structure",
  "style.answer_first",
  "style.key_takeaways_bluf",
  "style.conclusion_bluf",
  "style.heading_specificity",
  "style.definition_quality",
  "style.examples_use_cases",
  "style.bullets_use",
  "style.tables_use",
  "style.conversational_tone",
  "style.sentence_readability",
  "style.paragraph_readability",
  "style.callout_placement",
] as const;
const STEP_FIFTEEN_COUNTABLE_PATTERN =
  /\b(?:character|word|faq|callout|h1|metadata|meta description|keyword|link)\s+(?:count|length|presence|density|status)\b|\bheading(?:-level)? sequence\b|\breadability grade\b|\brepeated[- ]adjective threshold\b|\b\d+(?:\s*[–-]\s*\d+)?\s+(?:words?|characters?)\b|\b(?:has|contains|uses|includes|shows|there (?:is|are))\s+(?:only\s+)?(?:\d+|one|two|three|four|five|six)\s+(?:h1s?|headings?|faqs?|callouts?|bullets?|links?)\b|\b(?:flesch(?:-kincaid)?|readability)\s+(?:score|grade|level)?\s*(?:is|of|:)?\s*\d+(?:\.\d+)?\b/i;
const StepFifteenFindingSchema = ReviewFindingSchema.superRefine((finding, context) => {
  if (!(STEP_FIFTEEN_RULES as readonly string[]).includes(finding.rule_reference))
    context.addIssue({
      code: "custom",
      path: ["rule_reference"],
      message: "Use an allowed Step 1.5 judgement rule",
    });
  if (
    STEP_FIFTEEN_COUNTABLE_PATTERN.test(
      [finding.category, finding.issue, finding.evidence, finding.suggested_fix]
        .filter(Boolean)
        .join(" "),
    )
  )
    context.addIssue({
      code: "custom",
      path: ["issue"],
      message: "Step 1.4 owns countable findings",
    });
});
const StepSixteenFindingSchema = ReviewFindingSchema.superRefine((finding, context) => {
  if (!finding.rule_reference.startsWith("value."))
    context.addIssue({ code: "custom", path: ["rule_reference"], message: "Use value.* rules" });
  const suggestion = finding.suggested_fix.trim().toLocaleLowerCase("en-GB");
  if (/^(?:please )?add more detail[.!]?$/.test(suggestion))
    context.addIssue({
      code: "custom",
      path: ["suggested_fix"],
      message: "The addition must be concrete",
    });
  if (
    /\b(?:invent|research|survey|statistics?|customer quotes?|showroom evidence|sales data|designer attribution|provenance|price|dimensions?)\b/.test(
      suggestion,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["suggested_fix"],
      message: "The addition requires unavailable or unverified evidence",
    });
});
const StepSeventeenFindingSchema = z
  .object({
    k: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
    q: z.string().trim().min(1),
    r: z.string().regex(/^fact\./),
    v: z.enum(["info", "warning", "blocker"]),
    i: z.string().trim().min(1),
    x: z.string().trim().min(1),
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      /\b(?:verified|contradicted)\s+by\b|\b(?:evidence|source)\s+(?:proves?|confirms?|establishes?)\b/i.test(
        `${finding.i} ${finding.x}`,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["i"],
        message: "Model findings cannot assert evidence or verification",
      });
  });
const STEP_EIGHTEEN_RULES = [
  "link.anchor_quality",
  "link.contextual_fit",
  "link.conversion_alignment",
  "link.decorative_placement",
] as const;
const StepEighteenFindingSchema = ReviewFindingSchema.superRefine((finding, context) => {
  if (!(STEP_EIGHTEEN_RULES as readonly string[]).includes(finding.rule_reference))
    context.addIssue({
      code: "custom",
      path: ["rule_reference"],
      message: "Use an allowed Step 1.8 judgement rule",
    });
});
const StepEighteenWireFindingSchema = z
  .object({
    k: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
    q: z.number().int().min(1),
    r: z.enum(STEP_EIGHTEEN_RULES),
    v: z.enum(["info", "warning", "blocker"]),
    i: z.string().trim().min(1),
    x: z.string().trim().min(1),
  })
  .strict();
const StepEighteenEnvelopeSchema = z
  .object({ f: z.array(StepEighteenWireFindingSchema).max(100) })
  .strict();

const STEP_FIFTEEN_RESPONSE_JSON_SCHEMA = compactEnvelopeJsonSchema({
  type: "string",
  enum: STEP_FIFTEEN_RULES,
});
const STEP_SIXTEEN_RESPONSE_JSON_SCHEMA = compactEnvelopeJsonSchema({
  type: "string",
  pattern: "^value\\.",
});
const STEP_EIGHTEEN_RESPONSE_JSON_SCHEMA = {
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
        required: ["k", "q", "r", "v", "i", "x"],
        properties: {
          k: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" },
          q: { type: "integer", minimum: 1 },
          r: { type: "string", enum: STEP_EIGHTEEN_RULES },
          v: { type: "string", enum: ["info", "warning", "blocker"] },
          i: { type: "string", minLength: 1, maxLength: 2000 },
          x: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
} as const;

const StepSeventeenEnvelopeSchema = z
  .object({ f: z.array(StepSeventeenFindingSchema).max(100) })
  .strict();

const STEP_SEVENTEEN_RESPONSE_JSON_SCHEMA = {
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
        required: ["k", "q", "r", "v", "i", "x"],
        properties: {
          k: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" },
          q: { type: "string", minLength: 1 },
          r: { type: "string", pattern: "^fact\\." },
          v: { type: "string", enum: ["info", "warning", "blocker"] },
          i: { type: "string", minLength: 1, maxLength: 2000 },
          x: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
} as const;

function strictResponseFormat(step: ReviewRequest["step"]) {
  if (step === "review_writing_style")
    return { name: "mobelaris_step_1_5_findings", schema: STEP_FIFTEEN_RESPONSE_JSON_SCHEMA };
  if (step === "review_information_gain")
    return { name: "mobelaris_step_1_6_findings", schema: STEP_SIXTEEN_RESPONSE_JSON_SCHEMA };
  if (step === "review_fact_checking")
    return { name: "mobelaris_step_1_7_fact_review", schema: STEP_SEVENTEEN_RESPONSE_JSON_SCHEMA };
  return { name: "mobelaris_step_1_8_link_review", schema: STEP_EIGHTEEN_RESPONSE_JSON_SCHEMA };
}

function textualResponseShape(step: ReviewRequest["step"]): string {
  const finding =
    '{ "k": stable_key, "c": category, "r": rule_reference, "v": "info" | "warning" | "blocker", "l": { "id": location_id | null, "f": null, "a": null, "b": null, "s": null }, "i": issue, "e": evidence | null, "x": suggested_fix }';
  if (step === "review_writing_style" || step === "review_information_gain")
    return `{ "f": [${finding}] }`;
  if (step === "review_link_conversion")
    return '{ "f": [{ "k": stable_key, "q": supplied occurrence number, "r": "link.anchor_quality" | "link.contextual_fit" | "link.conversion_alignment" | "link.decorative_placement", "v": "info" | "warning" | "blocker", "i": issue, "x": suggested_fix }] }';
  if (step === "review_fact_checking")
    return '{ "f": [{ "k": stable_key, "q": supplied inventory ID, "r": string beginning "fact.", "v": "info" | "warning" | "blocker", "i": advisory fact-risk note, "x": advisory operator action }] }';
  return `{ "findings": [${finding}] }`;
}

function boundedText(value: string | undefined, limit: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function subjectiveWritingGuide(content: string): string | undefined {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^##\s+Required writing approach\s*$/i.test(line));
  if (start < 0) return undefined;
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return boundedText(
    lines
      .slice(start, end)
      // Numeric readability targets belong to deterministic Step 1.4, not subjective style review.
      .filter((line) => !/\bGrade\s*8\b|\breadability\s+(?:grade|score|target)\b/i.test(line))
      .join("\n"),
    STYLE_REVIEW_CONTEXT_LIMITS.writing_guide_chars,
  );
}

function styleReviewContext(request: ReviewRequest): string {
  const guides = request.reference_snapshots
    .filter((snapshot) => snapshot.kind === "blog_writing_guide")
    .flatMap((snapshot) => {
      const content = subjectiveWritingGuide(snapshot.content);
      return content ? [`Active mapped writing guide (${snapshot.version_id}):\n${content}`] : [];
    });
  return guides.join("\n\n") || "Active mapped writing guide: no subjective style rules supplied.";
}

function informationGainContext(request: ReviewRequest): string[] {
  const topic = boundedText(
    [request.handoff.primary_keyword, ...request.handoff.related_keywords].join("; "),
    INFORMATION_GAIN_CONTEXT_LIMITS.topic_chars,
  )!;
  const notes = boundedText(
    request.handoff.notes,
    INFORMATION_GAIN_CONTEXT_LIMITS.handoff_notes_chars,
  );
  const insights = boundedText(
    request.handoff.client_insights,
    INFORMATION_GAIN_CONTEXT_LIMITS.client_insights_chars,
  );
  let referenceBudget = INFORMATION_GAIN_CONTEXT_LIMITS.reference_total_chars;
  const references = request.reference_snapshots.flatMap((snapshot) => {
    if (referenceBudget <= 0) return [];
    const content = boundedText(
      snapshot.content,
      Math.min(INFORMATION_GAIN_CONTEXT_LIMITS.reference_snapshot_chars, referenceBudget),
    );
    if (!content) return [];
    referenceBudget -= content.length;
    return [`Approved reference ${snapshot.kind} (${snapshot.version_id}):\n${content}`];
  });
  return [
    `Bounded topic context: ${topic}`,
    notes ? `Bounded handoff notes: ${notes}` : "Bounded handoff notes: not supplied.",
    insights
      ? `Bounded client insights (context only; not verified evidence): ${insights}`
      : "Bounded client insights: not supplied. This does not block the review.",
    ...references,
  ];
}

export function buildReviewMessages(request: ReviewRequest): ChatMessage[] {
  const system = [
    `You are the reviewer for the Mobelaris blog step ${request.step}.`,
    STEP_BRIEF[request.step],
    "You are a reviewer, not a rewriter: return structured findings only and never rewritten prose.",
    "Write finding text in British English (UK spelling, grammar and idiom).",
    "Only report issues actually present in the supplied draft.",
    "A passing draft must return an empty findings array. Never invent a finding to fill a criterion.",
    "Every stable_key (k) must be unique within the response.",
    request.step === "review_fact_checking"
      ? "Use only the compact fact-advisory wire keys shown below. They are expanded before persistence."
      : "Use only the compact wire keys shown below. They are expanded before persistence.",
    "Respond with a single JSON object and nothing else — no markdown fences, no commentary.",
    `Return exactly one JSON object matching this shape:\n${textualResponseShape(request.step)}`,
    request.step === "review_fact_checking"
      ? [
          "The root object must contain only f; claims, sources, rewritten prose and all other root fields are forbidden.",
          "Each compact finding is only an advisory fact-risk note and q must reference exactly one supplied inventory ID. Do not include evidence, source, location, category, type, verification status or any other field. Never write ‘verified by’, ‘contradicted by’, or assert that evidence proves, confirms or establishes anything.",
          "The application alone owns claim inventory, type, location, evidence, source, status and hard flags.",
        ].join("\n")
      : request.step === "review_link_conversion"
        ? "The root object must contain only f. Each q must be one supplied occurrence number. Location, category, evidence, sources, claims and all other fields are forbidden; the application attaches trusted location data."
        : "The root object must contain only the compact f array; sources, claims and all other root fields are forbidden.",
  ].join("\n");
  const lines = [
    `Primary keyword: ${request.handoff.primary_keyword}`,
    `Run: ${request.run_id}, document version: ${request.document_version_id}`,
  ];
  if (request.step === "review_writing_style") {
    const prepared = prepareReviewDocument(request);
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          styleReviewContext(request),
          `Prepared draft blocks (id=app-issued stable location, h=heading, a/b=absolute line bounds, t=lossless text):\n${JSON.stringify(prepared)}`,
          "Return only { f } as instructed.",
        ].join("\n"),
      },
    ];
  }
  if (request.step === "review_link_conversion") {
    const context = request.link_review_context;
    lines.push(
      `Draft link occurrences (anchor, location and surrounding context only):\n${
        context?.occurrences
          .map(
            (item, index) =>
              `- occurrence ${index + 1}; anchor: ${item.anchor}; url: ${item.url}; location: line ${item.location.line_start}${item.location.section ? `, section ${item.location.section}` : ""}; context: ${item.context}`,
          )
          .join("\n") || "None"
      }`,
      `Run shortlist (safe metadata only; no status judgement):\n${
        context?.shortlist
          .map(
            (item) =>
              `- title: ${item.title}; url: ${item.url}; hierarchy: ${item.hierarchy ?? "unknown"}; rank: ${item.hierarchy_rank ?? "unknown"}; relevance: ${item.relevance}`,
          )
          .join("\n") || "None"
      }`,
      "Return only { f } as instructed.",
    );
    return [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n") },
    ];
  }
  if (request.step === "review_fact_checking") {
    lines.push(
      `Numbered fact inventory (no draft or reference bodies are supplied):\n${
        request.fact_inventory
          .map(
            (item, index) =>
              `${index + 1}. inventory_key=${item.stable_key}; text=${item.text}; classification=${item.classification}; claim_type=${item.claim_type}`,
          )
          .join("\n") || "None"
      }`,
      "Return only { f }. Return an empty f array when there are no useful advisories.",
    );
    return [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n") },
    ];
  }
  if (request.step === "review_information_gain") lines.push(...informationGainContext(request));
  if (request.step !== "review_information_gain" && request.internal_links.length)
    lines.push(
      `Internal links provided to the draft: ${request.internal_links
        .map((link) => `${link.title} (${link.url})`)
        .join("; ")}`,
    );
  if (request.step !== "review_information_gain")
    for (const snapshot of request.reference_snapshots)
      lines.push(
        `Reference snapshot ${snapshot.kind} (version ${snapshot.version_id}):\n${snapshot.content}`,
      );
  const prepared = prepareReviewDocument(request);
  lines.push(
    `Prepared draft sections (id=app-issued stable location, h=heading, a/b=absolute line bounds, t=lossless text):\n${JSON.stringify(prepared)}`,
    "Return only { f } as instructed.",
  );
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * The shared FindingLocationSchema requires a `field` string, so a model
 * location of `{ section, excerpt? }` is normalised defensively: the section
 * becomes the field and the excerpt (not representable in the schema) is
 * carried into the finding evidence instead of being lost.
 */
function normalizeFinding(candidate: unknown): ReviewFinding | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;
  const location = record.location;
  if (typeof location === "object" && location !== null && !("field" in location)) {
    const locationRecord = location as Record<string, unknown>;
    const section =
      typeof locationRecord.section === "string" && locationRecord.section.trim()
        ? locationRecord.section.trim()
        : "body_markdown";
    record.location = { field: section, section };
    if (typeof locationRecord.excerpt === "string" && locationRecord.excerpt.trim()) {
      const excerpt = `Excerpt: ${locationRecord.excerpt.trim()}`;
      record.evidence =
        typeof record.evidence === "string" && record.evidence.trim()
          ? `${record.evidence.trim()} (${excerpt})`
          : excerpt;
    }
  }
  const parsed = ReviewFindingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

interface ParsedReviewBody {
  findings: ReviewFinding[];
  sources: ReviewResponse["sources"];
  claims: ReviewResponse["claims"];
}

/** Parses and defensively repairs the model reply; returns undefined when unparseable. */
function parseReviewBody(content: string, request: ReviewRequest): ParsedReviewBody | undefined {
  const candidate = extractJsonObject(content);
  if (typeof candidate !== "object" || candidate === null) return undefined;
  if (request.step === "review_link_conversion") {
    // Step 1.8 returns only a bounded judgement plus an app-issued occurrence
    // number. The application attaches the trusted occurrence location and does
    // not accept model-generated location, category or evidence fields.
    const envelope = StepEighteenEnvelopeSchema.safeParse(candidate);
    if (!envelope.success) return undefined;
    const stableKeys = envelope.data.f.map((finding) => finding.k);
    if (new Set(stableKeys).size !== stableKeys.length) return undefined;
    const findings = envelope.data.f.map((finding) => {
      const occurrence = request.link_review_context?.occurrences[finding.q - 1];
      if (!occurrence) return undefined;
      return StepEighteenFindingSchema.safeParse({
        stable_key: finding.k,
        category: "link_conversion",
        rule_reference: finding.r,
        severity: finding.v,
        location: occurrence.location,
        issue: finding.i,
        suggested_fix: finding.x,
      });
    });
    if (findings.some((finding) => !finding?.success)) return undefined;
    return {
      findings: findings.flatMap((finding) => (finding?.success ? [finding.data] : [])),
      sources: [],
      claims: [],
    };
  }
  if (request.step === "review_writing_style" || request.step === "review_information_gain") {
    // Steps 1.5/1.6 use strict structured output. They must not carry rewritten
    // prose, sources, claims or any unknown envelope/row fields.
    const compact = CompactReviewEnvelopeSchema.safeParse(candidate);
    if (!compact.success) return undefined;
    const prepared = prepareReviewDocument(request);
    const locations = new Map(
      prepared?.sections.map((section) => [
        section.id,
        { field: "body_markdown", line_start: section.a, line_end: section.b, section: section.h },
      ]) ?? [],
    );
    const expanded = compact.data.f.map((finding) => {
      if (!finding.l.id || !locations.has(finding.l.id)) return undefined;
      return expandCompactReviewFinding(
        finding,
        finding.l.id ? locations.get(finding.l.id) : undefined,
      );
    });
    if (expanded.some((finding) => finding === undefined)) return undefined;
    const schema =
      request.step === "review_writing_style"
        ? z.array(StepFifteenFindingSchema)
        : z.array(StepSixteenFindingSchema);
    const parsed = schema.safeParse(expanded);
    if (!parsed.success) return undefined;
    const findings = parsed.data;
    const stableKeys = findings.map((finding) => finding.stable_key);
    if (new Set(stableKeys).size !== stableKeys.length) return undefined;
    return { findings, sources: [], claims: [] };
  }
  if (request.step === "review_fact_checking") {
    const envelope = StepSeventeenEnvelopeSchema.safeParse(candidate);
    if (!envelope.success) return undefined;
    const findingKeys = envelope.data.f.map((finding) => finding.k);
    if (new Set(findingKeys).size !== findingKeys.length) return undefined;
    const inventoryByKey = new Map(request.fact_inventory.map((item) => [item.stable_key, item]));
    if (envelope.data.f.some((finding) => !inventoryByKey.has(finding.q))) return undefined;
    const findings = envelope.data.f.map((finding) => {
      const item = inventoryByKey.get(finding.q)!;
      return ReviewFindingSchema.parse({
        stable_key: finding.k,
        category: "fact_advisory",
        rule_reference: finding.r,
        severity: finding.v,
        location: item.location,
        issue: finding.i,
        suggested_fix: finding.x,
      });
    });
    return { findings, sources: [], claims: [] };
  }
  const record = candidate as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return undefined;
  const parsedFindings = record.findings.map((item) => normalizeFinding(item));
  if (parsedFindings.some((item) => item === undefined)) return undefined;
  const findings = parsedFindings as ReviewFinding[];
  const stableKeys = findings.map((finding) => finding.stable_key);
  if (new Set(stableKeys).size !== stableKeys.length) return undefined;
  return { findings, sources: [], claims: [] };
}

const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class ChatCompletionReviewProvider implements ReviewProvider {
  readonly provider: string;
  readonly model: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ChatCompletionReviewProviderOptions = {}) {
    const token = options.token ?? process.env.OPENROUTER_API_KEY;
    if (!token?.trim())
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_TOKEN_MISSING",
        "OPENROUTER_API_KEY is not configured; the review provider cannot be constructed",
      );
    const model = options.model ?? process.env.OPENROUTER_MODEL;
    if (!model?.trim())
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_MODEL_INVALID",
        "OPENROUTER_MODEL is not configured; no default model is assumed",
      );
    if (!model.trim())
      throw new ReviewProviderError("REVIEW_PROVIDER_MODEL_INVALID", "Model identifier is empty");
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

  async review(input: ReviewRequest): Promise<ReviewResponse> {
    const request = ReviewRequestSchema.parse(input);
    logModelProviderOperationStarted(this.provider, "review", this.model);
    if (request.model !== this.model)
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_MODEL_MISMATCH",
        "Review request model does not match pinned provider model",
      );
    const startedAt = Date.now();
    const first = await this.callModel(
      buildReviewMessages(request),
      request.temperature,
      request.step,
    );
    const body =
      first?.choices[0]?.finish_reason !== "length"
        ? parseReviewBody(first?.choices[0]?.message.content ?? "", request)
        : undefined;
    if (first && body) return this.toResponse(request, first, body, startedAt);
    // Steps 1.5–1.7 permit exactly one request. Unusable HTTP 200 output is
    // discarded rather than echoed into a corrective request or persisted.
    if (SINGLE_ATTEMPT_REVIEW_STEPS.has(request.step)) {
      const safeLocation = prepareReviewDocument(request).sections[0];
      const appOwnedLocation = safeLocation
        ? {
            field: "body_markdown" as const,
            line_start: safeLocation.a,
            line_end: safeLocation.b,
            section: safeLocation.h,
          }
        : { field: "body_markdown" as const };
      const advisory =
        request.step === "review_writing_style"
          ? {
              stable_key: "style-advisory-unavailable",
              category: "style_advisory_unavailable",
              rule_reference: "style.advisory_unavailable",
              severity: "warning" as const,
              location: appOwnedLocation,
              issue:
                "The optional writing-style advisory was unavailable because its response was unusable.",
              suggested_fix:
                "Explicitly accept or reject this warning during findings review before the run continues.",
            }
          : request.step === "review_information_gain"
            ? {
                stable_key: "value-advisory-unavailable",
                category: "information_gain_advisory_unavailable",
                rule_reference: "value.advisory_unavailable",
                severity: "warning" as const,
                location: appOwnedLocation,
                issue:
                  "The optional information-gain advisory was unavailable because its response was unusable.",
                suggested_fix:
                  "Explicitly accept or reject this warning during findings review before the run continues.",
              }
            : {
                stable_key: "fact-advisory-unavailable",
                category: "fact_advisory_unavailable",
                rule_reference: "fact.advisory_unavailable",
                severity: "warning" as const,
                location: { field: "body_markdown" as const },
                issue:
                  "The optional model fact advisory was unavailable because its response was unusable.",
                suggested_fix:
                  "Explicitly accept or reject this warning during findings review; use the application verifier findings for claim decisions.",
              };
      logModelProviderOutputInvalid(this.provider, "review", this.model, 1);
      return ReviewResponseSchema.parse({
        request_id: `review_${hashIdempotencyInput(request)}`,
        findings: [advisory],
        sources: [],
        claims: [],
        usage: {
          input_units: first?.usage?.prompt_tokens ?? 0,
          output_units: first?.usage?.completion_tokens ?? 0,
          latency_ms: Math.max(0, Date.now() - startedAt),
          cost_micros:
            first?.usage?.cost !== undefined
              ? Math.round(first.usage.cost * 1_000_000)
              : computeCostMicros(
                  this.model,
                  first?.usage?.prompt_tokens ?? 0,
                  first?.usage?.completion_tokens ?? 0,
                ),
        },
      });
    }
    if (first?.choices[0]?.finish_reason === "length")
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_TRUNCATED",
        "Review provider output reached the operation token limit",
      );
    const corrective = await this.callModel(
      [
        ...buildReviewMessages(request),
        {
          role: "user",
          content:
            request.step === "review_link_conversion"
              ? 'Your previous reply was invalid. Reply with exactly one JSON object and no other text. Use only {"f":[]} or {"f":[{"k":"unique-key","q":1,"r":"link.anchor_quality","v":"warning","i":"observed issue","x":"bounded correction"}]}. q must be a supplied occurrence number; use only the four allowed link.* rules; do not add location, category, evidence, sources, claims or prose.'
              : "Your previous reply was not a single valid JSON object of the required shape, contained an invalid finding, or reused a finding stable_key. Reply again with exactly one JSON object of the same shape, with no fences or other text. Every finding must be valid and each stable_key must be unique within the findings array.",
        },
      ],
      request.temperature,
      request.step,
    );
    if (corrective?.choices[0]?.finish_reason === "length")
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_TRUNCATED",
        "Review provider output reached the operation token limit",
      );
    const retriedBody = corrective
      ? parseReviewBody(corrective.choices[0]?.message.content ?? "", request)
      : undefined;
    if (!corrective || !retriedBody) {
      logModelProviderOutputInvalid(this.provider, "review", this.model, 2);
      throw new ReviewProviderError(
        "REVIEW_PROVIDER_UNPARSEABLE",
        "Review provider returned unparseable output after 2 attempts",
      );
    }
    return this.toResponse(request, corrective, retriedBody, startedAt);
  }

  private toResponse(
    request: ReviewRequest,
    wire: WireResponse,
    body: ParsedReviewBody,
    startedAt: number,
  ): ReviewResponse {
    return ReviewResponseSchema.parse({
      request_id: wire.id?.trim() || `review_${hashIdempotencyInput(request)}`,
      findings: body.findings,
      sources: body.sources,
      claims: body.claims,
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

  /** One bounded HTTP attempt loop: initial request plus at most 2 retries on 5xx/429/network. */
  private async callModel(
    messages: ChatMessage[],
    temperature: number,
    step?: ReviewRequest["step"],
  ): Promise<WireResponse | null> {
    let lastError: ReviewProviderError | undefined;
    const retries = step && SINGLE_ATTEMPT_REVIEW_STEPS.has(step) ? 0 : MAX_HTTP_RETRIES;
    for (let attempt = 0; attempt <= retries; attempt++) {
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
            ...(step && strictResponseFormat(step)
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: strictResponseFormat(step)!.name,
                      strict: true,
                      schema: strictResponseFormat(step)!.schema,
                    },
                  },
                  ...(this.provider === "openrouter"
                    ? { provider: { require_parameters: true } }
                    : {}),
                }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbort(error))
          throw new ReviewProviderError(
            "REVIEW_PROVIDER_TIMEOUT",
            "Review provider request timed out",
          );
        lastError = new ReviewProviderError(
          "REVIEW_PROVIDER_NETWORK",
          "Review provider request failed at network level",
        );
        if (attempt === retries) throw lastError;
        await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) {
        try {
          const wire = WireResponseSchema.safeParse(
            extractJsonObject(await readBoundedResponseBody(response)),
          );
          // An unusable HTTP 200 envelope is a parse failure, never a transport retry.
          return wire.success ? wire.data : null;
        } catch {
          return null;
        }
      }
      const status = response.status;
      logModelProviderHttpFailure(this.provider, "review", this.model, status);
      lastError = new ReviewProviderError(
        status === 400 || status === 404 || status === 422
          ? "REVIEW_PROVIDER_STRUCTURED_OUTPUT_UNSUPPORTED"
          : "REVIEW_PROVIDER_HTTP_STATUS",
        status === 402
          ? "Review provider account has no billing configured for model usage"
          : status === 400 || status === 404 || status === 422
            ? "The configured review-model endpoint does not support the required structured output"
            : `Review provider request failed with HTTP ${status}`,
      );
      if (status !== 429 && status < 500) throw lastError;
      if (attempt === retries) throw lastError;
      await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
    throw (
      lastError ??
      new ReviewProviderError("REVIEW_PROVIDER_NETWORK", "Review provider request failed")
    );
  }
}

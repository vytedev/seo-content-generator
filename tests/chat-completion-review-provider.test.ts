import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FactInventoryItem,
  ReviewFinding,
  ReviewRequest,
} from "../src/shared/milestone-three.js";
import { ReviewResponseSchema } from "../src/shared/milestone-three.js";
import {
  ChatCompletionReviewProvider,
  ReviewProviderError,
  buildReviewMessages,
} from "../src/server/providers/chat-completion-review-provider.js";
import { NoNetworkFactVerifier } from "../src/server/providers/fact-verifier.js";
const TEST_MODEL = "provider/configured-model";
import type { StructuredDraft } from "../src/shared/milestone-two.js";

const TOKEN = "openrouter_test_key_not_real";
const noSleep = () => Promise.resolve();

function validDraft(): StructuredDraft {
  return {
    title: "A guide to walnut dining tables",
    slug: "walnut-dining-tables",
    meta_description: "A practical Mobelaris guide to walnut dining tables.",
    og_title: "Walnut dining tables",
    og_description: "A practical guide.",
    images: [
      {
        alt: "A walnut dining table",
        filename: "walnut-dining-table",
        placement: { marker: "walnut-table" },
      },
    ],
    faqs: [{ question: "How do I care for walnut?", answer: "Oil it seasonally." }],
    markdown:
      "# Walnut dining tables\n\n<!-- MOBELARIS_IMAGE:walnut-table -->\n\nConsider your space before choosing a table.",
    claims: [{ text: "Solid walnut is a hardwood", type: "material", status: "unverified" }],
  };
}

function factInventory(): FactInventoryItem[] {
  return [
    {
      stable_key: "inventory-aaa",
      text: "The table is 180 cm long",
      classification: "factual_figure",
      claim_type: "dimension",
      location: { field: "body_markdown", line_start: 3 },
    },
    {
      stable_key: "inventory-bbb",
      text: "The chair was designed by Charles Eames",
      classification: "attribution_provenance",
      claim_type: "provenance",
      location: { field: "body_markdown", line_start: 5 },
    },
  ];
}

function validRequest(
  step: ReviewRequest["step"] = "review_writing_style",
  model = TEST_MODEL,
): ReviewRequest {
  return {
    run_id: "run-1",
    step,
    document_version_id: "docver-1",
    handoff: {
      plane_ticket: "MOB-123",
      primary_keyword: "walnut dining tables",
      related_keywords: ["walnut table"],
      page_type: "blog",
      word_count_target: 1200,
      locales_for_translation: [],
      notes: "Focus on modern interiors",
    },
    draft: validDraft(),
    internal_links: [
      {
        url: "https://www.mobelaris.com/blogs/furniture-guides",
        title: "Furniture guides",
        relevance: 0.9,
      },
    ],
    reference_snapshots: [],
    fact_inventory: step === "review_fact_checking" ? factInventory() : [],
    prompt: { template_id: "mobelaris.review.style", template_version: "1.0.0" },
    temperature: 0.2,
    model,
  };
}

function modelFinding(): Record<string, unknown> {
  return {
    stable_key: "tone-inconsistent",
    category: "style",
    rule_reference: "style.conversational_tone",
    severity: "warning",
    location: { field: "body_markdown", section: "introduction" },
    issue: "The phrase is too casual for the Mobelaris brand voice.",
    evidence: "The draft says ‘super awesome tables’.",
    suggested_fix: "Replace the phrase with more measured British English wording.",
  };
}

function valueFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stable_key: "generic-buying-advice",
    category: "information_gain",
    rule_reference: "value.generic",
    severity: "warning",
    location: { field: "body_markdown", section: "Choosing walnut" },
    issue: "The passage repeats common buying advice without helping the reader compare options.",
    evidence: "The section says only to choose a table that suits the room.",
    suggested_fix:
      "Use the supplied room-planning insight to explain which clearance decision changes the choice.",
    ...overrides,
  };
}

function completion(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function wire(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  // Adapt durable test fixtures to the compact transient provider contract.
  try {
    const fenced = /^```json\n([\s\S]+)\n```$/.exec(content);
    const body = JSON.parse(fenced?.[1] ?? content) as Record<string, unknown>;
    if (Array.isArray(body.findings) && !Array.isArray(body.claims)) {
      const { findings, ...rest } = body;
      const compact = JSON.stringify({
        f: findings.map((item) => {
          const finding = item as Record<string, any>;
          const location = finding.location ?? {};
          const {
            stable_key,
            category,
            rule_reference,
            severity,
            location: _location,
            issue,
            evidence,
            suggested_fix,
            ...extra
          } = finding;
          return {
            k: stable_key,
            c: category,
            r: rule_reference,
            v: severity,
            l: {
              id:
                location.field === "body_markdown" && !String(rule_reference).startsWith("link.")
                  ? "loc-0001"
                  : null,
              f: location.field ?? null,
              a: location.line_start ?? null,
              b: location.line_end ?? null,
              s: location.section ?? null,
            },
            i: issue,
            e: evidence ?? null,
            x: suggested_fix,
            ...extra,
          };
        }),
        ...rest,
      });
      content = fenced ? `\`\`\`json\n${compact}\n\`\`\`` : compact;
    }
  } catch {
    /* deliberately malformed responses stay malformed */
  }
  return {
    id: "openrouter-chatcmpl-test",
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  };
}

function makeProvider(fetcher: typeof fetch) {
  return new ChatCompletionReviewProvider({
    token: TOKEN,
    model: TEST_MODEL,
    fetcher,
    sleep: noSleep,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatCompletionReviewProvider construction", () => {
  it("throws a clear typed error when the token is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    expect(() => new ChatCompletionReviewProvider()).toThrow(ReviewProviderError);
    expect(() => new ChatCompletionReviewProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("pins the default model and records it in provider identity", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    const provider = makeProvider(vi.fn());
    expect(provider.provider).toBe("openrouter");
    expect(provider.model).toBe(TEST_MODEL);
  });
});

describe("ChatCompletionReviewProvider.review", () => {
  it("parses valid strict findings and maps usage", async () => {
    const finding = modelFinding();
    const fetcher = vi.fn(async () =>
      completion(
        wire(JSON.stringify({ findings: [finding] }), {
          prompt_tokens: 51,
          completion_tokens: 73,
        }),
      ),
    );
    const response = await makeProvider(fetcher).review(validRequest());
    expect(() => ReviewResponseSchema.parse(response)).not.toThrow();
    expect(response.findings).toHaveLength(1);
    expect(response.findings[0]?.location).toEqual({
      field: "body_markdown",
      line_start: 1,
      line_end: 2,
      section: "Walnut dining tables",
    });
    expect(response.findings[0]?.evidence).toContain("super awesome tables");
    expect(response.sources).toEqual([]);
    expect(response.claims).toEqual([]);
    expect(response.usage).toEqual({
      input_units: 51,
      output_units: 73,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
    expect(response.request_id).toBe("openrouter-chatcmpl-test");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const requestBody = JSON.parse(init.body);
    expect(requestBody.model).toBe(TEST_MODEL);
    expect(requestBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "mobelaris_step_1_5_findings",
        strict: true,
        schema: { additionalProperties: false, required: ["f"] },
      },
    });
    expect(requestBody.provider).toEqual({ require_parameters: true });
  });

  it("turns Step 1.5 token-limit truncation into its deterministic warning", async () => {
    const fetcher = vi.fn(async () =>
      completion({
        choices: [{ message: { content: '{"f":[' }, finish_reason: "length" }],
      }),
    );
    await expect(makeProvider(fetcher).review(validRequest())).resolves.toMatchObject({
      findings: [expect.objectContaining({ rule_reference: "style.advisory_unavailable" })],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("omits OpenRouter routing parameters for Hugging Face compatibility", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ findings: [] }))));
    await new ChatCompletionReviewProvider({
      token: TOKEN,
      model: TEST_MODEL,
      providerName: "huggingface",
      baseUrl: "https://router.huggingface.co/v1/chat/completions",
      fetcher,
      sleep: noSleep,
    }).review(validRequest());
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    expect(body.provider).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
  });

  it("accepts an empty findings array for a passing draft", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ findings: [] }))));
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.findings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still parses fenced, markdown-wrapped JSON", async () => {
    const fetcher = vi.fn(async () =>
      completion(wire("```json\n" + JSON.stringify({ findings: [modelFinding()] }) + "\n```")),
    );
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.findings).toHaveLength(1);
  });

  it("discards malformed, unsafe, unknown-ID and duplicate Step 1.5 HTTP 200 output without correction", async () => {
    const compact = (finding: Record<string, unknown>, id = "loc-0001") => ({
      f: [
        {
          k: finding.stable_key,
          c: finding.category,
          r: finding.rule_reference,
          v: finding.severity,
          l: { id, f: null, a: null, b: null, s: null },
          i: finding.issue,
          e: finding.evidence,
          x: finding.suggested_fix,
        },
      ],
    });
    const finding = modelFinding();
    for (const content of [
      "{ definitely not json",
      JSON.stringify({ ...compact(finding), rewritten_article: "private rejected prose" }),
      JSON.stringify(compact(finding, "loc-9999")),
      JSON.stringify({ f: [...compact(finding).f, ...compact(finding).f] }),
      JSON.stringify(
        compact({
          ...finding,
          rule_reference: "style.tone",
          issue: "The meta description character count is wrong.",
        }),
      ),
      JSON.stringify(
        compact({
          ...finding,
          rule_reference: "style.tone",
          issue: "The draft has two H1 headings.",
        }),
      ),
      JSON.stringify(
        compact({
          ...finding,
          rule_reference: "style.tone",
          issue: "Its Flesch score is 55.",
        }),
      ),
    ]) {
      const fetcher = vi.fn(async () => completion(wire(content)));
      const response = await makeProvider(fetcher).review(validRequest());
      expect(fetcher).toHaveBeenCalledOnce();
      expect(response.findings).toEqual([
        expect.objectContaining({
          stable_key: "style-advisory-unavailable",
          rule_reference: "style.advisory_unavailable",
          severity: "warning",
          location: {
            field: "body_markdown",
            line_start: 1,
            line_end: 2,
            section: "Walnut dining tables",
          },
        }),
      ]);
      expect(JSON.stringify(response)).not.toContain("private rejected prose");
    }
  });

  it("does not retry Step 1.5 HTTP or network failures", async () => {
    for (const fetcher of [
      vi.fn(async () => new Response("rate limited", { status: 429 })),
      vi.fn(async () => new Response("private failure", { status: 503 })),
      vi.fn(async () => {
        throw new Error("private network failure");
      }),
    ]) {
      await expect(makeProvider(fetcher).review(validRequest())).rejects.toBeInstanceOf(
        ReviewProviderError,
      );
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("reports unsupported Step 1.5 structured output safely", async () => {
    const fetcher = vi.fn(async () => new Response("unsupported details", { status: 400 }));
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReviewProviderError);
        expect((error as ReviewProviderError).code).toBe(
          "REVIEW_PROVIDER_STRUCTURED_OUTPUT_UNSUPPORTED",
        );
        expect((error as ReviewProviderError).message).toContain("structured output");
        expect((error as ReviewProviderError).message).not.toContain("unsupported details");
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported Step 1.8 structured output safely", async () => {
    const fetcher = vi.fn(
      async () => new Response("bad request detail with secret", { status: 400 }),
    );
    await expect(
      makeProvider(fetcher).review(validRequest("review_link_conversion")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewProviderError);
      expect((error as ReviewProviderError).code).toBe(
        "REVIEW_PROVIDER_STRUCTURED_OUTPUT_UNSUPPORTED",
      );
      expect((error as ReviewProviderError).message).toContain("structured output");
      expect((error as ReviewProviderError).message).not.toContain("bad request detail");
      expect((error as ReviewProviderError).message).not.toContain(TOKEN);
      return true;
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives a clear billing message for a 402, not a raw status code", async () => {
    const fetcher = vi.fn(async () => new Response("payment required", { status: 402 }));
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReviewProviderError);
        expect((error as ReviewProviderError).code).toBe("REVIEW_PROVIDER_HTTP_STATUS");
        expect((error as ReviewProviderError).message).toBe(
          "Review provider account has no billing configured for model usage",
        );
        expect((error as ReviewProviderError).message).not.toMatch(/HTTP 402/);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a redacted timeout error", async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(makeProvider(fetcher).review(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReviewProviderError);
        expect((error as ReviewProviderError).code).toBe("REVIEW_PROVIDER_TIMEOUT");
        expect((error as ReviewProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
  });

  it("rejects a request whose model does not match the pinned model", async () => {
    const fetcher = vi.fn();
    await expect(
      makeProvider(fetcher).review(validRequest("review_writing_style", "other/model")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewProviderError);
      expect((error as ReviewProviderError).code).toBe("REVIEW_PROVIDER_MODEL_MISMATCH");
      return true;
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to a deterministic review request id when the wire response has none", async () => {
    const fetcher = vi.fn(async () =>
      completion({ choices: [{ message: { content: JSON.stringify({ f: [] }) } }] }),
    );
    const response = await makeProvider(fetcher).review(validRequest());
    expect(response.request_id).toMatch(/^review_[a-f0-9]{64}$/);
    expect(response.usage).toEqual({
      input_units: 0,
      output_units: 0,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
  });
});

describe("ChatCompletionReviewProvider Step 1.6", () => {
  it("accepts zero findings for concise useful content and missing client insights", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ findings: [] }))));
    const response = await makeProvider(fetcher).review(validRequest("review_information_gain"));
    expect(response.findings).toEqual([]);
    const requestBody = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body),
    );
    expect(requestBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "mobelaris_step_1_6_findings", strict: true },
    });
    expect(requestBody.provider).toEqual({ require_parameters: true });
    expect(requestBody.messages.at(-1).content).toContain("not supplied");
  });

  it("includes client insights as context but never verified evidence", async () => {
    const request = validRequest("review_information_gain");
    request.handoff.client_insights =
      "Customers often forget the clearance needed to pull out dining chairs.";
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ findings: [] }))));
    await makeProvider(fetcher).review(request);
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body),
    );
    const user = body.messages.at(-1).content as string;
    expect(user).toContain(request.handoff.client_insights);
    expect(user).toContain("context only; not verified evidence");
  });

  it("turns an unknown app-issued location ID into a safe warning without correction", async () => {
    const finding = valueFinding();
    const invalid = {
      f: [
        {
          k: finding.stable_key,
          c: finding.category,
          r: finding.rule_reference,
          v: finding.severity,
          l: { id: "loc-9999", f: null, a: null, b: null, s: null },
          i: finding.issue,
          e: finding.evidence,
          x: finding.suggested_fix,
        },
      ],
    };
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify(invalid))));
    const response = await makeProvider(fetcher).review(validRequest("review_information_gain"));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.findings).toEqual([
      expect.objectContaining({
        rule_reference: "value.advisory_unavailable",
        severity: "warning",
        location: {
          field: "body_markdown",
          line_start: 1,
          line_end: 2,
          section: "Walnut dining tables",
        },
      }),
    ]);
  });

  it("accepts a concrete evidence-based information-gain finding", async () => {
    const fetcher = vi.fn(async () =>
      completion(wire(JSON.stringify({ findings: [valueFinding()] }))),
    );
    const response = await makeProvider(fetcher).review(validRequest("review_information_gain"));
    expect(response.findings).toHaveLength(1);
    expect(response.findings[0]?.rule_reference).toBe("value.generic");
  });

  it("turns malformed, truncated and unsafe HTTP 200 output into one warning without correction", async () => {
    const invalidBodies = [
      { content: "{not-json" },
      { content: JSON.stringify({ findings: [valueFinding()] }), finishReason: "length" },
      {
        content: JSON.stringify({
          findings: [valueFinding({ suggested_fix: "Add more detail." })],
        }),
      },
      {
        content: JSON.stringify({
          findings: [valueFinding()],
          rewritten_article: "private malformed prose",
        }),
      },
      { content: JSON.stringify({ findings: [{ ...valueFinding(), novelty_score: 2 }] }) },
      { content: JSON.stringify({ findings: [valueFinding(), valueFinding()] }) },
    ];
    for (const invalid of invalidBodies) {
      const fetcher = vi.fn(async () => {
        const response = wire(invalid.content);
        if (invalid.finishReason)
          Object.assign(response.choices[0]!, { finish_reason: invalid.finishReason });
        return completion(response);
      });
      const response = await makeProvider(fetcher).review(validRequest("review_information_gain"));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(response.findings).toEqual([
        expect.objectContaining({ rule_reference: "value.advisory_unavailable" }),
      ]);
      expect(JSON.stringify(response)).not.toContain("private malformed prose");
    }
  });

  it("does not retry Step 1.6 transport failures", async () => {
    for (const fetcher of [
      vi.fn(async () => new Response("private failure", { status: 503 })),
      vi.fn(async () => {
        throw new Error("private network failure");
      }),
    ]) {
      await expect(
        makeProvider(fetcher).review(validRequest("review_information_gain")),
      ).rejects.toBeInstanceOf(ReviewProviderError);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("bounds topic, handoff, client-insight and approved-reference context", async () => {
    const request = validRequest("review_information_gain");
    request.handoff.notes = `notes-${"n".repeat(4_000)}`;
    request.handoff.client_insights = `insights-${"i".repeat(8_000)}`;
    request.reference_snapshots = [
      {
        kind: "content-guidance",
        version_id: "ref-1",
        content_hash: "a".repeat(64),
        immutable_pointer: "ref://content-guidance/ref-1",
        content: `reference-${"r".repeat(10_000)}`,
      },
    ];
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ findings: [] }))));
    await makeProvider(fetcher).review(request);
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    const user = body.messages.at(-1).content as string;
    expect(user).toContain("Bounded topic context:");
    expect(user).toContain("Bounded handoff notes:");
    expect(user).toContain("Bounded client insights");
    expect(user).toContain("Approved reference content-guidance");
    expect(user).not.toContain(request.handoff.notes);
    expect(user).not.toContain(request.handoff.client_insights);
    expect(user).not.toContain(request.reference_snapshots[0]!.content);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports unsupported Step 1.6 structured output safely", async () => {
    const fetcher = vi.fn(async () => new Response("private provider detail", { status: 422 }));
    await expect(
      makeProvider(fetcher).review(validRequest("review_information_gain")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewProviderError);
      expect((error as ReviewProviderError).code).toBe(
        "REVIEW_PROVIDER_STRUCTURED_OUTPUT_UNSUPPORTED",
      );
      expect((error as ReviewProviderError).message).not.toContain("private provider detail");
      return true;
    });
  });
});

describe("ChatCompletionReviewProvider fact-checking contract", () => {
  const factRiskFinding = (overrides: Record<string, unknown> = {}) => ({
    k: "fact-risk-aaa",
    q: "inventory-aaa",
    r: "fact.figure-risk",
    v: "warning",
    i: "The dimension needs approved product verification.",
    x: "Check the inventory claim through the application verifier.",
    ...overrides,
  });
  const validFactBody = () => ({ f: [] });

  it("uses a compact advisories-only Step 1.7 schema", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify(validFactBody()))));
    const response = await makeProvider(fetcher).review(validRequest("review_fact_checking"));
    expect(response).toMatchObject({ findings: [], claims: [], sources: [] });
    expect(fetcher).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body),
    );
    expect(requestBody.response_format.json_schema).toMatchObject({
      name: "mobelaris_step_1_7_fact_review",
      strict: true,
      schema: { additionalProperties: false, required: ["f"] },
    });
    expect(JSON.stringify(requestBody.response_format.json_schema.schema)).not.toContain("claims");
  });

  it("maps valid advisory inventory IDs while keeping claim data app-owned", async () => {
    const fetcher = vi.fn(async () => completion(wire(JSON.stringify({ f: [factRiskFinding()] }))));
    const response = await makeProvider(fetcher).review(validRequest("review_fact_checking"));
    expect(response.findings[0]).toMatchObject({
      category: "fact_advisory",
      location: { field: "body_markdown", line_start: 3 },
    });
    expect(response.findings[0]).not.toHaveProperty("evidence");
    expect(response.claims).toEqual([]);
  });

  it("turns malformed, truncated, unsafe and unknown-ID HTTP 200 output into one warning without correction", async () => {
    const invalid = [
      '{"f":[',
      JSON.stringify({ f: [factRiskFinding({ q: "inventory-unknown" })] }),
      JSON.stringify({ f: [factRiskFinding({ evidence: "private raw evidence" })] }),
      JSON.stringify({ f: [factRiskFinding({ i: "Verified by a secret provider response." })] }),
    ];
    for (const content of invalid) {
      const fetcher = vi.fn(async () => {
        const response = wire(content);
        if (content.startsWith('{"f":['))
          Object.assign(response.choices[0]!, { finish_reason: "length" });
        return completion(response);
      });
      const response = await makeProvider(fetcher).review(validRequest("review_fact_checking"));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(response.findings).toEqual([
        expect.objectContaining({ rule_reference: "fact.advisory_unavailable" }),
      ]);
      expect(JSON.stringify(response)).not.toContain("private raw evidence");
      expect(JSON.stringify(response)).not.toContain("secret provider response");
      const request = validRequest("review_fact_checking");
      const verified = await new NoNetworkFactVerifier(() => new Date(0)).verify(request, response);
      expect(verified.claims.map((claim) => claim.inventory_key)).toEqual(
        request.fact_inventory.map((item) => item.stable_key),
      );
      expect(verified.sources).toHaveLength(request.fact_inventory.length);
      expect(verified.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule_reference: "fact.advisory_unavailable" }),
          expect.objectContaining({ rule_reference: "facts.unverified" }),
          expect.objectContaining({ rule_reference: "facts.provenance_always_review" }),
        ]),
      );
    }
  });

  it("keeps non-200 and network Step 1.7 failures redacted and fatal without retries", async () => {
    const secret = "raw-secret-provider-detail";
    const httpFetcher = vi.fn(async () => new Response(secret, { status: 403 }));
    await expect(
      makeProvider(httpFetcher).review(validRequest("review_fact_checking")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewProviderError);
      expect((error as Error).message).not.toContain(secret);
      return true;
    });
    expect(httpFetcher).toHaveBeenCalledOnce();

    const networkFetcher = vi.fn(async () => {
      throw new Error(secret);
    });
    await expect(
      makeProvider(networkFetcher).review(validRequest("review_fact_checking")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewProviderError);
      expect((error as Error).message).not.toContain(secret);
      return true;
    });
    expect(networkFetcher).toHaveBeenCalledOnce();
  });

  it("rejects claims and sources the model returns for Step 1.8 through one correction", async () => {
    const body = {
      findings: [],
      sources: [
        {
          stable_key: "s",
          uri: "https://example.com",
          title: "t",
          snapshot: {},
          evidence: "e",
        },
      ],
      claims: [{ inventory_key: "x", status: "verified", source_key: "s" }],
    };
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(completion(wire(JSON.stringify(body))))
      .mockResolvedValueOnce(completion(wire(JSON.stringify({ findings: [] }))));
    const response = await makeProvider(fetcher).review(validRequest("review_link_conversion"));
    expect(response.claims).toEqual([]);
    expect(response.sources).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("ChatCompletionReviewProvider Step 1.8", () => {
  const linkFinding = (rule = "link.anchor_quality") => ({
    k: "link-anchor-lounge-chair",
    q: 1,
    r: rule,
    v: "warning",
    i: "The anchor ‘click here’ does not describe the lounge-chair destination.",
    x: "Use a descriptive anchor referring to the lounge chair.",
  });

  it("uses strict findings-only link.* output and one correction", async () => {
    const request = validRequest("review_link_conversion");
    request.link_review_context = {
      occurrences: [
        {
          anchor: "click here",
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          location: { field: "body_markdown", line_start: 3, section: "Choosing a chair" },
          context: "For dimensions, click here before choosing.",
        },
      ],
      shortlist: [
        {
          title: "Furniture guides",
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          hierarchy: "broad_category",
          hierarchy_rank: 5,
          relevance: 0.9,
        },
      ],
    };
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [linkFinding("style.anchor")] }))))
      .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [linkFinding()] }))));
    const response = await makeProvider(fetcher).review(request);
    expect(response.findings[0]?.rule_reference).toBe("link.anchor_quality");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body),
    );
    expect(body.response_format.json_schema).toMatchObject({
      name: "mobelaris_step_1_8_link_review",
      strict: true,
      schema: { additionalProperties: false, required: ["f"] },
    });
    const user = body.messages.at(-1).content as string;
    expect(user).toContain("occurrence 1; anchor: click here");
    expect(user).toContain("context: For dimensions");
    expect(user).toContain("title: Furniture guides");
    expect(user).toContain("rank: 5");
    expect(user).toContain("relevance: 0.9");
    expect(user).not.toMatch(/status:\s*200/);
    expect(user).not.toContain(request.draft.markdown);
    expect(user).not.toContain(request.handoff.notes);
    expect(user).not.toContain("Reference snapshot");
    expect(body.response_format.json_schema.schema.properties.f.items.required).toEqual([
      "k",
      "q",
      "r",
      "v",
      "i",
      "x",
    ]);
    expect(
      body.response_format.json_schema.schema.properties.f.items.properties,
    ).not.toHaveProperty("l");
  });

  it("corrects disallowed rules and unknown occurrence numbers once", async () => {
    const request = validRequest("review_link_conversion");
    request.link_review_context = {
      occurrences: [
        {
          anchor: "click here",
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          location: { field: "body_markdown", line_start: 3, section: "Choosing a chair" },
          context: "For dimensions, click here before choosing.",
        },
      ],
      shortlist: [
        {
          title: "Furniture guides",
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          relevance: 0.9,
        },
      ],
    };
    for (const invalid of [linkFinding("link.shortlist_membership"), { ...linkFinding(), q: 99 }]) {
      const fetcher = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [invalid] }))))
        .mockResolvedValueOnce(completion(wire(JSON.stringify({ f: [] }))));
      await expect(makeProvider(fetcher).review(request)).resolves.toMatchObject({ findings: [] });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
});

describe("review prompt contract", () => {
  it("instructs the exact Step 1.5 judgement scope and excludes Step 1.4 counts", () => {
    const messages = buildReviewMessages(validRequest());
    const system = messages[0]?.content ?? "";
    expect(messages[0]?.role).toBe("system");
    for (const area of [
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
    ])
      expect(system).toContain(area);
    expect(system).toContain("Step 1.4 already owns every countable rule");
    expect(system).toContain("Return zero findings when the draft passes");
    expect(system).toMatch(/never rewritten prose/);
    expect(system).toMatch(/British English/);
    expect(system).toContain("Every stable_key must be unique");
    expect(system).toContain("precise location");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("walnut dining tables");
    expect(user).toContain("# Walnut dining tables");
  });

  it("scopes Step 1.6 without over-reporting or borrowing other steps", () => {
    const request = validRequest("review_information_gain");
    const messages = buildReviewMessages(request);
    const system = messages[0]?.content ?? "";
    expect(system).toContain(
      "Information gain means useful detail beyond obvious or common guidance",
    );
    expect(system).toContain("Return zero findings");
    expect(system).toContain("Do not require novelty for necessary definitions");
    expect(system).toContain("no competitor corpus");
    expect(system).toContain("model knowledge");
    expect(system).toContain("Do not repeat Step 1.4");
    expect(system).toContain("Step 1.5 writing-style");
    expect(system).toContain("Step 1.7 fact verification");
    expect(system).toContain("Step 1.8 internal-link/conversion");
    expect(system).toContain("Avoid vague advice such as ‘add more detail’");
    expect(system).toContain("never present it as verified factual evidence");
    expect(system).toContain("precise location");
    expect(system).toContain("concrete supportable addition");
  });

  it("carries the fact inventory for fact-checking steps", () => {
    const messages = buildReviewMessages(validRequest("review_fact_checking"));
    expect(messages[0]?.content).toContain('"q": supplied inventory ID');
    expect(messages[0]?.content).not.toContain('"sources"');
    expect(messages[0]?.content).not.toContain('"status": "verified"');
    const user = messages[1]?.content ?? "";
    expect(user).toContain("inventory-aaa");
    expect(user).toContain("inventory-bbb");
    expect(user).toContain("attribution_provenance");
  });

  it("uses findings-only textual envelopes for Steps 1.5 and 1.6", () => {
    for (const step of ["review_writing_style", "review_information_gain"] as const) {
      const messages = buildReviewMessages(validRequest(step));
      const system = messages[0]?.content ?? "";
      expect(system).toContain('{ "f": [');
      expect(system).not.toContain('"sources":');
      expect(system).not.toContain('"claims":');
      expect(messages[1]?.content).toContain("Return only { f }");
    }
  });

  it("scopes Step 1.8 to anchor, context and conversion with explicit exclusions", () => {
    const system = buildReviewMessages(validRequest("review_link_conversion"))[0]?.content ?? "";
    expect(system).toContain("anchor-text quality");
    expect(system).toContain("contextual suitability");
    expect(system).toContain("conversion path rather than acting as decoration");
    expect(system).toContain("only after contextual suitability is established");
    expect(system).toContain("Never reject");
    expect(system).toContain("shortlist membership");
    expect(system).toContain("HTTP status");
    expect(system).toContain("commercial body-presence");
    expect(system).toContain("rule references beginning link.");
  });

  it("carries only bounded subjective content from the active mapped writing guide", () => {
    const request = validRequest();
    const subjective = `Mobelaris writes in a measured, knowledgeable tone. ${"x".repeat(6_000)}`;
    request.reference_snapshots = [
      {
        kind: "blog_writing_guide",
        version_id: "sg-2",
        content_hash: "a".repeat(64),
        immutable_pointer: "ref://style-guide/sg-2",
        content: `# Guide\n\n## Required writing approach\n\n${subjective}\n\n- Keep sentences readable for a Grade 8 target.\n\n## Required content structure\n\nOne H1 and 40–70 words.`,
      },
      {
        kind: "other-guide",
        version_id: "other-1",
        content_hash: "b".repeat(64),
        immutable_pointer: "ref://other/1",
        content: "PRIVATE UNMAPPED REFERENCE",
      },
    ];
    const user = buildReviewMessages(request)[1]?.content ?? "";
    expect(user).toContain("measured, knowledgeable tone");
    expect(user).not.toContain("Grade 8 target");
    expect(user).not.toContain("One H1 and 40–70 words");
    expect(user).not.toContain("PRIVATE UNMAPPED REFERENCE");
    expect(user).not.toContain(subjective);
    expect(user).not.toContain(request.handoff.notes);
    expect(user).not.toContain("Internal links provided");
  });
});

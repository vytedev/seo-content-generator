import { afterEach, describe, expect, it, vi } from "vitest";
import type { RevisionRequest } from "../src/shared/milestone-four.js";
import { RevisionResponseSchema } from "../src/shared/milestone-four.js";
import {
  ChatCompletionRevisionProvider,
  RevisionProviderError,
  buildRevisionMessages,
} from "../src/server/providers/chat-completion-revision-provider.js";
const TEST_MODEL = "provider/configured-model";
import type { StructuredDraft } from "../src/shared/milestone-two.js";
import { applyCompactRevisionPlan } from "../src/server/providers/compact-model-contracts.js";

const TOKEN = "openrouter_test_key_not_real";
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

function revisedDraft(): StructuredDraft {
  return {
    ...validDraft(),
    markdown: "# Walnut dining tables\n\nConsider your proportions before choosing a table.",
  };
}

function modelRevision(draft = revisedDraft()) {
  return {
    edits: [{ id: "finding-1", st: "applied", why: "Applied.", replacement: draft.markdown }],
  };
}

function validRequest(model = TEST_MODEL): RevisionRequest {
  return {
    operation_id: "revision-op-1",
    run_id: "run-1",
    document_version_id: "docver-1",
    revision: 1,
    handoff: {
      plane_ticket: "MOB-123",
      primary_keyword: "walnut dining tables",
      related_keywords: ["walnut table"],
      page_type: "blog",
      word_count_target: 1200,
      locales_for_translation: [],
      notes: "Focus on modern interiors",
    },
    current_document: validDraft(),
    internal_links: [
      {
        url: "https://www.mobelaris.com/blogs/furniture-guides",
        title: "Furniture guides",
        relevance: 0.9,
      },
    ],
    accepted_findings: [
      {
        stable_key: "wording-space",
        category: "style",
        rule_reference: "style.clarity",
        severity: "warning",
        location: { field: "body_markdown", section: "introduction" },
        issue: "The sentence is vague about what to consider.",
        suggested_fix: "Name the proportions of the room explicitly.",
        id: "finding-1",
        disposition: "accepted",
        origin_document_version_id: "docver-1",
      },
    ],
    reference_snapshots: [],
    prompt: { template_id: "mobelaris.revision_pass", template_version: "1.0.0" },
    model,
    temperature: 0.2,
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
  return {
    id: "openrouter-chatcmpl-test",
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  };
}

function makeProvider(fetcher: typeof fetch) {
  return new ChatCompletionRevisionProvider({
    token: TOKEN,
    model: TEST_MODEL,
    fetcher,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatCompletionRevisionProvider construction", () => {
  it("throws a clear typed error when the token is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    expect(() => new ChatCompletionRevisionProvider()).toThrow(RevisionProviderError);
    expect(() => new ChatCompletionRevisionProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("pins the default model and records it in provider identity", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    const provider = makeProvider(vi.fn());
    expect(provider.provider).toBe("openrouter");
    expect(provider.model).toBe(TEST_MODEL);
  });
});

describe("ChatCompletionRevisionProvider.revise", () => {
  it("fails a truncated HTTP 200 closed without a corrective request", async () => {
    const fetcher = vi.fn(async () =>
      completion({
        choices: [{ message: { content: '{"edits":[' }, finish_reason: "length" }],
      }),
    );
    const response = await makeProvider(fetcher).revise(validRequest());
    expect(response.document).toEqual(validDraft());
    expect(response.finding_results).toEqual([
      {
        finding_id: "finding-1",
        status: "unable",
        reason: "The model response could not be used safely.",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("parses a valid revised draft and maps usage", async () => {
    const draft = revisedDraft();
    const fetcher = vi.fn(async () =>
      completion(
        wire(JSON.stringify(modelRevision(draft)), { prompt_tokens: 61, completion_tokens: 131 }),
      ),
    );
    const response = await makeProvider(fetcher).revise(validRequest());
    expect(() => RevisionResponseSchema.parse(response)).not.toThrow();
    expect(response.document).toEqual(draft);
    expect(response.usage).toEqual({
      input_units: 61,
      output_units: 131,
      cost_micros: 0,
      latency_ms: expect.any(Number),
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const requestBody = JSON.parse(init.body);
    expect(requestBody.model).toBe(TEST_MODEL);
    expect(requestBody.reasoning).toEqual({ effort: "none", exclude: true });
  });

  it("restores unauthorised structured-field drift and server-owned claims", async () => {
    const { claims: _claims, ...editableDraft } = revisedDraft();
    const modelDraft = {
      ...editableDraft,
      og_description: "Unauthorised model change",
      images: [
        {
          alt: "Unauthorised alt text",
          filename: "unauthorised.jpg",
          placement: { marker: "walnut-table" },
        },
      ],
      faqs: [{ question: "Unauthorised question?", answer: "Unauthorised answer." }],
    };
    const fetcher = vi.fn(async () =>
      completion(
        wire(JSON.stringify(modelRevision({ ...modelDraft, claims: validDraft().claims }))),
      ),
    );
    const request = validRequest();
    const response = await makeProvider(fetcher).revise(request);
    expect(response.document.markdown).toBe(modelDraft.markdown);
    expect(response.document.og_description).toBe(request.current_document.og_description);
    expect(response.document.images).toEqual(request.current_document.images);
    expect(response.document.faqs).toEqual(request.current_document.faqs);
    expect(response.document.claims).toEqual(request.current_document.claims);
  });

  it.each([
    ["fenced JSON", "```json\n" + JSON.stringify(modelRevision()) + "\n```"],
    ["extra prose", "here is some prose instead"],
    ["invalid JSON", "{ definitely not json"],
    [
      "unknown document payload",
      JSON.stringify({ ...modelRevision(), document: { claims: ["secret"] } }),
    ],
    [
      "reordered IDs",
      JSON.stringify({
        edits: [
          { id: "unknown", st: "unable", why: "No.", replacement: null },
          { id: "finding-1", st: "unable", why: "No.", replacement: null },
        ],
      }),
    ],
  ])(
    "discards malicious or unusable HTTP 200 %s with zero corrective requests",
    async (_, body) => {
      const fetcher = vi.fn(async () => completion(wire(body)));
      const response = await makeProvider(fetcher).revise(validRequest());
      expect(response.document).toEqual(validDraft());
      expect(response.finding_results.every((result) => result.status === "unable")).toBe(true);
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts null replacement for unable and narrowly normalises equivalent keys", async () => {
    const fetcher = vi.fn(async () =>
      completion(
        wire(
          JSON.stringify({
            results: [
              {
                finding_id: "finding-1",
                status: "cannot_apply",
                reason: "Target cannot be changed safely.",
                replacement: null,
              },
            ],
          }),
        ),
      ),
    );
    const response = await makeProvider(fetcher).revise(validRequest());
    expect(response.finding_results).toEqual([
      {
        finding_id: "finding-1",
        status: "unable",
        reason: "Target cannot be changed safely.",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("makes no second model request after a 500", async () => {
    const fetcher = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    await expect(makeProvider(fetcher).revise(validRequest())).rejects.toMatchObject({
      category: "transient_exhausted",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a redacted timeout error", async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(makeProvider(fetcher).revise(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(RevisionProviderError);
        expect((error as RevisionProviderError).code).toBe("REVISION_PROVIDER_TIMEOUT");
        expect((error as RevisionProviderError).message).not.toContain(TOKEN);
        return true;
      },
    );
  });

  it.each([400, 401, 403, 404])(
    "makes one request and no corrective call for configuration HTTP %s",
    async (status) => {
      const fetcher = vi.fn(async () => new Response("configuration failure", { status }));
      await expect(makeProvider(fetcher).revise(validRequest())).rejects.toMatchObject({
        category: "configuration",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("gives a clear billing message for a 402, not a raw status code", async () => {
    const fetcher = vi.fn(async () => new Response("payment required", { status: 402 }));
    await expect(makeProvider(fetcher).revise(validRequest())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(RevisionProviderError);
        expect((error as RevisionProviderError).code).toBe("REVISION_PROVIDER_HTTP_STATUS");
        expect((error as RevisionProviderError).message).toBe(
          "Revision provider account has no billing configured for model usage",
        );
        expect((error as RevisionProviderError).message).not.toMatch(/HTTP 402/);
        return true;
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a request whose model does not match the pinned model", async () => {
    const fetcher = vi.fn();
    await expect(makeProvider(fetcher).revise(validRequest("other/model"))).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(RevisionProviderError);
        expect((error as RevisionProviderError).code).toBe("REVISION_PROVIDER_MODEL_MISMATCH");
        return true;
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("revision prompt contract", () => {
  it("instructs a controlled edit, carries the findings and the current document", () => {
    const messages = buildRevisionMessages(validRequest());
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toMatch(/Apply ONLY the accepted findings/);
    expect(messages[0]?.content).toMatch(/never rewrite/i);
    expect(messages[0]?.content).toMatch(/primary keyword/i);
    expect(messages[0]?.content).toMatch(/British English/);
    expect(messages[0]?.content).toContain("meta_description");
    expect(messages[0]?.content).toContain("Open Graph field");
    expect(messages[0]?.content).toMatch(/Claims are server-owned/);
    expect(messages[0]?.content).toMatch(/Do not emit claims/);
    expect(messages[0]?.content).toContain("replacement=null");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("walnut dining tables");
    expect(user).toContain('"id":"finding-1"');
    expect(user).toContain('"location":{"field":"body_markdown","section":"introduction"}');
    expect(user).toContain("style.clarity");
    expect(user).toContain("Name the proportions of the room explicitly.");
    expect(user).toContain("# Walnut dining tables");
    expect(user).not.toContain('"document"');
    expect(user).not.toContain("Solid walnut is a hardwood");
    expect(user).not.toContain('"claims"');
    expect(user).toContain("https://www.mobelaris.com/blogs/furniture-guides");
    for (const requirement of [
      "55–60 characters",
      "150–155 characters",
      "40–70 word direct answer",
      "## Key Takeaways",
      "1–3 Markdown blockquote",
      "## Conclusion",
      "3–6 structured FAQ",
      "Flesch-Kincaid Grade 8",
      "use only these internal URLs",
    ])
      expect(user).toContain(requirement);
  });
});

/**
 * Multi-block readability authority reuses the existing compact contract: the
 * application issues one row per authorised block, so ID discipline and
 * reverse-order application are already enforced. These pin that the expanded
 * ID set does not weaken any of it.
 */
describe("application-issued readability block IDs", () => {
  const markdown = [
    "# Guide", // 1
    "", // 2
    "Direct answer prose.", // 3
    "", // 4
    "## Section", // 5
    "", // 6
    "First hard paragraph.", // 7
    "", // 8
    "Untouched middle paragraph.", // 9
    "", // 10
    "Second hard paragraph.", // 11
  ].join("\n");

  function blockRequest(): RevisionRequest {
    const base = validRequest();
    return {
      ...base,
      current_document: { ...base.current_document, markdown },
      accepted_findings: [7, 11].map((line, index) => ({
        ...base.accepted_findings[0]!,
        id: `finding-1::rb${index + 1}`,
        rule_reference: "style.readability_grade_8",
        severity: "blocker" as const,
        location: { field: "body_markdown", line_start: line, line_end: line },
      })),
    };
  }

  const plan = (edits: Array<Record<string, unknown>>) => ({ edits });

  it("sends only issued block IDs and their bounded source text", () => {
    const messages = buildRevisionMessages(blockRequest());
    const body = messages.map((message) => message.content).join("\n");
    expect(body).toContain("finding-1::rb1");
    expect(body).toContain("finding-1::rb2");
    expect(body).toContain("First hard paragraph.");
    expect(body).toContain("Second hard paragraph.");
    // Prose no block authorises is never offered as an editable target.
    const targets = /"current":\s*"Untouched middle paragraph\."/.test(body);
    expect(targets).toBe(false);
  });

  it("applies several non-contiguous replacements without corrupting coordinates", () => {
    const result = applyCompactRevisionPlan(
      blockRequest(),
      plan([
        { id: "finding-1::rb1", st: "applied", why: "Simplified.", replacement: "Short one." },
        { id: "finding-1::rb2", st: "applied", why: "Simplified.", replacement: "Short two." },
      ]),
    );
    expect(result.document.markdown.split("\n")).toEqual([
      "# Guide",
      "",
      "Direct answer prose.",
      "",
      "## Section",
      "",
      "Short one.",
      "",
      "Untouched middle paragraph.",
      "",
      "Short two.",
    ]);
    expect(result.finding_results.map((row) => row.status)).toEqual(["applied", "applied"]);
  });

  it("fails closed on an unknown block ID", () => {
    expect(() =>
      applyCompactRevisionPlan(
        blockRequest(),
        plan([
          { id: "finding-1::rb1", st: "applied", why: "ok", replacement: "Short one." },
          { id: "finding-1::rb9", st: "applied", why: "ok", replacement: "Short two." },
        ]),
      ),
    ).toThrow(/does not cover accepted findings in order/);
  });

  it("fails closed on a duplicate block ID", () => {
    expect(() =>
      applyCompactRevisionPlan(
        blockRequest(),
        plan([
          { id: "finding-1::rb1", st: "applied", why: "ok", replacement: "Short one." },
          { id: "finding-1::rb1", st: "applied", why: "ok", replacement: "Short two." },
        ]),
      ),
    ).toThrow(/does not cover accepted findings in order/);
  });

  it("fails closed on a missing block ID", () => {
    expect(() =>
      applyCompactRevisionPlan(
        blockRequest(),
        plan([{ id: "finding-1::rb1", st: "applied", why: "ok", replacement: "Short one." }]),
      ),
    ).toThrow(/does not cover accepted findings in order/);
  });

  it("fails closed on reordered block IDs", () => {
    expect(() =>
      applyCompactRevisionPlan(
        blockRequest(),
        plan([
          { id: "finding-1::rb2", st: "applied", why: "ok", replacement: "Short two." },
          { id: "finding-1::rb1", st: "applied", why: "ok", replacement: "Short one." },
        ]),
      ),
    ).toThrow(/does not cover accepted findings in order/);
  });

  it("never lets a replacement reach prose outside its issued block", () => {
    const result = applyCompactRevisionPlan(
      blockRequest(),
      plan([
        {
          id: "finding-1::rb1",
          st: "applied",
          why: "ok",
          // Even a multi-line replacement only ever replaces its own block.
          replacement: "Short one.\n\nSmuggled extra paragraph.",
        },
        { id: "finding-1::rb2", st: "unable", why: "Left alone.", replacement: null },
      ]),
    );
    expect(result.document.markdown).toContain("Untouched middle paragraph.");
    expect(result.document.markdown).toContain("Second hard paragraph.");
    // The smuggled text lands inside the authorised block's own range, where the
    // envelope's hunk ownership still governs it.
    expect(result.document.markdown.indexOf("Smuggled extra paragraph.")).toBeLessThan(
      result.document.markdown.indexOf("Untouched middle paragraph."),
    );
  });
});

import {
  DraftProviderRequestSchema,
  DraftProviderResponseSchema,
  type DraftProviderRequest,
  type DraftProviderResponse,
  type StructuredDraft,
} from "../../shared/milestone-two.js";
import { hashIdempotencyInput } from "../../shared/worker-contracts.js";
import type { DraftProvider } from "./contracts.js";

const fitCharacters = (value: string, minimum: number, maximum: number, fill: string) =>
  value.length >= minimum ? value.slice(0, maximum) : value.padEnd(minimum, fill).slice(0, minimum);

const fortyWordAnswer = (topic: string) =>
  `Start with ${topic} and the needs of your room. Check the size, shape, comfort and finish. Compare each choice in good light. Take time before you buy. A clear plan helps you choose a piece that suits daily life well.`;

/** A checker-compliant local draft used to prove the complete mock pipeline without model calls. */
export function buildMockDraft(request: DraftProviderRequest): StructuredDraft {
  const keyword = request.handoff.primary_keyword;
  const related = request.handoff.related_keywords.join(" and ");
  const link = request.internal_links[0];
  const title = fitCharacters(`${keyword} guide for a calm, modern home`, 55, 60, "x");
  const metaDescription = fitCharacters(
    `Explore ${keyword} with clear tips on size, comfort, style and room planning. Learn what to check before choosing a design that suits your home.`,
    150,
    155,
    "x",
  );
  const bodyLink = link
    ? `See [${link.title}](${link.url}) for more ideas that can help you compare a suitable choice.`
    : "Use the supplied shortlist to compare a suitable choice before you buy.";
  return {
    title,
    // The real draft contract requires a distinct 55-60 character meta title, so
    // the mock emits one too: without it every freshly generated draft would be
    // reported as carrying a legacy derived field.
    meta_title: title,
    slug: keyword
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, ""),
    meta_description: metaDescription,
    og_title: title,
    og_description: metaDescription,
    images: [
      {
        alt: `${keyword} in a modern room`,
        filename: `${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`,
        placement: { marker: "hero-image" },
      },
    ],
    faqs: [
      { question: `How do I choose ${keyword}?`, answer: fortyWordAnswer(keyword) },
      { question: `How should I plan the room?`, answer: fortyWordAnswer("the space") },
      { question: `What should I check before buying?`, answer: fortyWordAnswer("your shortlist") },
    ],
    markdown: [
      `# ${keyword} guide`,
      "",
      `${keyword} can work well when its size, comfort and look suit your room. Start with the space you have. Think about how you use it each day. Then compare simple details and choose a design that feels right for your home and routine.`,
      "",
      "## Key Takeaways",
      `- Match ${keyword} to the size and use of your room.`,
      "- Check comfort, shape and finish before you choose.",
      "- Compare useful options with a clear plan.",
      "",
      "<!-- MOBELARIS_IMAGE:hero-image -->",
      "",
      `## How ${keyword} fits your room`,
      `Think about ${related} as you plan each part of the room. Keep paths clear and leave enough space for daily use. ${bodyLink}`,
      "",
      `> Tip: measure the room and note the main paths before you compare each ${keyword}.`,
      "",
      "## Conclusion",
      `${keyword} is easier to choose when size, comfort and style match your room. Use a short list, compare each option and pick the design that best supports daily life.`,
    ].join("\n"),
    claims: [],
  };
}

/** Server-only deterministic provider. No network or model invocation occurs. */
export class MockDraftProvider implements DraftProvider {
  readonly provider = "mock";
  readonly calls: DraftProviderRequest[] = [];

  constructor(
    readonly model: string,
    private readonly output?: StructuredDraft,
  ) {
    if (!model.trim()) throw new Error("A pinned model identifier is required");
  }

  async generate(input: DraftProviderRequest): Promise<DraftProviderResponse> {
    const request = DraftProviderRequestSchema.parse(input);
    if (request.model !== this.model)
      throw new Error("Draft request model does not match pinned provider model");
    this.calls.push(request);
    const draft = this.output ?? buildMockDraft(request);
    return DraftProviderResponseSchema.parse({
      request_id: `request_${hashIdempotencyInput(request)}`,
      draft,
      usage: {
        input_units: JSON.stringify(request).length,
        output_units: JSON.stringify(draft).length,
        cost_micros: 0,
      },
    });
  }
}

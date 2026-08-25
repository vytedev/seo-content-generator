import { describe, expect, it } from "vitest";
import {
  assertEditoriallyExportable,
  hasDanglingTitleEnding,
  shortenTitleAtWordBoundary,
  suspiciousFaqPairIndexes,
  unicodeLength,
} from "../src/shared/editorial-integrity.js";
import { StructuredDraftSchema, type StructuredDraft } from "../src/shared/milestone-two.js";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  renderExport,
} from "../src/shared/export.js";

const alignedFaqs = [
  {
    question: "What is the ideal seat height for designer dining chairs?",
    answer:
      "The ideal seat height for most designer dining chairs is between 45 and 48 centimetres from the floor.",
  },
  {
    question: "How much space should I allow for pulling a chair out?",
    answer:
      "Allow at least 30 centimetres of clearance so you can pull the chair out and slide it back easily.",
  },
  {
    question: "Can I mix modern dining chairs with a traditional wooden table?",
    answer:
      "Yes, mixing a modern dining chair with a traditional wooden table can create a balanced contrast.",
  },
  {
    question: "Are upholstered chairs suitable for everyday use?",
    answer:
      "Upholstered chairs are practical for everyday use when their fabric is durable and easy to clean.",
  },
];

const rotatedFaqs = alignedFaqs.map((faq, index) => ({
  question: faq.question,
  answer: alignedFaqs[(index + 2) % alignedFaqs.length]!.answer,
}));

function draft(overrides: Partial<StructuredDraft> = {}): StructuredDraft {
  return StructuredDraftSchema.parse({
    title: "Choosing Designer Dining Chairs: A Practical UK Home Guide",
    meta_title: "Designer Dining Chairs: A Practical UK Buying Guide",
    slug: "designer-dining-chairs-guide",
    meta_description: "A practical UK guide to designer dining chairs.",
    og_title: "Designer Dining Chairs for Contemporary UK Homes",
    og_description: "Choose proportions, materials and finishes for a comfortable dining room.",
    images: [],
    faqs: alignedFaqs,
    markdown: "# Designer dining chairs\n\nChoose chairs that suit the table and room.",
    claims: [],
    ...overrides,
  });
}

function render(current: StructuredDraft) {
  return renderExport({
    plane_ticket: "MM03-TEST-005",
    draft: current,
    primary_keyword: "designer dining chairs",
    related_keywords: ["modern dining chairs"],
    page_type: "blog",
    locales_for_translation: [],
    export_date: "2026-08-24",
    writer_template: DEFAULT_WRITER_TEMPLATE,
    schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
  });
}

describe("editorial export integrity", () => {
  it("counts Unicode code points and treats non-breaking spaces as word boundaries", () => {
    expect(unicodeLength("Chair\u00a0guide — 🪑")).toBe(15);
    expect(shortenTitleAtWordBoundary("Oak\u00a0chairs for compact homes", 16)).toBe(
      "Oak\u00a0chairs",
    );
  });

  it("preserves complete titles at the limit and removes partial or dangling endings", () => {
    const exact = "A complete chair title".padEnd(60, "x");
    expect(shortenTitleAtWordBoundary(exact, 60)).toBe(exact);
    expect(
      shortenTitleAtWordBoundary(
        "Choosing Designer Dining Chairs: A Practical UK Guide for Homes",
        60,
      ),
    ).toBe("Choosing Designer Dining Chairs: A Practical UK Guide");
    expect(hasDanglingTitleEnding("Choosing chairs: a UK guide for…")).toBe(true);
    expect(hasDanglingTitleEnding("Choosing chairs: a UK home guide.")).toBe(false);
  });

  it("detects the observed complete-answer rotation without changing any pair", () => {
    const before = structuredClone(rotatedFaqs);
    expect(suspiciousFaqPairIndexes(rotatedFaqs, "designer dining chairs")).toEqual([0, 2, 3]);
    expect(rotatedFaqs).toEqual(before);
    expect(suspiciousFaqPairIndexes(alignedFaqs, "designer dining chairs")).toEqual([]);
  });

  it("blocks rotated FAQs and dangling titles before canonical rendering", () => {
    expect(() =>
      assertEditoriallyExportable(draft({ faqs: rotatedFaqs }), "designer dining chairs"),
    ).toThrow("FAQ pair integrity");
    expect(() => render(draft({ faqs: rotatedFaqs }))).toThrow("FAQ pair integrity");
    expect(() =>
      render(draft({ meta_title: "Designer Dining Chairs: A Practical UK Guide for" })),
    ).toThrow("Title integrity");
  });

  it("keeps document, meta and OG titles independent and exports FAQ pairs atomically", () => {
    const current = draft();
    const result = render(current);
    expect(result.title).toBe(current.title);
    expect(result.markdown).toContain(`- H1: ${current.title}`);
    expect(result.markdown).toContain(`- Meta title: ${current.meta_title}`);
    expect(result.markdown).toContain(`- OG title: ${current.og_title}`);
    for (const faq of current.faqs)
      expect(result.markdown).toContain(`### ${faq.question}\n\n${faq.answer}\n`);
  });

  it("rejects empty FAQ members at the strict draft boundary", () => {
    const current = draft();
    expect(
      StructuredDraftSchema.safeParse({
        ...current,
        faqs: [{ question: " ", answer: "An answer." }],
      }).success,
    ).toBe(false);
    expect(
      StructuredDraftSchema.safeParse({
        ...current,
        faqs: [{ question: "A question?", answer: " " }],
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  calculateReadabilityGrade,
  CheckerInputSchema,
  FindingSchema,
  runDeterministicChecks,
  type CheckerInput,
} from "../src/shared/checker/index.js";

const words = (count: number, word = "plain") =>
  Array.from({ length: count }, () => word).join(" ");
const metaTitle = "ergonomic chairs".padEnd(55, " x").slice(0, 55);
const metaDescription = "ergonomic chairs".padEnd(150, " useful details").slice(0, 150);
const faqAnswer = words(40);

function validInput(): CheckerInput {
  return {
    primary_keyword: "ergonomic chairs",
    related_keywords: ["desk seating", "back support"],
    body_markdown: [
      "# Choosing ergonomic chairs for a calm home office",
      "",
      `Ergonomic chairs help you sit with steady support while you work. ${words(31)}`,
      "",
      "## Key Takeaways",
      "- Choose a chair that suits your desk seating needs.",
      "- Test the controls before you settle into daily work.",
      "- Look for back support that feels steady through the day.",
      "",
      "## How ergonomic chairs support focused work",
      "Simple controls can help you change your position. [Browse suitable chairs](https://mobelaris.test/chairs) before choosing.",
      "",
      "> Tip: measure your desk before comparing each chair.",
      "",
      "## Conclusion",
      "Ergonomic chairs work best when desk seating, adjustment and back support suit the person and workspace.",
    ].join("\n"),
    on_page: {
      meta_title: metaTitle,
      meta_description: metaDescription,
      og_title: "Ergonomic chairs for focused work",
      og_description: "A practical guide to choosing a supportive chair.",
      slug: "ergonomic-chairs",
      images: [{ alt: "An ergonomic chair beside a desk", filename: "ergonomic-chair-desk.jpg" }],
      faqs: [
        { question: "How should a chair fit?", answer: faqAnswer },
        { question: "Which controls matter?", answer: faqAnswer },
        { question: "How often should I move?", answer: faqAnswer },
      ],
    },
    internal_origins: ["https://mobelaris.test"],
    verified_internal_links: [
      {
        url: "https://mobelaris.test/chairs",
        status: 200,
        hierarchy: "collection",
        hierarchy_rank: 1,
      },
    ],
  };
}

const rules = (input: CheckerInput) => runDeterministicChecks(input).map((item) => item.rule);

describe("checker contracts and deterministic findings", () => {
  it("strictly validates boundary shape, URLs, keywords and unknown keys", () => {
    expect(CheckerInputSchema.parse(validInput())).toEqual(validInput());
    expect(CheckerInputSchema.safeParse({ ...validInput(), extra: true }).success).toBe(false);
    expect(CheckerInputSchema.safeParse({ ...validInput(), related_keywords: [] }).success).toBe(
      false,
    );
    expect(
      CheckerInputSchema.safeParse({ ...validInput(), related_keywords: ["Desk", "desk"] }).success,
    ).toBe(false);
    expect(
      CheckerInputSchema.safeParse({
        ...validInput(),
        verified_internal_links: [
          { url: "not a url", status: 200, hierarchy: "collection", hierarchy_rank: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it("emits schema-valid findings with stable deterministic IDs", () => {
    const first = runDeterministicChecks(validInput());
    const second = runDeterministicChecks(validInput());
    expect(first).toEqual(second);
    expect(first.every((item) => FindingSchema.safeParse(item).success)).toBe(true);
    expect(first).toEqual([]);
  });

  it("checks inclusive metadata character boundaries", () => {
    for (const length of [55, 60]) {
      const input = validInput();
      input.on_page.meta_title = `ergonomic chairs${"x".repeat(length)}`.slice(0, length);
      expect(rules(input)).not.toContain("on_page.meta_title.length");
    }
    for (const length of [54, 61]) {
      const input = validInput();
      input.on_page.meta_title = `ergonomic chairs${"x".repeat(length)}`.slice(0, length);
      expect(rules(input)).toContain("on_page.meta_title.length");
    }
    for (const length of [150, 155]) {
      const input = validInput();
      input.on_page.meta_description = "x".repeat(length);
      expect(rules(input)).not.toContain("on_page.meta_description.length");
    }
    for (const length of [149, 156]) {
      const input = validInput();
      input.on_page.meta_description = "x".repeat(length);
      expect(rules(input)).toContain("on_page.meta_description.length");
    }
  });

  it("rejects conflicting keywords, invalid origins, duplicate shortlist URLs and hierarchy ranks", () => {
    expect(
      CheckerInputSchema.safeParse({
        ...validInput(),
        related_keywords: ["ergonomic chairs", "back support"],
      }).success,
    ).toBe(false);
    expect(CheckerInputSchema.safeParse({ ...validInput(), internal_origins: [] }).success).toBe(
      false,
    );
    expect(
      CheckerInputSchema.safeParse({ ...validInput(), internal_origins: ["ftp://mobelaris.test"] })
        .success,
    ).toBe(false);
    expect(
      CheckerInputSchema.safeParse({
        ...validInput(),
        internal_origins: ["https://mobelaris.test/path"],
      }).success,
    ).toBe(false);

    const duplicate = validInput();
    duplicate.verified_internal_links.push({
      ...duplicate.verified_internal_links[0]!,
      url: "https://MOBELARIS.test/chairs/#fragment",
    });
    expect(CheckerInputSchema.safeParse(duplicate).success).toBe(false);

    const hierarchy = validInput();
    hierarchy.verified_internal_links[0]!.hierarchy_rank = 2;
    expect(CheckerInputSchema.safeParse(hierarchy).success).toBe(false);

    const unapproved = validInput();
    unapproved.verified_internal_links[0]!.url = "https://other.test/chairs";
    expect(CheckerInputSchema.safeParse(unapproved).success).toBe(false);
  });

  it("requires exactly one keyword-bearing H1 and catches initial or later skipped levels", () => {
    const noH1 = validInput();
    noH1.body_markdown = noH1.body_markdown.replace(
      "# Choosing ergonomic chairs",
      "## Choosing chairs",
    );
    expect(rules(noH1)).toContain("structure.heading_levels");
    expect(rules(noH1)).toEqual(
      expect.arrayContaining(["structure.single_h1", "keyword.primary.h1"]),
    );

    const extra = validInput();
    extra.body_markdown += "\n# Another ergonomic chairs title\n#### Skipped";
    expect(rules(extra)).toEqual(
      expect.arrayContaining(["structure.single_h1", "structure.heading_levels"]),
    );
  });

  it("requires the direct answer immediately after H1 and an exact Key Takeaways heading", () => {
    const interrupted = validInput();
    interrupted.body_markdown = interrupted.body_markdown.replace(
      "\n\nErgonomic chairs help",
      "\n\n## Intro\nErgonomic chairs help",
    );
    expect(rules(interrupted)).toContain("structure.direct_answer");

    const looseTitle = validInput();
    looseTitle.body_markdown = looseTitle.body_markdown.replace(
      "## Key Takeaways",
      "## My Key Takeaways",
    );
    expect(rules(looseTitle)).toContain("structure.key_takeaways");
  });

  it("checks direct answer boundaries and key takeaway bullet boundaries", () => {
    for (const count of [40, 70]) {
      const input = validInput();
      input.body_markdown = input.body_markdown.replace(
        /Ergonomic chairs help[^\n]+/,
        `ergonomic chairs ${words(count - 2)}`,
      );
      expect(rules(input)).not.toContain("structure.direct_answer");
    }
    for (const count of [39, 71]) {
      const input = validInput();
      input.body_markdown = input.body_markdown.replace(
        /Ergonomic chairs help[^\n]+/,
        `ergonomic chairs ${words(count - 2)}`,
      );
      expect(rules(input)).toContain("structure.direct_answer");
    }
    for (const count of [3, 5]) {
      const input = validInput();
      const bullets = Array.from(
        { length: count },
        (_, index) => `- desk seating and back support ${index}`,
      ).join("\n");
      input.body_markdown = input.body_markdown.replace(
        /- Choose[^\n]+\n- Test[^\n]+\n- Look[^\n]+/,
        bullets,
      );
      expect(rules(input)).not.toContain("structure.key_takeaways");
    }
    for (const count of [2, 6]) {
      const input = validInput();
      const bullets = Array.from(
        { length: count },
        (_, index) => `- desk seating and back support ${index}`,
      ).join("\n");
      input.body_markdown = input.body_markdown.replace(
        /- Choose[^\n]+\n- Test[^\n]+\n- Look[^\n]+/,
        bullets,
      );
      expect(rules(input)).toContain("structure.key_takeaways");
    }
  });

  it("checks FAQ count and answer word boundaries", () => {
    for (const count of [3, 6]) {
      const input = validInput();
      input.on_page.faqs = Array.from({ length: count }, (_, index) => ({
        question: `Question ${index}?`,
        answer: words(40),
      }));
      expect(rules(input)).not.toContain("structure.faq_count");
    }
    for (const count of [2, 7]) {
      const input = validInput();
      input.on_page.faqs = Array.from({ length: count }, (_, index) => ({
        question: `Question ${index}?`,
        answer: words(40),
      }));
      expect(rules(input)).toContain("structure.faq_count");
    }
    for (const count of [40, 80]) {
      const input = validInput();
      input.on_page.faqs[0]!.answer = words(count);
      expect(rules(input)).not.toContain("structure.faq_answer_length");
    }
    for (const count of [39, 81]) {
      const input = validInput();
      input.on_page.faqs[0]!.answer = words(count);
      expect(rules(input)).toContain("structure.faq_answer_length");
    }
  });

  it("checks one to three Markdown callouts", () => {
    for (const count of [1, 3]) {
      const input = validInput();
      input.body_markdown = input.body_markdown.replace(
        /> Tip[^\n]+/,
        Array.from({ length: count }, (_, index) => `> Tip ${index}`).join("\n\n"),
      );
      expect(rules(input)).not.toContain("structure.callouts");
    }
    for (const count of [0, 4]) {
      const input = validInput();
      input.body_markdown = input.body_markdown.replace(
        /> Tip[^\n]+/,
        Array.from({ length: count }, (_, index) => `> Tip ${index}`).join("\n\n"),
      );
      expect(rules(input)).toContain("structure.callouts");
    }
  });

  it("uses an inclusive Grade 8 readability boundary", () => {
    expect(8).toBeLessThanOrEqual(8);
    expect(
      calculateReadabilityGrade("Simple words help. They make ideas clear."),
    ).toBeLessThanOrEqual(8);
  });

  it("flags Grade 8+ prose but accepts simple prose", () => {
    const hard = validInput();
    hard.body_markdown = hard.body_markdown.replaceAll(
      "plain",
      "institutionalisation characteristically necessitates multidimensional conceptualisation",
    );
    expect(rules(hard)).toContain("style.readability_grade_8");
    expect(rules(validInput())).not.toContain("style.readability_grade_8");
  });

  it("uses clearly provisional British, vague-heading and banned-phrase subsets", () => {
    const input = validInput();
    input.body_markdown += "\n## Final Thoughts\nOur favorite color is guaranteed to work.";
    const findings = runDeterministicChecks(input);
    for (const rule of [
      "style.british_english_provisional",
      "style.vague_heading_provisional",
      "style.banned_phrase_provisional",
    ]) {
      expect(findings.find((item) => item.rule === rule)?.provisional).toBe(true);
    }
    expect(findings.find((item) => item.rule === "style.repeated_adjective")).toBeUndefined();
  });

  it("warns at the approved repeated-adjective boundary without counting headings, quotes or keywords", () => {
    const below = validInput();
    below.body_markdown +=
      "\n\nThis elegant table feels elegant in a compact room. An elegant finish suits it.";
    expect(rules(below)).not.toContain("style.repeated_adjective");

    const boundary = validInput();
    boundary.body_markdown +=
      "\n\nThis elegant table feels elegant in a compact room. An elegant finish keeps the elegant design measured.";
    const findings = runDeterministicChecks(boundary).filter(
      (item) => item.rule === "style.repeated_adjective",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        issue: expect.stringContaining("appears 4 times"),
      }),
    ]);

    const excluded = validInput();
    excluded.related_keywords.push("elegant furniture");
    excluded.body_markdown += [
      "",
      "## Elegant furniture for elegant rooms",
      "> Elegant furniture can make elegant rooms easier to plan.",
      "",
      "Elegant furniture works when the proportions fit. Elegant furniture should still serve the room.",
    ].join("\n");
    expect(
      runDeterministicChecks(excluded).filter(
        (item) => item.rule === "style.repeated_adjective" && item.issue.includes("elegant"),
      ),
    ).toEqual([]);
  });

  it("checks every exact primary placement case-insensitively with phrase boundaries", () => {
    const input = validInput();
    input.on_page.meta_title = "A useful title".padEnd(55, "x");
    input.body_markdown = input.body_markdown
      .replace("# Choosing ergonomic chairs", "# Choosing office chairs")
      .replace("Ergonomic chairs help", "Office seats help")
      .replace("## How ergonomic chairs", "## How office chairs")
      .replace("Ergonomic chairs work best", "Office chairs work best");
    expect(rules(input)).toEqual(
      expect.arrayContaining([
        "keyword.primary.meta_title",
        "keyword.primary.h1",
        "keyword.primary.first_100_words",
        "keyword.primary.h2",
      ]),
    );

    const embedded = validInput();
    embedded.on_page.meta_title = "superergonomic chairsplus".padEnd(55, "x");
    expect(rules(embedded)).toContain("keyword.primary.meta_title");
  });

  it("requires related keywords in prose within meaningful headed sections", () => {
    const input = validInput();
    input.body_markdown = input.body_markdown.replaceAll("back support", "support");
    input.body_markdown += "\n## Back support";
    expect(rules(input)).toContain("keyword.related.meaningful_section");
    input.body_markdown += "\nNatural back support can help while working.";
    expect(rules(input)).not.toContain("keyword.related.meaningful_section");
  });

  it("uses a provisional non-numeric exact-phrase concentration heuristic", () => {
    const input = validInput();
    input.body_markdown +=
      "\n## Detail\nErgonomic chairs suit work; ergonomic chairs can also suit study.";
    expect(runDeterministicChecks(input)).toContainEqual(
      expect.objectContaining({
        rule: "keyword.concentration_provisional",
        severity: "warning",
        provisional: true,
      }),
    );
  });

  it("does not accept a conclusion-only or callout-only commercial link", () => {
    for (const section of ["Conclusion", "Key Takeaways", "FAQ"]) {
      const input = validInput();
      input.body_markdown = input.body_markdown.replace(
        "Simple controls can help you change your position. [Browse suitable chairs](https://mobelaris.test/chairs) before choosing.",
        `Simple controls can help you change your position.\n\n## ${section}\n[Browse suitable chairs](https://mobelaris.test/chairs) before choosing.`,
      );
      expect(rules(input)).toContain("links.verified_internal_presence");
    }
    const callout = validInput();
    callout.body_markdown = callout.body_markdown.replace(
      "Simple controls can help you change your position. [Browse suitable chairs](https://mobelaris.test/chairs) before choosing.",
      "Simple controls can help you change your position.\n\n> [Browse suitable chairs](https://mobelaris.test/chairs) before choosing.",
    );
    expect(rules(callout)).toContain("links.verified_internal_presence");
  });

  it("checks the primary keyword at body word 100 but not word 101", () => {
    for (const [prefixCount, expected] of [
      [52, false],
      [53, true],
    ] as const) {
      const input = validInput();
      input.body_markdown = `# ergonomic chairs\n\n${words(40)}\n\n## Key Takeaways\n- desk seating\n- back support\n- useful choice\n\n## ergonomic chairs guide\n${words(prefixCount)} ergonomic chairs\n\n> Tip`;
      expect(rules(input).includes("keyword.primary.first_100_words")).toBe(expected);
    }
  });

  it("keeps semantic finding IDs stable after unrelated line insertion and unique for duplicates", () => {
    const input = validInput();
    input.body_markdown +=
      "\n\n## Detail\nOur favorite color is useful.\n\nOur favorite color is useful.";
    const before = runDeterministicChecks(input).filter(
      (item) => item.rule === "style.british_english_provisional",
    );
    input.body_markdown = input.body_markdown.replace("## Detail", "\n\n## Detail");
    const after = runDeterministicChecks(input).filter(
      (item) => item.rule === "style.british_english_provisional",
    );
    expect(new Set(before.map((item) => item.id)).size).toBe(before.length);
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.map((item) => item.location.line_start)).not.toEqual(
      before.map((item) => item.location.line_start),
    );
  });

  it("accepts relative tracked links as canonical shortlist commercial presence", () => {
    const input = validInput();
    input.body_markdown = input.body_markdown.replace(
      "https://mobelaris.test/chairs",
      "/chairs/?utm_source=email#options",
    );
    expect(rules(input)).not.toContain("links.verified_internal_presence");
  });

  it("retains commercial body-presence while Step 1.8 owns target auditing", () => {
    const absent = validInput();
    absent.body_markdown = absent.body_markdown.replace(
      "https://mobelaris.test/chairs",
      "https://other.test/chairs",
    );
    expect(rules(absent)).toContain("links.verified_internal_presence");

    const offShortlist = validInput();
    offShortlist.body_markdown = offShortlist.body_markdown.replace(
      "https://mobelaris.test/chairs",
      "https://mobelaris.test/unapproved",
    );
    expect(rules(offShortlist)).toContain("links.verified_internal_presence");
    expect(rules(offShortlist)).not.toContain("links.shortlist_membership");

    const failed = validInput();
    failed.verified_internal_links[0]!.status = 301;
    expect(rules(failed)).toContain("links.verified_internal_presence");
    expect(rules(failed)).not.toContain("links.target_status");
  });

  it("reports every empty structured on-page field without rejecting checkable input", () => {
    const input = validInput();
    input.on_page = {
      meta_title: "",
      meta_description: "",
      og_title: "",
      og_description: "",
      slug: "",
      images: [{ alt: "", filename: "" }],
      faqs: [{ question: "", answer: "" }],
    };
    const findings = runDeterministicChecks(input);
    expect(findings.filter((item) => item.rule === "on_page.populated")).toHaveLength(9);
  });
});

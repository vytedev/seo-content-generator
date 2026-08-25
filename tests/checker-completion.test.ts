import { describe, expect, it } from "vitest";
import { runDeterministicChecks, type CheckerInput } from "../src/shared/checker/index.js";

const words = (count: number) => Array.from({ length: count }, () => "plain").join(" ");

function input(): CheckerInput {
  return {
    primary_keyword: "ergonomic chairs",
    related_keywords: ["desk seating", "back support"],
    body_markdown: [
      "# Ergonomic chairs guide",
      `Ergonomic chairs ${words(38)}`,
      "## Key Takeaways",
      "- desk seating matters",
      "- back support matters",
      "- adjustment matters",
      "## How ergonomic chairs fit",
      "Use desk seating and back support with a [product](https://www.mobelaris.com/en/item).",
      "> Measure first.",
      "## Conclusion",
      "Ergonomic chairs work when support, adjustment and the workspace fit the reader.",
    ].join("\n\n"),
    on_page: {
      meta_title: "ergonomic chairs".padEnd(55, "x"),
      meta_description: "ergonomic chairs".padEnd(150, "x"),
      og_title: "Ergonomic chairs guide",
      og_description: "Guide",
      slug: "ergonomic-chairs",
      images: [{ alt: "Chair", filename: "chair.jpg" }],
      faqs: [1, 2, 3].map((number) => ({ question: `Question ${number}`, answer: words(40) })),
    },
    internal_origins: ["https://www.mobelaris.com"],
    verified_internal_links: [
      {
        url: "https://www.mobelaris.com/en/item",
        status: 200,
        hierarchy: "product",
        hierarchy_rank: 4,
      },
    ],
  };
}

const rules = (value: CheckerInput) => runDeterministicChecks(value).map((finding) => finding.rule);

describe("Milestone 1 completion rules", () => {
  it("requires an answer-first Conclusion section", () => {
    const missing = input();
    missing.body_markdown = missing.body_markdown.replace(/\n\n## Conclusion[\s\S]*$/, "");
    expect(rules(missing)).toContain("structure.conclusion");

    const headingFirst = input();
    headingFirst.body_markdown = headingFirst.body_markdown.replace(
      "## Conclusion\n\nErgonomic",
      "## Conclusion\n\n### Detail\n\nErgonomic",
    );
    expect(rules(headingFirst)).toContain("structure.conclusion");
  });

  it("does not accept a conclusion-only link hidden beneath a subheading", () => {
    const value = input();
    value.body_markdown = value.body_markdown
      .replace(" with a [product](https://www.mobelaris.com/en/item).", ".")
      .replace(
        "## Conclusion\n\nErgonomic",
        "## Conclusion\n\nErgonomic\n\n### Products\n\nSee [product](https://www.mobelaris.com/en/item).\n\nErgonomic",
      );
    expect(rules(value)).toContain("links.verified_internal_presence");
  });

  it("does not reject a lower-priority link solely because a higher rank exists", () => {
    const value = input();
    value.verified_internal_links.unshift({
      url: "https://www.mobelaris.com/en/collection",
      status: 200,
      hierarchy: "collection",
      hierarchy_rank: 1,
    });
    expect(runDeterministicChecks(value)).not.toContainEqual(
      expect.objectContaining({ rule: "links.hierarchy_priority" }),
    );
  });
});

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CheckerInput } from "../src/shared/checker/index.js";

const words = (count: number) => Array.from({ length: count }, () => "plain").join(" ");

function validInput(): CheckerInput {
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

describe("local checker API", () => {
  it("reports health", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns findings and severity totals for valid input", async () => {
    const response = await request(createApp()).post("/api/checker").send(validInput());

    expect(response.status).toBe(200);
    expect(response.body.findings).toEqual(expect.any(Array));
    expect(response.body.summary).toEqual({
      info: response.body.findings.filter((item: { severity: string }) => item.severity === "info")
        .length,
      warning: response.body.findings.filter(
        (item: { severity: string }) => item.severity === "warning",
      ).length,
      blocker: response.body.findings.filter(
        (item: { severity: string }) => item.severity === "blocker",
      ).length,
    });
  });

  it("rejects invalid and unknown input with safe validation details", async () => {
    const response = await request(createApp())
      .post("/api/checker")
      .send({ ...validInput(), primary_keyword: "", unknown: "secret-value" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_INPUT",
      message: "The checker input is invalid.",
    });
    expect(response.body.error.details).toEqual(expect.any(Array));
    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });

  it("rejects malformed JSON with a standard safe error", async () => {
    const response = await request(createApp())
      .post("/api/checker")
      .set("Content-Type", "application/json")
      .send('{"primary_keyword":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "INVALID_JSON", message: "The request body must be valid JSON." },
    });
  });

  it("does not expose internal checker errors", async () => {
    const app = createApp({
      runChecks: () => {
        throw new Error("sensitive implementation detail");
      },
    });
    const response = await request(app).post("/api/checker").send(validInput());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "The checker could not be completed." },
    });
    expect(JSON.stringify(response.body)).not.toContain("sensitive implementation detail");
  });
});

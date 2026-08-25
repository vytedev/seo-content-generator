import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RealGoogleDocsAdapter,
  readCanonicalDocument,
} from "../src/server/providers/google-docs.js";
import { simulatedGoogle } from "./helpers/simulated-google.js";
import type { GoogleOAuthClient } from "../src/server/providers/google-oauth.js";

/**
 * Structural hygiene of what a NEW export actually writes. These assertions read
 * the emitted batchUpdate requests, so they need no live Google call and no
 * visual rendering: every property is decidable from the request payload.
 */
function renderedOperations(operations: Array<Record<string, unknown>>) {
  const markdown = operations.map((operation) => String(operation.text ?? "")).join("\n");
  return {
    title: "Canonical title",
    markdown,
    content_hash: createHash("sha256").update(markdown).digest("hex"),
    render_hash: createHash("sha256").update(JSON.stringify(operations)).digest("hex"),
    operations,
    operation_count: operations.length,
  } as any;
}

/** Every operation type, including nested lists and a multiline list item. */
function everyOperationType() {
  return renderedOperations([
    { type: "paragraph", style: "TITLE", text: "Document title", spans: [] },
    { type: "paragraph", style: "HEADING_1", text: "A heading", spans: [] },
    {
      type: "paragraph",
      style: "NORMAL_TEXT",
      text: "Body copy with bold and a link.",
      spans: [
        { start: 15, end: 19, kind: "bold" },
        { start: 26, end: 30, kind: "link", target: "https://www.mobelaris.com/" },
      ],
    },
    { type: "list_item", ordered: false, text: "Top level bullet", spans: [] },
    { type: "list_item", ordered: false, nesting_level: 1, text: "Nested bullet", spans: [] },
    { type: "list_item", ordered: true, text: "First ordered step", spans: [] },
    { type: "list_item", ordered: true, text: "Multiline\nsecond line", spans: [] },
    { type: "blockquote", text: "A quotation.", spans: [] },
    {
      type: "image_marker",
      marker_id: "m",
      filename: "m.jpg",
      alt: "Alt",
      text: "[IMAGE m | filename: m.jpg | alt: Alt]",
    },
    {
      type: "table",
      rows: [
        [
          { text: "Claim ID", spans: [] },
          { text: "Evidence", spans: [] },
        ],
        [
          { text: "claim-1", spans: [] },
          { text: "A long evidence value that must stay in its own cell.", spans: [] },
        ],
      ],
    },
    { type: "paragraph", style: "NORMAL_TEXT", text: "After the table.", spans: [] },
  ]);
}

/**
 * Drives a complete export against a double that applies the requests, and
 * returns every request across every phase together with the document they
 * produced. Inspecting a single batch would miss whatever later phases write.
 */
async function exported(rendered: ReturnType<typeof renderedOperations>) {
  const google = simulatedGoogle();
  await new RealGoogleDocsAdapter(
    { accessToken: async () => "access-token" } as GoogleOAuthClient,
    google.fetchImpl,
  ).export("hygiene-key", rendered);
  return {
    requests: google.requests,
    document: readCanonicalDocument(google.simulator.document()),
  };
}

async function emittedRequests(rendered: ReturnType<typeof renderedOperations>) {
  return (await exported(rendered)).requests;
}

const insertedText = (requests: Array<Record<string, any>>) =>
  requests
    .filter((request) => request.insertText)
    .map((request) => String(request.insertText.text));

describe("new export body hygiene", () => {
  it("writes no internal list marker text", async () => {
    const requests = await emittedRequests(everyOperationType());
    const all = insertedText(requests).join("");
    expect(all).not.toContain("MOBELARIS_LIST");
    // Nor the invisible separator the legacy marker was wrapped in.
    expect(all).not.toContain("\u2063");
  });

  it("writes no completion marker into the document body", async () => {
    const requests = await emittedRequests(everyOperationType());
    expect(insertedText(requests).join("")).not.toContain("MOBELARIS_EXPORT_COMPLETE");
  });

  it("uses native bullets for lists, with leading tabs only as nesting positioning", async () => {
    const { requests, document } = await exported(everyOperationType());
    const bullets = requests.filter((request) => request.createParagraphBullets);
    // One per list item: two unordered, one nested, two ordered.
    expect(bullets.length).toBe(4);
    expect(
      bullets.every(
        (request) =>
          String(request.createParagraphBullets.bulletPreset).startsWith("NUMBERED") ||
          String(request.createParagraphBullets.bulletPreset).startsWith("BULLET"),
      ),
    ).toBe(true);
    // Tabs exist only to position nesting and are consumed doing so, so none
    // may survive into the document's canonical text.
    expect(JSON.stringify(document.operations)).not.toContain("\\t");
    // Nesting itself is native, and is exactly what was asked for.
    expect(document.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "list_item", text: "Top level bullet" }),
        expect.objectContaining({ type: "list_item", text: "Nested bullet", nesting_level: 1 }),
      ]),
    );
  });

  it("keeps authored line breaks inside one paragraph rather than splitting the item", async () => {
    const { document } = await exported(everyOperationType());
    const multiline = document.operations.filter((operation) =>
      String((operation as { text?: string }).text ?? "").includes("second line"),
    );
    // One operation, not two: a real newline would have started a new paragraph
    // and split the list item in half.
    expect(multiline).toHaveLength(1);
    expect(multiline[0]).toMatchObject({ type: "list_item", text: "Multiline\nsecond line" });
  });

  it("never hides body text with colour or size", async () => {
    const requests = await emittedRequests(everyOperationType());
    const styles = requests
      .filter((request) => request.updateTextStyle)
      .map((request) => request.updateTextStyle.textStyle);
    for (const style of styles) {
      const rgb = style?.foregroundColor?.color?.rgbColor;
      if (rgb) {
        // No white-on-white: at least one channel must be clearly dark.
        const channels = [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0];
        expect(Math.max(...channels)).toBeLessThan(0.5);
      }
      if (style?.fontSize) expect(style.fontSize.magnitude).toBeGreaterThan(0);
    }
  });

  it("uses one professional font family, with monospace only for semantic code", async () => {
    const requests = await emittedRequests(everyOperationType());
    const families = new Set(
      requests
        .filter((request) => request.updateTextStyle?.textStyle?.weightedFontFamily)
        .map((request) => String(request.updateTextStyle.textStyle.weightedFontFamily.fontFamily)),
    );
    for (const family of families) expect(["Arial", "Roboto Mono"]).toContain(family);
    expect(families).toContain("Arial");
  });

  it("keeps post-table operations outside the table", async () => {
    const { document } = await exported(everyOperationType());
    // The operation after the table is a top-level paragraph in its own right.
    // When it was placed inside the last cell instead, the table read back as
    // one carrying an extra paragraph and this reconstruction failed.
    const index = document.operations.findIndex(
      (operation) => (operation as { type: string }).type === "table",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(document.operations[index + 1]).toMatchObject({
      type: "paragraph",
      text: "After the table.",
    });
  });
});

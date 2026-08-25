import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RealGoogleDocsAdapter,
  readCanonicalDocument,
} from "../src/server/providers/google-docs.js";
import type { GoogleOAuthClient } from "../src/server/providers/google-oauth.js";
import { simulatedGoogle } from "./helpers/simulated-google.js";
import { TABLE_GEOMETRY_VARIANTS } from "./helpers/google-docs-simulator.js";

/**
 * The real adapter, end to end, against a Google double that actually applies
 * requests to a document and rejects invalid positions.
 *
 * No live call is made and no fixture is the oracle: correctness is "the
 * document reconstructs to exactly the operations that were exported", which
 * holds for any article shape.
 */
const oauth = { accessToken: async () => "access-token" } as GoogleOAuthClient;

function rendered(operations: Array<Record<string, unknown>>) {
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

const table = (rows: number, columns: number, cell = (r: number, c: number) => `r${r}c${c}`) => ({
  type: "table",
  rows: Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => ({ text: cell(r, c), spans: [] })),
  ),
});

/** Every structural difference a valid article may contain, in one document. */
const EVERY_SHAPE = [
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
  { type: "list_item", ordered: false, nesting_level: 2, text: "Deeper still", spans: [] },
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
  table(2, 2, (r, c) =>
    r === 1 && c === 1 ? "A long evidence value in its own cell." : `h${r}${c}`,
  ),
  { type: "paragraph", style: "NORMAL_TEXT", text: "Between the tables.", spans: [] },
  table(3, 4),
  table(1, 1, () => ""),
  { type: "paragraph", style: "HEADING_2", text: "Émigré — naïve “quotes” 中文 🙂", spans: [] },
  { type: "paragraph", style: "NORMAL_TEXT", text: "After the tables.", spans: [] },
];

function expectDocumentMatches(google: ReturnType<typeof simulatedGoogle>, operations: unknown[]) {
  const read = readCanonicalDocument(google.simulator.document());
  expect(JSON.stringify(read.operations)).toBe(
    JSON.stringify(JSON.parse(JSON.stringify(operations))),
  );
  // No control text is ever left in the body.
  expect(JSON.stringify(read.operations)).not.toContain("MOBELARIS_EXPORT_COMPLETE");
  expect(JSON.stringify(read.operations)).not.toContain("MOBELARIS_LIST");
}

describe("Google Docs adapter, end to end against an executing double", () => {
  it("exports every operation type exactly", async () => {
    const google = simulatedGoogle();
    const result = await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
      "key-every-shape",
      rendered(EVERY_SHAPE),
    );
    expect(result.replayed).toBe(false);
    expectDocumentMatches(google, EVERY_SHAPE);
    // Completion is recorded as file metadata, never as body text.
    expect(google.appProperties.mobelaris_export_complete_hash).toBeTruthy();
  });

  // The acceptance property: no article shape and no table layout may require a
  // change to the adapter.
  for (const [name, tableGeometry] of TABLE_GEOMETRY_VARIANTS)
    it(`exports correctly under table geometry: ${name}`, async () => {
      const google = simulatedGoogle({ tableGeometry });
      await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
        `key-${name}`,
        rendered(EVERY_SHAPE),
      );
      expectDocumentMatches(google, EVERY_SHAPE);
    });

  it("writes in fenced phases, each against the revision it was planned on", async () => {
    const google = simulatedGoogle();
    await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
      "key-fencing",
      rendered(EVERY_SHAPE),
    );
    // Tables force a phase boundary, so this document cannot be one batch.
    expect(google.calls.batchUpdate).toBeGreaterThan(1);
    for (const control of google.writeControls)
      expect((control as { requiredRevisionId?: string }).requiredRevisionId).toBeTruthy();
    // Every phase was planned against a fresh read.
    expect(google.calls.reads).toBeGreaterThanOrEqual(google.calls.batchUpdate);
  });

  it("resumes after an interrupted phase without duplicating the document", async () => {
    // A phase fails as a lost process or transport error would.
    const first = simulatedGoogle({ failBatchAt: { index: 1, status: 503 } });
    await expect(
      new RealGoogleDocsAdapter(oauth, first.fetchImpl).export("key-resume", rendered(EVERY_SHAPE)),
    ).rejects.toThrow();
    expect(first.calls.created).toBe(1);
    const partial = readCanonicalDocument(first.simulator.document()).operations.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(EVERY_SHAPE.length);

    // A fresh attempt finds the reserved document and continues from whatever is
    // actually there. No second document, no duplicated content.
    const second = simulatedGoogle({
      simulator: first.simulator,
      reservedFile: { id: "simulated-document", appProperties: first.appProperties },
    });
    await new RealGoogleDocsAdapter(oauth, second.fetchImpl).export(
      "key-resume",
      rendered(EVERY_SHAPE),
    );
    expect(second.calls.created).toBe(0);
    expectDocumentMatches(second, EVERY_SHAPE);
  });

  it("is idempotent: a completed export replays without writing again", async () => {
    const google = simulatedGoogle();
    const adapter = new RealGoogleDocsAdapter(oauth, google.fetchImpl);
    const first = await adapter.export("key-replay", rendered(EVERY_SHAPE));
    const batchesAfterFirst = google.calls.batchUpdate;
    const second = await adapter.export("key-replay", rendered(EVERY_SHAPE));
    expect(first.external_document_id).toBe(second.external_document_id);
    expect(second.replayed).toBe(true);
    expect(google.calls.batchUpdate).toBe(batchesAfterFirst);
    expect(google.calls.created).toBe(1);
    expectDocumentMatches(google, EVERY_SHAPE);
  });

  it("keeps post-table content outside the table", async () => {
    const operations = [
      table(2, 3),
      { type: "paragraph", style: "NORMAL_TEXT", text: "After.", spans: [] },
    ];
    const google = simulatedGoogle();
    await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
      "key-post-table",
      rendered(operations),
    );
    const read = readCanonicalDocument(google.simulator.document());
    expect(read.operations).toHaveLength(2);
    expect((read.operations[1] as { type: string }).type).toBe("paragraph");
  });

  it("keeps authored line breaks inside one list item", async () => {
    const operations = [
      { type: "list_item", ordered: false, text: "Multiline\nsecond line", spans: [] },
    ];
    const google = simulatedGoogle();
    await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
      "key-multiline",
      rendered(operations),
    );
    const read = readCanonicalDocument(google.simulator.document());
    expect(read.operations).toHaveLength(1);
    expect(read.operations[0]).toMatchObject({ type: "list_item", text: "Multiline\nsecond line" });
  });

  it("leaves no nesting tabs in the exported text", async () => {
    const operations = [
      { type: "list_item", ordered: false, text: "Top", spans: [] },
      { type: "list_item", ordered: false, nesting_level: 1, text: "Nested", spans: [] },
      { type: "list_item", ordered: false, nesting_level: 2, text: "Deeper", spans: [] },
    ];
    const google = simulatedGoogle();
    await new RealGoogleDocsAdapter(oauth, google.fetchImpl).export(
      "key-tabs",
      rendered(operations),
    );
    const read = readCanonicalDocument(google.simulator.document());
    expect(JSON.stringify(read.operations)).not.toContain("\\t");
    expect(read.operations).toMatchObject([
      { type: "list_item", text: "Top" },
      { type: "list_item", text: "Nested", nesting_level: 1 },
      { type: "list_item", text: "Deeper", nesting_level: 2 },
    ]);
  });
});

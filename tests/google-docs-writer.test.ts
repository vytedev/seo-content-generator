import { describe, expect, it } from "vitest";
import type { GoogleDocsOperation } from "../src/shared/export.js";
import { readCanonicalDocument } from "../src/server/providers/google-docs.js";
import {
  GoogleDocsWriteConflictError,
  planNextBatch,
} from "../src/server/providers/google-docs-writer.js";
import {
  GoogleDocsSimulator,
  TABLE_GEOMETRY_VARIANTS,
  type TableGeometry,
} from "./helpers/google-docs-simulator.js";

/**
 * Drives the real planner against the structural simulator exactly as the
 * adapter drives it against Google: read, plan, write, read again. Nothing here
 * tells the planner where anything is; every position it uses comes from the
 * document it was handed.
 */
function exportInto(
  simulator: GoogleDocsSimulator,
  target: readonly GoogleDocsOperation[],
  options: { maxRunLength?: number; interruptAfter?: number } = {},
) {
  let batches = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const document = simulator.document();
    const read = readCanonicalDocument(document);
    const batch = planNextBatch({
      document,
      present: read.operations,
      target,
      appendIndex: read.marker_insertion_index!,
      ...(options.maxRunLength === undefined ? {} : { maxRunLength: options.maxRunLength }),
    });
    if (!batch) return { batches, completed: true };
    if (options.interruptAfter !== undefined && batches === options.interruptAfter)
      return { batches, completed: false };
    simulator.apply(batch.requests);
    batches += 1;
  }
  throw new Error("export did not converge");
}

const paragraph = (
  text: string,
  style: GoogleDocsOperation extends never ? never : any = "NORMAL_TEXT",
) => ({ type: "paragraph", style, text, spans: [] }) as GoogleDocsOperation;
const listItem = (text: string, ordered = false, nesting?: number) =>
  ({
    type: "list_item",
    ordered,
    ...(nesting ? { nesting_level: nesting } : {}),
    text,
    spans: [],
  }) as GoogleDocsOperation;
const blockquote = (text: string) =>
  ({ type: "blockquote", text, spans: [] }) as GoogleDocsOperation;
const imageMarker = (id: string) =>
  ({
    type: "image_marker",
    marker_id: id,
    filename: `${id}.jpg`,
    alt: `alt ${id}`,
    text: `[IMAGE ${id} | filename: ${id}.jpg | alt: alt ${id}]`,
  }) as GoogleDocsOperation;
const table = (rows: number, columns: number, cell = (r: number, c: number) => `r${r}c${c}`) =>
  ({
    type: "table",
    rows: Array.from({ length: rows }, (_, r) =>
      Array.from({ length: columns }, (_, c) => ({ text: cell(r, c), spans: [] })),
    ),
  }) as GoogleDocsOperation;

/** Every structural difference a valid article may legitimately contain. */
const SHAPES: ReadonlyArray<readonly [string, GoogleDocsOperation[]]> = [
  ["single paragraph", [paragraph("Only one.")]],
  [
    "headings and prose",
    [paragraph("Title", "TITLE"), paragraph("H2", "HEADING_2"), paragraph("Body text.")],
  ],
  ["table first", [table(2, 2), paragraph("after")]],
  ["table last", [paragraph("before"), table(2, 2)]],
  ["two adjacent tables", [table(2, 2), table(3, 2), paragraph("after")]],
  ["table between prose", [paragraph("before"), table(2, 3), paragraph("after")]],
  ["1x1 table", [table(1, 1), paragraph("after")]],
  ["wide table", [table(2, 6), paragraph("after")]],
  ["tall table", [table(9, 2), paragraph("after")]],
  ["empty cells", [table(2, 3, (r, c) => ((r + c) % 2 ? "" : "value")), paragraph("after")]],
  ["all cells empty", [table(2, 2, () => ""), paragraph("after")]],
  [
    "long cell",
    [table(2, 2, (r, c) => (r === 1 && c === 0 ? "x".repeat(400) : "s")), paragraph("after")],
  ],
  [
    "multiline cell",
    [table(1, 2, (r, c) => (c === 0 ? "line one\nline two" : "s")), paragraph("after")],
  ],
  ["flat unordered list", [listItem("one"), listItem("two"), listItem("three")]],
  ["ordered list", [listItem("one", true), listItem("two", true)]],
  [
    "nested list",
    [
      listItem("one"),
      listItem("child", false, 1),
      listItem("deeper", false, 2),
      paragraph("after"),
    ],
  ],
  [
    "deeply nested list",
    [
      listItem("a"),
      listItem("b", false, 1),
      listItem("c", false, 2),
      listItem("d", false, 3),
      listItem("e", false, 4),
    ],
  ],
  [
    "list then table",
    [listItem("one"), listItem("child", false, 1), table(2, 2), paragraph("after")],
  ],
  ["table then list", [table(2, 2), listItem("one"), listItem("child", false, 1)]],
  ["multiline list item", [listItem("first line\nsecond line"), paragraph("after")]],
  ["blockquote", [blockquote("A quoted line."), paragraph("after")]],
  ["image marker", [imageMarker("hero"), paragraph("after")]],
  ["unicode", [paragraph("Émigré — naïve “quotes” … 中文 🙂"), table(1, 2, () => "café ☕")]],
  [
    "inline spans",
    [
      {
        type: "paragraph",
        style: "NORMAL_TEXT",
        text: "bold italic code link",
        spans: [
          { start: 0, end: 4, kind: "bold" },
          { start: 5, end: 11, kind: "italic" },
          { start: 12, end: 16, kind: "code" },
          { start: 17, end: 21, kind: "link", target: "https://www.mobelaris.com/x" },
        ],
      } as GoogleDocsOperation,
    ],
  ],
  [
    "everything at once",
    [
      paragraph("Title", "TITLE"),
      paragraph("Intro paragraph."),
      listItem("one"),
      listItem("child", false, 1),
      table(2, 3),
      blockquote("Quoted."),
      imageMarker("hero"),
      listItem("first", true),
      listItem("second", true),
      table(1, 1, () => ""),
      paragraph("Conclusion", "HEADING_2"),
      paragraph("Final words."),
    ],
  ],
];

/** The document must reconstruct to exactly the operations that were exported. */
function expectExact(simulator: GoogleDocsSimulator, target: readonly GoogleDocsOperation[]) {
  const read = readCanonicalDocument(simulator.document());
  expect(JSON.stringify(read.operations)).toBe(JSON.stringify(JSON.parse(JSON.stringify(target))));
}

describe("reread-driven Google Docs writer", () => {
  for (const [name, target] of SHAPES)
    it(`exports "${name}" exactly`, () => {
      const simulator = new GoogleDocsSimulator();
      expect(exportInto(simulator, target).completed).toBe(true);
      expectExact(simulator, target);
    });

  // The acceptance property. Nothing in this repository is independent ground
  // truth for Google's table index layout, so the writer must not depend on any
  // particular layout. A predicted-index writer passes one variant; this one
  // must pass all of them.
  for (const [geometryName, tableGeometry] of TABLE_GEOMETRY_VARIANTS)
    describe(`table geometry: ${geometryName}`, () => {
      for (const [name, target] of SHAPES)
        it(`exports "${name}" exactly`, () => {
          const simulator = new GoogleDocsSimulator("d", { tableGeometry });
          expect(exportInto(simulator, target).completed).toBe(true);
          expectExact(simulator, target);
        });
    });

  it("is unaffected by how many paragraphs share a request", () => {
    const [, target] = SHAPES.find(([name]) => name === "everything at once")!;
    for (const maxRunLength of [1, 2, 3, 5, 100]) {
      const simulator = new GoogleDocsSimulator();
      expect(exportInto(simulator, target, { maxRunLength }).completed).toBe(true);
      expectExact(simulator, target);
    }
  });

  it("resumes an interrupted export from the document itself, without duplicating", () => {
    const [, target] = SHAPES.find(([name]) => name === "everything at once")!;
    const complete = new GoogleDocsSimulator();
    const total = exportInto(complete, target).batches;
    for (let interruptAfter = 1; interruptAfter < total; interruptAfter += 1) {
      const simulator = new GoogleDocsSimulator();
      const partial = exportInto(simulator, target, { interruptAfter });
      expect(partial.completed).toBe(false);
      // A fresh process resumes with no state beyond the document.
      expect(exportInto(simulator, target).completed).toBe(true);
      expectExact(simulator, target);
    }
  });

  it("plans nothing further once the document already matches", () => {
    const [, target] = SHAPES.find(([name]) => name === "table between prose")!;
    const simulator = new GoogleDocsSimulator();
    exportInto(simulator, target);
    const document = simulator.document();
    const read = readCanonicalDocument(document);
    expect(
      planNextBatch({
        document,
        present: read.operations,
        target,
        appendIndex: read.marker_insertion_index!,
      }),
    ).toBeNull();
  });

  it("fails closed when the document diverges from the export", () => {
    const target = [paragraph("expected one"), paragraph("expected two")];
    const simulator = new GoogleDocsSimulator();
    exportInto(simulator, [paragraph("something else entirely")]);
    const document = simulator.document();
    const read = readCanonicalDocument(document);
    expect(() =>
      planNextBatch({
        document,
        present: read.operations,
        target,
        appendIndex: read.marker_insertion_index!,
      }),
    ).toThrow(GoogleDocsWriteConflictError);
  });
});

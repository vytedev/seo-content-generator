import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RealGoogleDocsAdapter,
  readCanonicalDocument,
} from "../src/server/providers/google-docs.js";
import { simulatedGoogle } from "./helpers/simulated-google.js";
import { contentHash } from "../src/shared/milestone-two.js";
import type { GoogleOAuthClient } from "../src/server/providers/google-oauth.js";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  renderExport,
  type ExportRenderResult,
  type GoogleDocsOperation,
} from "../src/shared/export.js";

const SEPARATOR = "\u2063";
/** Docs' in-paragraph line break; a real "\n" would start a new paragraph. */
const DOCS_LINE_BREAK = "\u000b";
const COMPLETE_PREFIX = "MOBELARIS_EXPORT_COMPLETE:";
const listMarker = (ordered: boolean) =>
  `${SEPARATOR}MOBELARIS_LIST:${ordered ? "ORDERED" : "UNORDERED"}${SEPARATOR}`;

/**
 * A realistic draft exercising every operation type the renderer can emit:
 * headings, prose, rich inline spans, both list kinds, a blockquote, an image
 * marker and a GFM table.
 */
function draft() {
  return {
    title: "Wishbone chair buying guide for calm interiors".padEnd(55, "."),
    slug: "wishbone-chair-buying-guide",
    meta_description: "A practical guide to choosing a wishbone chair.".padEnd(150, "."),
    og_title: "Wishbone chair buying guide",
    og_description: "A practical guide to choosing a wishbone chair.",
    images: [
      {
        alt: "A wishbone chair in oak",
        filename: "wishbone-chair-oak.jpg",
        placement: { marker: "wishbone-chair" },
      },
    ],
    faqs: [
      { question: "Is it solid oak?", answer: "Most reproductions use steamed oak." },
      { question: "How do I clean it?", answer: "Wipe the frame and brush the paper cord." },
    ],
    markdown: [
      "# Wishbone chair buying guide",
      "",
      "<!-- MOBELARIS_IMAGE:wishbone-chair -->",
      "",
      "A chair with **bold emphasis**, *italic nuance*, `inline code` and a",
      "[real link](https://www.mobelaris.com/blogs/furniture-guides) in one paragraph.",
      "",
      "## Choosing well",
      "",
      "- First unordered point",
      "- Second unordered point",
      "",
      "1. First ordered step",
      "2. Second ordered step",
      "",
      "> A quotation that should round-trip as a blockquote.",
      "",
      "### Comparison",
      "",
      "| Model | Material | Price |",
      "| --- | --- | --- |",
      "| CH24 | Oak | High |",
      "| Replica | Beech | Low |",
      "",
      "A closing paragraph.",
    ].join("\n"),
    claims: [
      { text: "Solid oak is a hardwood", type: "material" as const, status: "unverified" as const },
    ],
  };
}

function rendered(overrides: Record<string, unknown> = {}): ExportRenderResult {
  return renderExport({
    plane_ticket: "MOB-RT-1",
    draft: draft(),
    primary_keyword: "wishbone chair",
    related_keywords: ["wishbone chair replica"],
    page_type: "blog",
    locales_for_translation: ["sv-SE"],
    export_date: "2026-08-23",
    internal_links: [
      {
        url: "https://www.mobelaris.com/blogs/furniture-guides",
        title: "Mobelaris furniture guides",
        relevance: 0.9,
      },
    ],
    writer_template: DEFAULT_WRITER_TEMPLATE,
    schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
    ...overrides,
  });
}

function renderedWithOperationCount(
  targetOperationCount: number,
  overrides: Record<string, unknown> = {},
): ExportRenderResult {
  const rejectedFindings = (overrides.rejected_findings as
    ReturnType<typeof rejectedFinding>[] | undefined) ?? [rejectedFinding()];
  const base = rendered({ ...overrides, rejected_findings: rejectedFindings });
  const paddingCount = targetOperationCount - base.operation_count;
  if (paddingCount < 0) throw new Error("Target operation count is below the base fixture");
  const paddedDraft = draft();
  paddedDraft.markdown +=
    "\n\n" +
    Array.from(
      { length: paddingCount },
      (_, index) => `Deterministic padding paragraph ${index + 1}.`,
    ).join("\n\n");
  const result = rendered({
    ...overrides,
    draft: paddedDraft,
    rejected_findings: rejectedFindings,
  });
  if (result.operation_count !== targetOperationCount)
    throw new Error("Could not construct the requested operation-count fixture");
  return result;
}

function historicalRendered(): ExportRenderResult {
  const claims = Array.from({ length: 12 }, (_, index) => ({
    id: `claim-${index + 1}`,
    claim_text: `Deterministic claim ${index + 1}`,
    type: "general" as const,
    status: "unverified" as const,
    hard_flag: false,
    location: { field: "body_markdown", line_start: index + 1 },
    claim_hash: String(index + 1).padStart(64, "0"),
    sources: [],
  }));
  const rejectedFindings = Array.from({ length: 4 }, (_, index) => rejectedFinding(index + 1));
  return renderedWithOperationCount(65, { claims, rejected_findings: rejectedFindings });
}

/** A rejected finding renders as one list item containing several lines. */
function rejectedFinding(index = 1) {
  return {
    finding_id: `finding-${index}`,
    disposition_id: `disposition-${index}`,
    review_set_id: `review-set-${index}`,
    review_set_membership_hash: "b".repeat(64),
    stable_key: `style-vague-heading-${index}`,
    category: "writing_style",
    rule_reference: "style.vague_heading",
    severity: "warning" as const,
    location: { field: "body_markdown", line_start: index },
    issue: `Heading ${index} is vague.`,
    suggested_fix: `Name the chair in heading ${index}.`,
    rationale: `Heading ${index} follows deliberate house style.`,
    finding_hash: "c".repeat(64),
    disposition_hash: "d".repeat(64),
  };
}

/**
 * Models the one Google behaviour that the reread depends on: inserted text is
 * split into a separate paragraph at every real "\n", while U+000B stays inside
 * a single paragraph. Everything else mirrors the styling the batch requests.
 */
function googleDocument(
  result: ExportRenderResult,
  documentId = "doc-round-trip",
  mode: "legacy" | "native" = "legacy",
) {
  const inline = (value: string) => value.replaceAll("\n", DOCS_LINE_BREAK);
  /**
   * Google returns a separate textRun per styled range, so reconstruct the runs
   * the batch's updateTextStyle calls would have produced.
   */
  const elementsFor = (line: string, spans: ReadonlyArray<Record<string, any>>, shift: number) => {
    const boundaries = new Set<number>([0, line.length]);
    for (const span of spans) {
      boundaries.add(Math.max(0, span.start + shift));
      boundaries.add(Math.min(line.length, span.end + shift));
    }
    const points = [...boundaries].sort((a, b) => a - b);
    const elements: unknown[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const [from, to] = [points[i]!, points[i + 1]!];
      if (to <= from) continue;
      const style: Record<string, unknown> = {};
      for (const span of spans)
        if (span.start + shift <= from && span.end + shift >= to) {
          if (span.kind === "bold") style.bold = true;
          if (span.kind === "italic") style.italic = true;
          if (span.kind === "code") style.weightedFontFamily = { fontFamily: "Roboto Mono" };
          if (span.kind === "link") style.link = { url: span.target };
        }
      const content = `${line.slice(from, to)}${to === line.length ? "\n" : ""}`;
      elements.push({
        textRun: { content, ...(Object.keys(style).length ? { textStyle: style } : {}) },
      });
    }
    return elements.length ? elements : [{ textRun: { content: "\n" } }];
  };
  const paragraphs = (
    text: string,
    extra: Record<string, unknown> = {},
    spans: ReadonlyArray<Record<string, any>> = [],
    prefixLength = 0,
  ) =>
    text.split("\n").map((line) => ({
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      ...extra,
      elements: elementsFor(line, spans, prefixLength),
    }));
  const content: unknown[] = [];
  const lists: Record<string, unknown> = {};
  let listId = 0;
  for (const operation of result.operations as GoogleDocsOperation[]) {
    if (operation.type === "paragraph")
      content.push(
        ...paragraphs(
          inline(operation.text),
          { paragraphStyle: { namedStyleType: operation.style } },
          operation.spans,
        ).map((paragraph) => ({ paragraph })),
      );
    else if (operation.type === "blockquote")
      content.push(
        ...paragraphs(
          inline(operation.text),
          {
            paragraphStyle: {
              namedStyleType: "NORMAL_TEXT",
              indentStart: { magnitude: 18, unit: "PT" },
            },
          },
          operation.spans,
        ).map((paragraph) => ({ paragraph })),
      );
    else if (operation.type === "list_item") {
      const id = `list-${listId++}`;
      const nestingLevel = operation.nesting_level ?? 0;
      lists[id] = {
        listProperties: {
          nestingLevels: Array.from({ length: nestingLevel + 1 }, () =>
            operation.ordered ? { glyphType: "DECIMAL" } : { glyphSymbol: "●" },
          ),
        },
      };
      content.push(
        ...paragraphs(
          `${mode === "legacy" ? listMarker(operation.ordered) : ""}${inline(operation.text)}`,
          { bullet: { listId: id, ...(nestingLevel ? { nestingLevel } : {}) } },
          operation.spans,
          mode === "legacy" ? listMarker(operation.ordered).length : 0,
        ).map((paragraph) => ({ paragraph })),
      );
    } else if (operation.type === "image_marker")
      content.push(...paragraphs(inline(operation.text)).map((paragraph) => ({ paragraph })));
    else
      content.push({
        table: {
          tableRows: operation.rows.map((row) => ({
            tableCells: row.map((cell) => ({
              content: paragraphs(inline(cell.text), {}, cell.spans).map((paragraph) => ({
                paragraph,
              })),
            })),
          })),
        },
      });
  }
  if (mode === "legacy")
    content.push(
      ...paragraphs(`${COMPLETE_PREFIX}${result.render_hash}`).map((paragraph) => ({ paragraph })),
    );
  let cursor = 1;
  for (let operationIndex = 0; operationIndex < result.operations.length; operationIndex += 1) {
    const operation = result.operations[operationIndex] as GoogleDocsOperation;
    const item = content[operationIndex] as any;
    item.startIndex = cursor;
    item.endIndex = cursor + operationSize(operation, mode === "legacy");
    if (operation.type === "table" && item.table) {
      const columns = operation.rows[0]!.length;
      let priorTextLength = 0;
      for (let row = 0; row < operation.rows.length; row += 1)
        for (let column = 0; column < columns; column += 1) {
          const textLength = operation.rows[row]![column]!.text.length;
          const paragraph = item.table.tableRows[row]!.tableCells[column]!.content[0];
          const startIndex = cursor + 4 + row * (2 * columns + 1) + column * 2 + priorTextLength;
          paragraph.startIndex = startIndex;
          paragraph.endIndex = startIndex + textLength + 1;
          priorTextLength += textLength;
        }
    }
    cursor = item.endIndex;
  }
  if (mode === "legacy") {
    const marker = content[result.operations.length] as any;
    marker.startIndex = cursor;
    marker.endIndex = cursor + `${COMPLETE_PREFIX}${result.render_hash}`.length + 1;
    cursor = marker.endIndex;
  }
  content.push({
    startIndex: cursor,
    endIndex: cursor + 1,
    paragraph: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      elements: [{ textRun: { content: "\n" } }],
    },
  });
  const completionHash = contentHash(
    JSON.stringify({
      content_hash: result.content_hash,
      render_hash: result.render_hash,
      format_version: "2",
    }),
  );
  const fixture: any = {
    documentId,
    revisionId: "revision-1",
    body: { content },
    ...(Object.keys(lists).length ? { lists } : {}),
    __fixtureAppProperties: {
      mobelaris_provider_idempotency_key: "fixture-key",
      mobelaris_content_hash: result.content_hash,
      mobelaris_render_hash: result.render_hash,
      ...(mode === "native"
        ? {
            mobelaris_export_complete_hash: completionHash,
            mobelaris_export_format_version: "2",
          }
        : {}),
    },
  };
  if (mode === "legacy")
    fixture.__fixtureCleanDocument = googleDocument(result, documentId, "native");
  return fixture;
}

function operationSize(operation: GoogleDocsOperation, legacy = true): number {
  if (operation.type === "table") {
    const rows = operation.rows.length;
    const columns = operation.rows[0]!.length;
    // Table indexes: 1 for the table, 1 per row, 2 per cell (cell + paragraph
    // newline), plus the final cell paragraph's own terminator — the index the
    // historical bug omitted — then the authored cell text.
    return (
      2 * rows * columns +
      rows +
      2 +
      operation.rows.flat().reduce((total, cell) => total + cell.text.length, 0)
    );
  }
  const prefix = operation.type === "list_item" && legacy ? listMarker(operation.ordered) : "";
  return prefix.length + operation.text.length + 1;
}

function nativeDocument(result: ExportRenderResult, revisionId = "revision-2") {
  const document = structuredClone(googleDocument(result, "doc-round-trip", "native")) as any;
  document.revisionId = revisionId;
  return document;
}

function indexAfterOperations(
  result: ExportRenderResult,
  operationCount: number,
  legacy = true,
): number {
  return (
    1 +
    (result.operations as GoogleDocsOperation[])
      .slice(0, operationCount)
      .reduce((index, operation) => index + operationSize(operation, legacy), 0)
  );
}

function recoveryDocument(
  result: ExportRenderResult,
  completion: "matching" | "missing" | "different",
  revisionId = "revision-1",
) {
  const document = structuredClone(googleDocument(result)) as any;
  const content = document.body.content as any[];
  const markerIndex = content.findIndex((item: any) =>
    item.paragraph?.elements?.some((element: any) =>
      String(element.textRun?.content ?? "").startsWith(COMPLETE_PREFIX),
    ),
  );
  if (completion === "missing") content.splice(markerIndex, 1);
  else if (completion === "different") {
    const marker = content[markerIndex];
    if (marker?.paragraph?.elements?.[0]?.textRun)
      marker.paragraph.elements[0].textRun.content = `${COMPLETE_PREFIX}different\n`;
  }
  const completionText =
    completion === "missing"
      ? ""
      : completion === "matching"
        ? `${COMPLETE_PREFIX}${result.render_hash}`
        : `${COMPLETE_PREFIX}different`;
  const tailIndex =
    indexAfterOperations(result, result.operation_count) + completionText.length + 1;
  const tail = content.at(-1);
  tail.startIndex = tailIndex;
  tail.endIndex = tailIndex + 1;
  document.revisionId = revisionId;
  return document;
}

function prefixDocument(
  result: ExportRenderResult,
  operationCount: number,
  revisionId = "revision-1",
) {
  const document = recoveryDocument(result, "missing", revisionId);
  const content = document.body.content as any[];
  content.splice(operationCount, content.length - operationCount - 1);
  const tail = content.at(-1);
  const tailIndex = indexAfterOperations(result, operationCount);
  tail.startIndex = tailIndex;
  tail.endIndex = tailIndex + 1;
  return document;
}

/**
 * Reproduces the historical table-index corruption: because the table size
 * omitted the final cell paragraph's terminator, every operation following the
 * table was inserted onto that paragraph, landing inside the last cell.
 *
 * The result is a document holding operations 0..T (T = the last table) with
 * operations T+1.. sitting as extra paragraphs in the final table cell, and no
 * completion marker.
 */
function historicalCorruptionDocument(
  result: ExportRenderResult,
  options: {
    revisionId?: string;
    normaliseMisplacedLists?: boolean;
    attempt47MergedHeading?: boolean;
    omitContinuationBulletMetadata?: boolean;
    reverseMisplaced?: boolean;
    mutate?: (misplaced: any[], cell: any) => void;
  } = {},
) {
  const operations = result.operations as GoogleDocsOperation[];
  const tableOperationIndex = operations.reduce(
    (last, operation, index) => (operation.type === "table" ? index : last),
    -1,
  );
  if (tableOperationIndex < 0) throw new Error("fixture requires a table operation");
  const document = prefixDocument(
    result,
    tableOperationIndex + 1,
    options.revisionId ?? "revision-1",
  );
  const content = document.body.content as any[];
  // Operations map one-to-one onto body items, so the last table operation is
  // exactly this item — and it is the table the repair detection targets.
  const tableItem = content[tableOperationIndex];
  if (!tableItem?.table) throw new Error("fixture table item not found");
  const rows = tableItem.table.tableRows;
  const lastCell = rows.at(-1).tableCells.at(-1);

  // Build the misplaced operations exactly as Google would have stored them.
  const suffixResult = {
    ...result,
    operations: operations.slice(tableOperationIndex + 1),
  } as ExportRenderResult;
  const suffixItems = (googleDocument(suffixResult) as any).body.content as any[];
  // Ordinary historical fixtures model a missing completion marker. Attempt
  // 47 proves a narrower shape where it also landed inside the final cell.
  const completionItem = structuredClone(suffixItems.at(-2));
  let misplaced = suffixItems.slice(0, -2).map((item) => structuredClone(item));
  if (options.normaliseMisplacedLists || options.attempt47MergedHeading)
    misplaced = misplaced.flatMap((item) => {
      const paragraph = item.paragraph;
      if (!paragraph?.bullet) return [item];
      const raw = (paragraph.elements ?? [])
        .map((element: any) => String(element.textRun?.content ?? ""))
        .join("");
      const lines = raw.replace(/\n$/, "").split(DOCS_LINE_BREAK);
      if (lines.length === 1) return [item];
      return lines.map((line: string, index: number) => ({
        paragraph: {
          paragraphStyle: structuredClone(paragraph.paragraphStyle ?? {}),
          ...(index === 0 || !options.omitContinuationBulletMetadata
            ? { bullet: structuredClone(paragraph.bullet) }
            : {}),
          elements: [
            {
              textRun: {
                // Google retains the hidden list marker only on the first
                // normalised paragraph; continuation bullets carry no marker.
                content: `${line}\n`,
                ...(index === 0 && paragraph.elements?.[0]?.textRun?.textStyle
                  ? { textStyle: structuredClone(paragraph.elements[0].textRun.textStyle) }
                  : {}),
              },
            },
          ],
        },
      }));
    });
  if (options.reverseMisplaced) misplaced.reverse();

  const paragraphTextLength = (paragraph: any) => {
    const raw = (paragraph?.elements ?? [])
      .map((element: any) => String(element.textRun?.content ?? ""))
      .join("");
    return raw.endsWith("\n") ? raw.length - 1 : raw.length;
  };
  let mergedHeadingStart: number | undefined;
  let mergedHeadingLength = 0;
  if (options.attempt47MergedHeading) {
    const heading = misplaced.shift();
    const primary = (lastCell.content ?? []).find((item: any) => item.paragraph);
    if (!heading?.paragraph || !primary?.paragraph)
      throw new Error("attempt-47 fixture requires heading and authored cell paragraph");
    const primaryElements = primary.paragraph.elements ?? [];
    const finalRun = primaryElements.at(-1)?.textRun;
    if (!finalRun || !String(finalRun.content).endsWith("\n"))
      throw new Error("attempt-47 fixture requires a terminated authored cell paragraph");
    finalRun.content = String(finalRun.content).slice(0, -1);
    primary.paragraph.elements = [
      ...primaryElements,
      ...(heading.paragraph.elements ?? []).map((element: any) => structuredClone(element)),
    ];
    primary.paragraph.paragraphStyle = structuredClone(heading.paragraph.paragraphStyle ?? {});
    mergedHeadingLength = paragraphTextLength(heading.paragraph);
    misplaced.push(completionItem);
  }

  // Contiguous structural indexes starting after the cell's authored paragraph.
  const authored = (lastCell.content ?? []).filter((item: any) => item.paragraph);
  const tableEnd = indexAfterOperations(result, tableOperationIndex + 1);
  const primary = authored[0];
  if (options.attempt47MergedHeading && primary?.paragraph) {
    const actualLength = paragraphTextLength(primary.paragraph);
    const expectedLength = actualLength - mergedHeadingLength;
    primary.startIndex = tableEnd - expectedLength - 1;
    primary.endIndex = primary.startIndex + actualLength + 1;
    mergedHeadingStart = primary.startIndex + expectedLength;
  }
  let cursor = (authored.at(-1)?.endIndex as number) ?? 1;
  let retainedCellTerminator: any | undefined;
  for (const item of misplaced) {
    const length =
      (item.paragraph.elements ?? []).reduce(
        (total: number, element: any) => total + String(element.textRun?.content ?? "").length,
        0,
      ) || 1;
    item.startIndex = cursor;
    item.endIndex = cursor + length;
    cursor += length;
  }
  if (options.attempt47MergedHeading) {
    retainedCellTerminator = {
      startIndex: cursor,
      endIndex: cursor + 1,
      paragraph: {
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        elements: [{ textRun: { content: "\n" } }],
      },
    };
    cursor += 1;
  }
  lastCell.content = [
    ...(lastCell.content ?? []),
    ...misplaced,
    ...(retainedCellTerminator ? [retainedCellTerminator] : []),
  ];
  options.mutate?.(misplaced, lastCell);

  // The trailing empty paragraph sits after everything the table now holds.
  const tail = content.at(-1);
  const misplacedLength = misplaced.reduce(
    (total, item) => total + ((item.endIndex as number) - (item.startIndex as number)),
    0,
  );
  tail.startIndex =
    tableEnd + mergedHeadingLength + misplacedLength + (retainedCellTerminator ? 1 : 0);
  tail.endIndex = tail.startIndex + 1;
  return {
    document,
    misplaced,
    tableOperationIndex,
    misplacedLength,
    mergedHeadingStart,
    retainedCellTerminator,
  };
}

/** The batch requests a repair attempt sent, if any. */
function repairAdapter(
  document: unknown,
  options: {
    rereads?: unknown[];
    batchOk?: boolean;
    contentHash?: string | undefined;
    renderHash?: string | undefined;
    reservedDocumentIds?: string[];
    reservedContentHashes?: Array<string | undefined>;
  } = {},
) {
  const calls = {
    batches: [] as any[],
    driveCreate: 0,
    drivePatch: 0,
    reads: 0,
    writeControls: [] as unknown[],
  };
  const rereads = options.rereads ?? [];
  const reservedDocumentIds = options.reservedDocumentIds ?? [];
  const reservedContentHashes = options.reservedContentHashes ?? [];
  let completionProperties: Record<string, string> = {};
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("drive/v3/files") && init?.method === "POST") {
      calls.driveCreate += 1;
      return new Response(JSON.stringify({ id: "doc-round-trip" }));
    }
    if (target.includes("drive/v3/files") && init?.method === "PATCH") {
      calls.drivePatch += 1;
      const body = JSON.parse(String(init.body)) as { appProperties?: Record<string, string> };
      completionProperties = { ...completionProperties, ...body.appProperties };
      return new Response(
        JSON.stringify({ id: "doc-round-trip", appProperties: completionProperties }),
      );
    }
    if (target.includes("drive/v3/files"))
      return new Response(
        JSON.stringify({
          files: [
            {
              id: reservedDocumentIds.length ? reservedDocumentIds.shift() : "doc-round-trip",
              appProperties: {
                mobelaris_content_hash: reservedContentHashes.length
                  ? reservedContentHashes.shift()
                  : options.contentHash,
                mobelaris_render_hash: options.renderHash,
                ...completionProperties,
              },
            },
          ],
        }),
      );
    if (target.includes("batchUpdate")) {
      const body = JSON.parse(String(init?.body));
      calls.batches.push(body.requests);
      calls.writeControls.push(body.writeControl);
      return options.batchOk === false
        ? new Response(JSON.stringify({ error: { message: "revision conflict" } }), { status: 400 })
        : new Response("{}");
    }
    const next = rereads.length ? (rereads.shift() as unknown) : document;
    calls.reads += 1;
    return new Response(JSON.stringify(next));
  }) as unknown as typeof fetch;
  const adapter = new RealGoogleDocsAdapter(
    { accessToken: async () => "access-token" } as GoogleOAuthClient,
    fetchImpl,
  );
  return { adapter, calls };
}

type GoogleFixtureStructuralElement = {
  paragraph?: {
    paragraphStyle?: Record<string, unknown>;
    elements?: Array<{ textRun?: { textStyle?: Record<string, unknown> } }>;
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: GoogleFixtureStructuralElement[] }>;
    }>;
  };
};

/**
 * Google may return inherited/unset style fields as JSON null, an empty
 * object, or an object containing only a unit. Keep the fixture sanitised
 * while modelling those response variants; concrete styles written by the
 * application still win.
 */
function withInheritedStyleDefaults(
  document: ReturnType<typeof googleDocument>,
  indentStart: Record<string, unknown> | null = null,
) {
  const copy = structuredClone(document) as unknown as {
    body: { content: GoogleFixtureStructuralElement[] };
  };
  const visit = (content: GoogleFixtureStructuralElement[]) => {
    for (const item of content) {
      if (item.paragraph) {
        item.paragraph.paragraphStyle = {
          indentStart,
          ...(item.paragraph.paragraphStyle ?? {}),
        };
        for (const element of item.paragraph.elements ?? [])
          if (element.textRun)
            element.textRun.textStyle = {
              bold: null,
              italic: null,
              link: null,
              weightedFontFamily: null,
              ...(element.textRun.textStyle ?? {}),
            };
      }
      for (const row of item.table?.tableRows ?? [])
        for (const cell of row.tableCells ?? []) visit(cell.content ?? []);
    }
  };
  visit(copy.body.content);
  return copy;
}

/** Drives the adapter against a simulated Google, reporting what it was asked to do. */
function adapterAgainst(
  document: unknown,
  options: {
    empty?: boolean;
    afterBatchDocument?: unknown;
    readSequence?: unknown[];
    batchStatus?: number;
    reservedAppProperties?: Record<string, string>;
  } = {},
) {
  const calls = {
    batchUpdate: 0,
    driveCreate: 0,
    drivePatch: 0,
    reads: 0,
    batchBodies: [] as Array<Record<string, any>>,
  };
  let written = !options.empty;
  let currentDocument = document;
  let appProperties =
    options.reservedAppProperties ??
    ((document as any)?.__fixtureAppProperties as Record<string, string> | undefined);
  const emptyDocument = {
    documentId: "doc-round-trip",
    revisionId: "revision-empty",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 2,
          paragraph: { elements: [{ textRun: { content: "\n" } }] },
        },
      ],
    },
  };
  const readSequence = [...(options.readSequence ?? [])];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("drive/v3/files") && init?.method === "POST") {
      calls.driveCreate += 1;
      return new Response(JSON.stringify({ id: "doc-round-trip" }));
    }
    if (target.includes("drive/v3/files") && init?.method === "PATCH") {
      calls.drivePatch += 1;
      const body = JSON.parse(String(init.body)) as { appProperties?: Record<string, string> };
      appProperties = { ...appProperties, ...body.appProperties };
      return new Response(JSON.stringify({ id: "doc-round-trip", appProperties }));
    }
    if (target.includes("drive/v3/files"))
      return new Response(
        JSON.stringify({
          files: [{ id: "doc-round-trip", appProperties }],
        }),
      );
    if (target.includes("batchUpdate")) {
      calls.batchUpdate += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      calls.batchBodies.push(body);
      written = true;
      currentDocument =
        options.afterBatchDocument ??
        (currentDocument as any)?.__fixtureCleanDocument ??
        currentDocument;
      return new Response("{}", { status: options.batchStatus ?? 200 });
    }
    calls.reads += 1;
    const nextDocument = readSequence.length ? readSequence.shift() : currentDocument;
    return new Response(JSON.stringify(written ? nextDocument : emptyDocument));
  }) as unknown as typeof fetch;
  const adapter = new RealGoogleDocsAdapter(
    { accessToken: async () => "access-token" } as GoogleOAuthClient,
    fetchImpl,
  );
  return { adapter, calls };
}

describe("Google Docs export round trip", () => {
  it("keeps one rendered operation to exactly one Google paragraph", async () => {
    // The direct invariant the live failure violated: an interior newline in
    // inserted text makes Google start a new paragraph, so a multi-line
    // operation came back as several paragraphs and could not be reconstructed.
    const result = rendered({ rejected_findings: [rejectedFinding()] });
    expect(
      (result.operations as GoogleDocsOperation[]).some(
        (operation) => "text" in operation && operation.text.includes("\n"),
      ),
    ).toBe(true);

    const adapter = new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      vi.fn() as unknown as typeof fetch,
    );
    const requests = (adapter as any).nativeRequestsForOperations(
      result.operations,
      "",
      1,
    ) as Array<Record<string, any>>;
    const inserts = requests.filter((request) => request.insertText);
    expect(inserts.length).toBeGreaterThan(0);
    for (const request of inserts) {
      const text = String(request.insertText.text);
      // Only a single terminating newline is permitted.
      expect(text.slice(0, -1)).not.toContain("\n");
    }
  });

  it("round-trips every operation type back to the exact render hash", async () => {
    const result = rendered({ rejected_findings: [rejectedFinding()] });
    const types = new Set((result.operations as GoogleDocsOperation[]).map((o) => o.type));
    expect(types).toEqual(
      new Set(["paragraph", "list_item", "blockquote", "image_marker", "table"]),
    );
    // Rich spans and a multi-column table are genuinely present.
    expect(
      (result.operations as GoogleDocsOperation[]).flatMap((o) =>
        "spans" in o ? o.spans.map((s) => s.kind) : [],
      ),
    ).toEqual(expect.arrayContaining(["bold", "italic", "code", "link"]));

    const document = withInheritedStyleDefaults(googleDocument(result));
    const { adapter, calls } = adapterAgainst(document, { empty: true });
    await expect(adapter.export("round-trip-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
    });
    expect(calls.batchUpdate).toBe(1);

    // A retry must recover the same reserved document and must not write or
    // create a second document after the exact canonical reread succeeds.
    await expect(adapter.export("round-trip-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
      replayed: true,
    });
    // The write is attempted once; the next read shows it did not advance the
    // document, so the export stops rather than retrying indefinitely.
    expect(calls.batchUpdate).toBeLessThanOrEqual(2);
    expect(calls.driveCreate).toBe(0);
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["a unit-only object", { unit: "PT" }],
  ])(
    "accepts inherited indentStart as %s without reconstructing missing magnitude as a blockquote",
    async (_label, indentStart) => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const document = withInheritedStyleDefaults(googleDocument(result), indentStart);
      const { adapter, calls } = adapterAgainst(document);

      // Exact canonical reread succeeds only if the concrete magnitude: 18
      // paragraph remains a blockquote and missing magnitudes remain ordinary
      // paragraphs, including those nested in table cells.
      await expect(adapter.export("indent-default-key", result)).resolves.toMatchObject({
        external_document_id: "doc-round-trip",
        replayed: true,
      });
      expect(calls.batchUpdate).toBe(1);
      expect(calls.driveCreate).toBe(0);
    },
  );

  it("recovers an already-written reserved document without a second batch or a new document", async () => {
    const result = rendered({ rejected_findings: [rejectedFinding()] });
    const { adapter, calls } = adapterAgainst(withInheritedStyleDefaults(googleDocument(result)));
    await expect(adapter.export("recovery-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
      replayed: true,
    });
    expect(calls.batchUpdate).toBe(1);
    expect(calls.driveCreate).toBe(0);
  });

  it("migrates a markerless-completion legacy document on the same reservation, then replays", async () => {
    const result = rendered({ rejected_findings: [rejectedFinding()] });
    const missing = recoveryDocument(result, "missing", "revision-1");
    const completed = nativeDocument(result);
    const { adapter, calls } = adapterAgainst(missing, {
      afterBatchDocument: completed,
    });

    await expect(adapter.export("marker-recovery-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
      replayed: true,
    });
    expect(calls.driveCreate).toBe(0);
    expect(calls.batchUpdate).toBe(1);
    const requests = calls.batchBodies[0]?.requests ?? [];
    expect(requests.some((request: any) => request.deleteContentRange)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("MOBELARIS_EXPORT_COMPLETE");
    expect(JSON.stringify(requests)).not.toContain("MOBELARIS_LIST:");
    expect(requests.some((request: any) => request.createParagraphBullets)).toBe(false);
    expect(requests.some((request: any) => request.insertText)).toBe(false);
    expect(calls.batchBodies[0]?.writeControl).toEqual({ requiredRevisionId: "revision-1" });

    await expect(adapter.export("marker-recovery-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
      replayed: true,
    });
    expect(calls.batchUpdate).toBe(1);
    expect(calls.driveCreate).toBe(0);
  });

  it("normalises Google structural empty table-cell paragraphs before recovering the live suffix", async () => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60, "revision-1");
    const completed = nativeDocument(result);
    for (const document of [prefix, completed]) {
      const table = (document.body.content as any[]).find((item) => item.table)?.table;
      const cell = table.tableRows[0].tableCells[0];
      cell.content.unshift({
        paragraph: {
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          elements: [{ textRun: { content: "\n" } }],
        },
      });
      cell.content.push({
        paragraph: {
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          elements: [{ textRun: { content: "\n" } }],
        },
      });
    }
    const { adapter, calls } = adapterAgainst(prefix, {
      afterBatchDocument: completed,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("table-structural-empty-key", result)).resolves.toMatchObject({
      replayed: true,
    });
    // The write is attempted once; the next read shows it did not advance the
    // document, so the export stops rather than retrying indefinitely.
    expect(calls.batchUpdate).toBeLessThanOrEqual(2);
    expect(calls.driveCreate).toBe(0);
  });

  it.each([
    [
      "bullet",
      {
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        bullet: { listId: "foreign-empty-list" },
        elements: [{ textRun: { content: "\n" } }],
      },
    ],
  ])("fails closed on a meaningful empty table-cell %s paragraph", async (_label, paragraph) => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60, "revision-1");
    const table = (prefix.body.content as any[]).find((item) => item.table)?.table;
    table.tableRows[0].tableCells[0].content.push({ paragraph });
    const { adapter, calls } = adapterAgainst(prefix, {
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("table-meaningful-empty-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("ignores inherited paragraph and text styles on Google's structural empty table-cell paragraph", async () => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60, "revision-1");
    const completed = nativeDocument(result);
    for (const document of [prefix, completed]) {
      const table = (document.body.content as any[]).find((item) => item.table)?.table;
      table.tableRows
        .at(-1)
        .tableCells.at(-1)
        .content.push({
          paragraph: {
            paragraphStyle: {
              namedStyleType: "HEADING_2",
              indentStart: { magnitude: 18, unit: "PT" },
              spaceAbove: { magnitude: 12, unit: "PT" },
            },
            elements: [
              {
                textRun: {
                  content: "\n",
                  textStyle: {
                    bold: true,
                    weightedFontFamily: { fontFamily: "Arial" },
                  },
                },
              },
            ],
          },
        });
    }
    const { adapter, calls } = adapterAgainst(prefix, {
      afterBatchDocument: completed,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("table-empty-inherited-style-key", result)).resolves.toMatchObject({
      replayed: true,
    });
    expect(calls.batchUpdate).toBe(1);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails closed when a Google table cell contains multiple non-empty paragraphs", async () => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60, "revision-1");
    const table = (prefix.body.content as any[]).find((item) => item.table)?.table;
    table.tableRows[0].tableCells[0].content.push({
      paragraph: {
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        elements: [{ textRun: { content: "Foreign second paragraph\n" } }],
      },
    });
    const { adapter, calls } = adapterAgainst(prefix, {
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("table-multiple-paragraph-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("recovers a 60-of-65 document by writing only the missing five operations", async () => {
    const result = renderedWithOperationCount(65);
    const prefixCount = 60;
    expect(result.operations.slice(prefixCount).map((operation) => operation.type)).toEqual([
      "list_item",
      "paragraph",
      "table",
      "paragraph",
      "list_item",
    ]);
    const prefixOperations = result.operations.slice(0, prefixCount);
    const prefixResult = {
      ...result,
      operations: prefixOperations,
      operation_count: prefixCount,
      render_hash: createHash("sha256").update(JSON.stringify(prefixOperations)).digest("hex"),
    } as ExportRenderResult;

    // Build the interrupted document by genuinely exporting its first 60
    // operations, so the recovery runs against a real document rather than a
    // hand-built fixture of what one is assumed to look like.
    const first = simulatedGoogle();
    await new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      first.fetchImpl,
    ).export("suffix-recovery-key", prefixResult);
    const before = readCanonicalDocument(first.simulator.document()).operations;
    expect(before).toHaveLength(prefixCount);

    const second = simulatedGoogle({
      simulator: first.simulator,
      reservedFile: {
        id: "simulated-document",
        appProperties: {
          mobelaris_provider_idempotency_key: "suffix-recovery-key",
          mobelaris_content_hash: result.content_hash,
          mobelaris_render_hash: result.render_hash,
          mobelaris_export_format_version: "2",
        },
      },
    });
    await new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      second.fetchImpl,
    ).export("suffix-recovery-key", result);

    // Exactly the missing five, and the sixty already present were not rewritten.
    const after = readCanonicalDocument(second.simulator.document()).operations;
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(JSON.parse(JSON.stringify(result.operations))),
    );
    expect(JSON.stringify(after.slice(0, prefixCount))).toBe(JSON.stringify(before));
    expect(second.calls.created).toBe(0);
    for (const control of second.writeControls)
      expect((control as { requiredRevisionId?: string }).requiredRevisionId).toBeTruthy();
    expect(JSON.stringify(second.requests)).not.toMatch(/MOBELARIS_(?:LIST|EXPORT_COMPLETE)/);
  });
  it("allows Google's expected leading default section break during suffix recovery", async () => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60, "revision-1");
    const completed = nativeDocument(result);
    const defaultSectionBreak = {
      endIndex: 1,
      sectionBreak: { sectionStyle: { columnSeparatorStyle: "NONE" } },
    };
    prefix.body.content.unshift(structuredClone(defaultSectionBreak));
    completed.body.content.unshift(structuredClone(defaultSectionBreak));
    const { adapter, calls } = adapterAgainst(prefix, {
      afterBatchDocument: completed,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("default-section-break-key", result)).resolves.toMatchObject({
      replayed: true,
    });
    // The write is attempted once; the next read shows it did not advance the
    // document, so the export stops rather than retrying indefinitely.
    expect(calls.batchUpdate).toBeLessThanOrEqual(2);
    expect(calls.driveCreate).toBe(0);
  });

  it.each([
    [
      "inline object",
      (document: any) => {
        const paragraph = document.body.content.find((item: any) => item.paragraph)?.paragraph;
        paragraph.elements.push({ inlineObjectElement: { inlineObjectId: "foreign-object" } });
      },
    ],
    [
      "table of contents",
      (document: any) => {
        document.body.content.splice(-1, 0, {
          tableOfContents: { content: [] },
        });
      },
    ],
    [
      "nested table",
      (document: any) => {
        const table = document.body.content.find((item: any) => item.table)?.table;
        table.tableRows[0].tableCells[0].content.push({
          table: {
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                          elements: [{ textRun: { content: "Nested foreign table\n" } }],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      },
    ],
    [
      "positioned object",
      (document: any) => {
        const paragraph = document.body.content.find((item: any) => item.paragraph)?.paragraph;
        paragraph.positionedObjectIds = ["foreign-positioned-object"];
      },
    ],
    [
      "suggestion state",
      (document: any) => {
        const paragraph = document.body.content.find((item: any) => item.paragraph)?.paragraph;
        paragraph.elements[0].textRun.suggestedInsertionIds = ["foreign-suggestion"];
      },
    ],
  ])("fails closed on unsupported %s content before suffix recovery", async (_, mutate) => {
    const result = renderedWithOperationCount(65);
    const prefix = prefixDocument(result, 60);
    mutate(prefix);
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const { adapter, calls } = adapterAgainst(prefix, {
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("unsupported-structure-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"reason":"unsupported_document_structure"');
    expect(log).not.toContain("foreign-object");
    expect(log).not.toContain("foreign-positioned-object");
    expect(log).not.toContain("foreign-suggestion");
    spy.mockRestore();
  });

  it("treats a lost suffix-update response as a replay when the guarded write completed", async () => {
    const result = rendered();
    const prefix = prefixDocument(result, result.operation_count - 5, "revision-1");
    const completed = nativeDocument(result);
    const { adapter, calls } = adapterAgainst(prefix, {
      afterBatchDocument: completed,
      batchStatus: 409,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("suffix-response-loss-key", result)).resolves.toMatchObject({
      external_document_id: "doc-round-trip",
      replayed: true,
    });
    expect(calls.batchUpdate).toBe(1);
    await expect(adapter.export("suffix-response-loss-key", result)).resolves.toMatchObject({
      replayed: true,
    });
    expect(calls.batchUpdate).toBe(1);
    expect(calls.driveCreate).toBe(0);
  });

  it("does not recover an exact prefix when reserved Drive metadata is absent or stale", async () => {
    const result = rendered();
    const prefix = prefixDocument(result, result.operation_count - 5);
    const absent = adapterAgainst(prefix, { reservedAppProperties: {} });
    await expect(absent.adapter.export("missing-metadata-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(absent.calls.batchUpdate).toBe(0);

    const stale = adapterAgainst(prefix, {
      reservedAppProperties: {
        mobelaris_content_hash: "stale",
        mobelaris_render_hash: result.render_hash,
      },
    });
    await expect(stale.adapter.export("stale-metadata-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(stale.calls.batchUpdate).toBe(0);
  });

  it("fails closed when an exact prefix changes during the immediate reread", async () => {
    const result = rendered();
    const prefixCount = result.operation_count - 5;
    const prefix = prefixDocument(result, prefixCount, "revision-1");
    const changed = prefixDocument(result, prefixCount - 1, "revision-1");
    const { adapter, calls } = adapterAgainst(prefix, {
      readSequence: [prefix, changed],
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("changed-suffix-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
  });

  it("fails structural verification when the suffix update does not produce the exact export", async () => {
    const result = rendered();
    const prefix = prefixDocument(result, result.operation_count - 5, "revision-1");
    const stillIncomplete = prefixDocument(result, result.operation_count - 5, "revision-2");
    const { adapter, calls } = adapterAgainst(prefix, {
      afterBatchDocument: stillIncomplete,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("suffix-verification-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    // The write is attempted once; the next read shows it did not advance the
    // document, so the export stops rather than retrying indefinitely.
    expect(calls.batchUpdate).toBeLessThanOrEqual(2);
    expect(calls.driveCreate).toBe(0);
  });

  it.each([
    [
      "reordered",
      (content: any[]) => {
        [content[8], content[9]] = [content[9], content[8]];
      },
    ],
    [
      "extra",
      (content: any[]) => {
        content.splice(8, 0, {
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{ textRun: { content: "Foreign extra paragraph\n" } }],
          },
        });
      },
    ],
    [
      "duplicated",
      (content: any[]) => {
        content.splice(8, 0, structuredClone(content[8]));
      },
    ],
  ])("does not write when prefix operations are %s", async (_, mutate) => {
    const result = renderedWithOperationCount(65);
    const conflicting = prefixDocument(result, 60);
    mutate(conflicting.body.content);
    const { adapter, calls } = adapterAgainst(conflicting, {
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });

    await expect(adapter.export("prefix-conflict-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails closed when a markerless reserved document has differing canonical operations", async () => {
    const result = rendered();
    const conflicting = recoveryDocument(result, "missing");
    const target = (conflicting.body.content as any[]).find((item) =>
      item.paragraph?.elements?.[0]?.textRun?.content?.includes("closing paragraph"),
    );
    target.paragraph.elements[0].textRun.content = "Private conflicting sentence\n";
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const { adapter, calls } = adapterAgainst(conflicting);

    await expect(adapter.export("markerless-conflict-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"category":"idempotency_conflict"');
    expect(log).toContain('"reason":"reserved_document_not_exact_prefix"');
    expect(log).toContain('"exact_prefix_match":false');
    expect(log).toContain('"reserved_document_reused":true');
    expect(log).toContain('"completion_present":false');
    expect(log).toContain('"completion_matches_expected":false');
    expect(log).toContain('"canonical_operations_match_expected":false');
    expect(log).toContain('"operation_count"');
    expect(log).toContain('"expected_operation_count"');
    expect(log).toContain('"mismatch_index"');
    expect(log).toContain('"mismatch_actual_type":"paragraph"');
    expect(log).toContain('"mismatch_expected_type":"paragraph"');
    expect(log).not.toContain("Private conflicting sentence");
    expect(log).not.toContain(result.render_hash);
    expect(log).not.toContain("doc-round-trip");
    spy.mockRestore();
  });

  it("does not write when the reserved document has a different completion marker", async () => {
    const result = rendered();
    const { adapter, calls } = adapterAgainst(recoveryDocument(result, "different"));

    await expect(adapter.export("different-marker-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails closed on duplicate completion markers without appending another marker", async () => {
    const result = rendered();
    const duplicate = recoveryDocument(result, "matching");
    const content = duplicate.body.content as any[];
    const marker = content.find((item) =>
      item.paragraph?.elements?.[0]?.textRun?.content?.startsWith(COMPLETE_PREFIX),
    );
    content.splice(-1, 0, structuredClone(marker));
    const { adapter, calls } = adapterAgainst(duplicate);

    await expect(adapter.export("duplicate-marker-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails closed if the reserved document changes during the immediate recovery reread", async () => {
    const result = rendered();
    const missing = recoveryDocument(result, "missing");
    const different = recoveryDocument(result, "different", "revision-2");
    const { adapter, calls } = adapterAgainst(missing, {
      readSequence: [missing, different],
    });

    await expect(adapter.export("concurrent-conflict-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(0);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails closed when the revision changes before the guarded marker append", async () => {
    const result = rendered();
    const missing = recoveryDocument(result, "missing", "revision-1");
    const changed = recoveryDocument(result, "missing", "revision-2");
    const { adapter, calls } = adapterAgainst(missing, {
      afterBatchDocument: changed,
      batchStatus: 409,
    });

    await expect(adapter.export("revision-conflict-key", result)).rejects.toThrow(
      "idempotency conflict",
    );
    expect(calls.batchUpdate).toBe(1);
    expect(calls.driveCreate).toBe(0);
  });

  it("fails structural verification when a legacy marker migration does not persist", async () => {
    const result = rendered();
    const missing = recoveryDocument(result, "missing", "revision-1");
    const stillMissing = recoveryDocument(result, "missing", "revision-2");
    const { adapter, calls } = adapterAgainst(missing, {
      afterBatchDocument: stillMissing,
    });

    await expect(adapter.export("marker-verification-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    expect(calls.batchUpdate).toBe(1);
    const requests = calls.batchBodies[0]?.requests ?? [];
    expect(requests.filter((request: any) => request.deleteContentRange).length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).not.toContain("MOBELARIS_LIST:");
    expect(JSON.stringify(requests)).not.toContain("MOBELARIS_EXPORT_COMPLETE:");
    expect(requests.some((request: any) => request.insertText)).toBe(false);
    expect(calls.driveCreate).toBe(0);
  });

  it("never overwrites a reserved document holding conflicting content", async () => {
    const result = rendered();
    const conflicting = {
      documentId: "doc-round-trip",
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              elements: [{ textRun: { content: "Someone else's article\n" } }],
            },
          },
        ],
      },
    };
    const { adapter, calls } = adapterAgainst(conflicting);
    await expect(adapter.export("conflict-key", result)).rejects.toThrow("idempotency conflict");
    expect(calls.batchUpdate).toBe(0);
  });

  it("classifies a structural mismatch safely, without leaking document text", async () => {
    const result = rendered();
    // A document missing the completion marker altogether.
    const document = googleDocument(result);
    document.body.content = document.body.content.slice(0, -1);
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const { adapter } = adapterAgainst(document, { empty: true, afterBatchDocument: document });
    await expect(adapter.export("marker-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"stage":"docs_canonical_verify"');
    // Not google_api: Google accepted the write, so the connection is fine.
    expect(log).toContain('"category":"google_structure"');
    expect(log).toContain('"reason":"canonical_reread_mismatch"');
    expect(log).not.toContain("Wishbone chair");
    expect(log).not.toContain("hardwood");
  });

  it("reports the mismatching operation index without exposing its content", async () => {
    const result = rendered();
    const document = googleDocument(result);
    // Corrupt one paragraph's text so reconstruction diverges at a known point.
    const target = (document.body.content as any[]).find((item) =>
      item.paragraph?.elements?.[0]?.textRun?.content?.includes("closing paragraph"),
    );
    target.paragraph.elements[0].textRun.content = "Tampered secret sentence\n";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const { adapter } = adapterAgainst(document, { empty: true, afterBatchDocument: document });
    await expect(adapter.export("mismatch-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"reason":"canonical_reread_mismatch"');
    expect(log).toContain('"mismatch_index"');
    expect(log).toContain('"expected_hash_matches_render_hash":true');
    expect(log).not.toContain("Tampered secret sentence");
  });

  describe("historical table-index repair", () => {
    const key = "historical-repair-key";

    function setup(
      options: Parameters<typeof historicalCorruptionDocument>[1] = {},
      adapterOptions: Parameters<typeof repairAdapter>[1] = {},
    ) {
      const result = historicalRendered();
      const corruption = historicalCorruptionDocument(result, options);
      const verified = nativeDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document, verified, verified],
        ...adapterOptions,
      });
      return { result, corruption, verified, adapter, calls };
    }

    it("repairs the exact attempt-47 merged heading, forward findings and in-cell marker", async () => {
      const { result, corruption, adapter, calls } = setup({
        attempt47MergedHeading: true,
      });
      const markerStates = corruption.misplaced.map((item: any) => {
        const raw = (item.paragraph?.elements ?? [])
          .map((element: any) => String(element.textRun?.content ?? ""))
          .join("");
        return raw.startsWith(`${SEPARATOR}MOBELARIS_LIST:`);
      });

      expect(result.operation_count).toBe(65);
      expect(corruption.tableOperationIndex).toBe(59);
      expect(corruption.misplaced).toHaveLength(21);
      expect(
        markerStates.flatMap((present: boolean, index: number) => (present ? [index] : [])),
      ).toEqual([0, 5, 10, 15]);
      const finalText = corruption.misplaced
        .at(-1)
        .paragraph.elements.map((element: any) => String(element.textRun?.content ?? ""))
        .join("")
        .replace(/\n$/, "");
      expect(finalText).toHaveLength(90);

      expect(corruption.retainedCellTerminator.startIndex).toBe(
        corruption.misplaced.at(-1).endIndex,
      );
      expect(corruption.retainedCellTerminator.endIndex).toBe(
        corruption.retainedCellTerminator.startIndex + 1,
      );
      await expect(adapter.export(`${key}-attempt-47`, result)).resolves.toMatchObject({
        external_document_id: "doc-round-trip",
        replayed: true,
      });
      expect(calls.driveCreate).toBe(0);
      expect(calls.batches).toHaveLength(1);
      expect(calls.writeControls).toEqual([{ requiredRevisionId: "revision-1" }]);
      const requests = calls.batches[0] as any[];
      const deletions = requests.filter((request) => request.deleteContentRange);
      expect(deletions).toHaveLength(30);
      expect(deletions[0].deleteContentRange.range).toEqual({
        startIndex: corruption.mergedHeadingStart,
        endIndex: corruption.misplaced.at(-1).endIndex,
      });
      expect(requests.some((request) => request.insertTable)).toBe(false);
      const mergedHeadingStart = corruption.mergedHeadingStart;
      if (mergedHeadingStart === undefined) throw new Error("expected merged heading start");
      const expectedTable = (result.operations as GoogleDocsOperation[])[
        corruption.tableOperationIndex
      ];
      if (expectedTable?.type !== "table") throw new Error("expected table operation");
      const expectedCellLength = expectedTable.rows.at(-1)!.at(-1)!.text.length;
      const cellStyleResets = requests.filter(
        (request) =>
          request.updateParagraphStyle?.paragraphStyle?.namedStyleType === "NORMAL_TEXT" &&
          request.updateParagraphStyle?.fields === "namedStyleType",
      );
      expect(cellStyleResets).toEqual([
        {
          updateParagraphStyle: {
            range: {
              startIndex: mergedHeadingStart - expectedCellLength,
              endIndex: mergedHeadingStart + 1,
            },
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            fields: "namedStyleType",
          },
        },
      ]);
      const inserted = requests.filter(
        (request) =>
          request.insertText && !String(request.insertText.text).startsWith(COMPLETE_PREFIX),
      );
      expect(inserted).toHaveLength(5);
      expect(
        requests.filter((request) =>
          String(request.insertText?.text ?? "").startsWith(COMPLETE_PREFIX),
        ),
      ).toHaveLength(0);
    });

    it("logs only content-free proof for the exact attempt-47 structure", async () => {
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { result, adapter } = setup({ attempt47MergedHeading: true });

      await adapter.export(`${key}-attempt-47-safe-log`, result);

      const log = output.find((line) =>
        line.includes("google_docs.historical_table_repair_started"),
      );
      expect(log).toContain('"operation_count":60');
      expect(log).toContain('"expected_operation_count":65');
      expect(log).toContain('"misplaced_paragraph_count":21');
      expect(log).toContain('"misplaced_operation_count":5');
      expect(log).toContain('"merged_cell_expected_prefix_matches":true');
      expect(log).toContain('"merged_heading_suffix_matches":true');
      expect(log).toContain('"in_cell_completion_matches_expected":true');
      expect(log).toContain('"decoder_order":"attempt47_merged_heading_forward_lists"');
      expect(log).toContain('"attempt47_decoder_exact_match":true');
      expect(log).not.toContain("Outstanding rejected findings");
      expect(log).not.toContain("finding-1");
      expect(log).not.toContain("doc-round-trip");
      expect(log).not.toContain(result.render_hash);
      expect(log).not.toContain(result.content_hash);
      expect(log).toContain('"merged_cell_heading_style_matches":true');
      expect(log).toContain('"retained_cell_terminator_matches":true');
      expect(log).not.toContain("access-token");
    });

    const attempt47UnprovenCases: Array<{
      name: string;
      mutate: (misplaced: any[], cell: any) => void;
    }> = [
      {
        name: "changed original cell value",
        mutate: (_misplaced, cell) => {
          const primary = cell.content.find((item: any) => item.paragraph);
          primary.paragraph.elements[0].textRun.content = "Changed cell value";
        },
      },
      {
        name: "changed merged heading",
        mutate: (_misplaced, cell) => {
          const primary = cell.content.find((item: any) => item.paragraph);
          primary.paragraph.elements.at(-1).textRun.content = "Changed heading\n";
        },
      },
      {
        name: "changed finding paragraph",
        mutate: (misplaced) => {
          const run = misplaced[0].paragraph.elements[0].textRun;
          run.content = String(run.content).replace("finding-1", "changed-finding");
        },
      },
      {
        name: "missing paragraph",
        mutate: (misplaced, cell) => {
          cell.content = cell.content.filter((item: any) => item !== misplaced[3]);
        },
      },
      {
        name: "unexpected merged paragraph style",
        mutate: (_misplaced, cell) => {
          const primary = cell.content.find((item: any) => item.paragraph);
          primary.paragraph.paragraphStyle.namedStyleType = "NORMAL_TEXT";
        },
      },
      {
        name: "missing retained cell terminator",
        mutate: (_misplaced, cell) => {
          cell.content = cell.content.slice(0, -1);
        },
      },
      {
        name: "extra paragraph",
        mutate: (_misplaced, cell) => {
          cell.content = [
            ...cell.content,
            {
              startIndex: 90_000,
              endIndex: 90_011,
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "Unexpected\n" } }],
              },
            },
          ];
        },
      },
      {
        name: "duplicated paragraph",
        mutate: (misplaced, cell) => {
          cell.content = [...cell.content, structuredClone(misplaced[4])];
        },
      },
      {
        name: "partially reordered findings",
        mutate: (misplaced) => {
          const first = misplaced[0].paragraph;
          misplaced[0].paragraph = misplaced[5].paragraph;
          misplaced[5].paragraph = first;
        },
      },
      {
        name: "missing in-cell marker",
        mutate: (misplaced, cell) => {
          cell.content = cell.content.filter((item: any) => item !== misplaced.at(-1));
        },
      },
      {
        name: "changed in-cell marker",
        mutate: (misplaced) => {
          misplaced.at(-1).paragraph.elements[0].textRun.content = `${COMPLETE_PREFIX}different\n`;
        },
      },
      {
        name: "duplicated in-cell marker",
        mutate: (misplaced, cell) => {
          cell.content = [...cell.content, structuredClone(misplaced.at(-1))];
        },
      },
      {
        name: "unsupported element",
        mutate: (misplaced) => {
          misplaced[0].paragraph.elements.push({
            inlineObjectElement: { inlineObjectId: "foreign-object" },
          });
        },
      },
    ];

    it.each(attempt47UnprovenCases)(
      "performs zero writes when the attempt-47 structure has $name",
      async ({ name, mutate }) => {
        const { result, adapter, calls } = setup({
          attempt47MergedHeading: true,
          mutate,
        });

        await expect(adapter.export(`${key}-attempt-47-${name}`, result)).rejects.toThrow(
          "Google Docs export structure mismatch",
        );
        expect(calls.batches).toHaveLength(0);
        expect(calls.driveCreate).toBe(0);
      },
    );

    it("performs zero writes when the attempt-47 Drive reservation changes before repair", async () => {
      const { result, adapter, calls } = setup(
        { attempt47MergedHeading: true },
        { reservedDocumentIds: ["doc-round-trip", "doc-round-trip", "replacement-document"] },
      );

      await expect(adapter.export(`${key}-attempt-47-reservation-changed`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails final verification if attempt-47 Drive metadata changes after the write", async () => {
      const result = historicalRendered();
      const corruption = historicalCorruptionDocument(result, {
        attempt47MergedHeading: true,
      });
      const verified = nativeDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document, verified],
        reservedContentHashes: [
          result.content_hash,
          result.content_hash,
          result.content_hash,
          "stale-content-hash",
        ],
      });

      await expect(adapter.export(`${key}-attempt-47-post-write-metadata`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails final verification if the repaired final cell remains heading-styled", async () => {
      const result = historicalRendered();
      const corruption = historicalCorruptionDocument(result, {
        attempt47MergedHeading: true,
      });
      const verified = nativeDocument(result) as any;
      const verifiedTable = verified.body.content.filter((item: any) => item.table).at(-1);
      const verifiedCell = verifiedTable.table.tableRows.at(-1).tableCells.at(-1);
      const verifiedParagraph = verifiedCell.content.find(
        (item: any) => item.paragraph && item.paragraph.elements?.length,
      );
      verifiedParagraph.paragraph.paragraphStyle.namedStyleType = "HEADING_2";
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document, verified],
      });

      await expect(adapter.export(`${key}-attempt-47-post-write-style`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
    });

    it("repairs the observed 65-operation suffix only when all five operations are exactly reversed", async () => {
      const { result, corruption, adapter, calls } = setup({ reverseMisplaced: true });
      const operations = result.operations as GoogleDocsOperation[];
      const suffix = operations.slice(corruption.tableOperationIndex + 1);

      expect(result.operation_count).toBe(65);
      expect(corruption.tableOperationIndex).toBe(59);
      const table = (corruption.document.body.content as any[])
        .filter((item: any) => item.table)
        .at(-1);
      expect(table.table.tableRows).toHaveLength(13);
      expect(table.table.tableRows[0].tableCells).toHaveLength(8);
      expect(suffix.map((operation) => operation.type)).toEqual([
        "paragraph",
        "list_item",
        "list_item",
        "list_item",
        "list_item",
      ]);
      expect(corruption.misplaced[0].paragraph.bullet).toBeDefined();
      expect(
        String(corruption.misplaced[0].paragraph.elements[0].textRun.content).startsWith(
          `${SEPARATOR}MOBELARIS_LIST:`,
        ),
      ).toBe(true);

      await expect(adapter.export(`${key}-exact-reversed`, result)).resolves.toMatchObject({
        external_document_id: "doc-round-trip",
        replayed: true,
      });
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
      expect(calls.writeControls).toEqual([{ requiredRevisionId: "revision-1" }]);
      const requests = calls.batches[0] as any[];
      const deletions = requests.filter((request) => request.deleteContentRange);
      expect(deletions).toHaveLength(30);
      expect(deletions[0].deleteContentRange.range).toEqual({
        startIndex: corruption.misplaced[0].startIndex,
        endIndex: corruption.misplaced.at(-1).endIndex,
      });
      expect(requests.some((request) => request.insertTable)).toBe(false);
      const inserted = requests.filter(
        (request) =>
          request.insertText && !String(request.insertText.text).startsWith(COMPLETE_PREFIX),
      );
      expect(inserted).toHaveLength(5);
      const markers = requests.filter((request) =>
        String(request.insertText?.text ?? "").startsWith(COMPLETE_PREFIX),
      );
      expect(markers).toHaveLength(0);
      const firstAllowedIndex = corruption.misplaced[0].startIndex - corruption.misplacedLength;
      for (const request of inserted)
        expect(request.insertText.location.index).toBeGreaterThanOrEqual(firstAllowedIndex);
    });

    it("logs a bounded content-free map proving every reversed misplaced operation", async () => {
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { result, adapter } = setup({ reverseMisplaced: true });

      await adapter.export(`${key}-reversed-mapping`, result);

      const log = output.find((line) =>
        line.includes("google_docs.historical_table_repair_started"),
      );
      expect(log).toContain('"misplaced_mapping_count":5');
      expect(log).toContain('"misplaced_mapping_truncated":false');
      expect(log).toContain(
        '"misplaced_structural_types":"paragraph,paragraph,paragraph,paragraph,paragraph"',
      );
      expect(log).toContain('"misplaced_text_lengths"');
      expect(log).toContain('"misplaced_bullet_states":"present,present,present,present,absent"');
      expect(log).toContain(
        '"misplaced_marker_states":"unordered,unordered,unordered,unordered,absent"',
      );
      expect(log).toContain('"misplaced_exact_expected_operation_indexes":"64,63,62,61,60"');
      expect(log).toContain('"decoder_order":"reversed"');
      expect(log).toContain('"reversed_suffix_recovery":true');
      const success = output.find((line) =>
        line.includes("google_docs.historical_table_repair_succeeded"),
      );
      expect(success).toContain('"operation_count":65');
      expect(success).toContain('"expected_operation_count":65');
      expect(success).toContain('"canonical_operations_match_expected":true');
      expect(log).not.toContain("Outstanding rejected findings");
      expect(log).not.toContain("Heading 4");
      expect(log).not.toContain("finding-4");
      expect(log).not.toContain("doc-round-trip");
      expect(log).not.toContain(result.render_hash);
      expect(log).not.toContain(result.content_hash);
      expect(log).not.toContain("access-token");
    });

    it("performs zero writes when the Drive reservation changes before repair", async () => {
      const { result, adapter, calls } = setup(
        { reverseMisplaced: true },
        { reservedDocumentIds: ["doc-round-trip", "doc-round-trip", "replacement-document"] },
      );

      await expect(adapter.export(`${key}-reservation-replaced`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("does not report a lost-response replay when the Drive reservation changed", async () => {
      const result = historicalRendered();
      const corruption = historicalCorruptionDocument(result, { reverseMisplaced: true });
      const verified = nativeDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document, verified],
        batchOk: false,
        reservedDocumentIds: [
          "doc-round-trip",
          "doc-round-trip",
          "doc-round-trip",
          "replacement-document",
        ],
      });

      await expect(
        adapter.export(`${key}-lost-response-reservation-replaced`, result),
      ).rejects.toThrow("idempotency conflict");
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
    });

    it("does not report a lost-response replay when the Drive hash binding changed", async () => {
      const result = historicalRendered();
      const corruption = historicalCorruptionDocument(result, { reverseMisplaced: true });
      const verified = nativeDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document, verified],
        batchOk: false,
        reservedContentHashes: [
          result.content_hash,
          result.content_hash,
          result.content_hash,
          "stale-content-hash",
        ],
      });

      await expect(adapter.export(`${key}-lost-response-hash-replaced`, result)).rejects.toThrow(
        "idempotency conflict",
      );
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
    });

    const reversedCorruptionCases: Array<{
      name: string;
      mutate: (misplaced: any[], cell: any) => void;
    }> = [
      {
        name: "altered",
        mutate: (misplaced) => {
          misplaced[0].paragraph.elements[0].textRun.content = "Changed operation\n";
        },
      },
      {
        name: "missing",
        mutate: (misplaced, cell) => {
          const missing = misplaced[2];
          cell.content = cell.content.filter((item: any) => item !== missing);
        },
      },
      {
        name: "extra",
        mutate: (_misplaced, cell) => {
          cell.content = [
            ...cell.content,
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "Unexpected operation\n" } }],
              },
            },
          ];
        },
      },
      {
        name: "duplicated",
        mutate: (misplaced, cell) => {
          cell.content = [...cell.content, structuredClone(misplaced[0])];
        },
      },
      {
        name: "partially reordered",
        mutate: (misplaced) => {
          const first = misplaced[0].paragraph;
          misplaced[0].paragraph = misplaced[1].paragraph;
          misplaced[1].paragraph = first;
        },
      },
      {
        name: "unsupported",
        mutate: (misplaced) => {
          misplaced[0].paragraph.elements.push({
            inlineObjectElement: { inlineObjectId: "foreign-object" },
          });
        },
      },
    ];

    it.each(reversedCorruptionCases)(
      "performs zero writes when the reversed suffix is $name",
      async ({ name, mutate }) => {
        const { result, adapter, calls } = setup({ reverseMisplaced: true, mutate });

        await expect(adapter.export(`${key}-reversed-${name}`, result)).rejects.toThrow(
          "Google Docs export structure mismatch",
        );
        expect(calls.batches).toHaveLength(0);
        expect(calls.driveCreate).toBe(0);
      },
    );

    it("repairs Google-normalised misplaced list paragraphs without requiring continuation markers", async () => {
      const { result, corruption, adapter, calls } = setup({ normaliseMisplacedLists: true });

      await expect(adapter.export(`${key}-normalised-list`, result)).resolves.toMatchObject({
        replayed: true,
      });
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
      const deletion = (calls.batches[0] as any[]).find((request) => request.deleteContentRange);
      expect(deletion.deleteContentRange.range).toEqual({
        startIndex: corruption.misplaced[0].startIndex,
        endIndex: corruption.misplaced.at(-1).endIndex,
      });
    });

    it("repairs the exact 65-operation, 13-by-8 shape when Google drops continuation bullet metadata", async () => {
      const { result, corruption, adapter, calls } = setup({
        normaliseMisplacedLists: true,
        omitContinuationBulletMetadata: true,
      });

      expect(result.operation_count).toBe(65);
      const table = (corruption.document.body.content as any[])
        .filter((item: any) => item.table)
        .at(-1);
      expect(table.table.tableRows).toHaveLength(13);
      expect(table.table.tableRows[0].tableCells).toHaveLength(8);

      await expect(
        adapter.export(`${key}-bulletless-continuations`, result),
      ).resolves.toMatchObject({
        external_document_id: "doc-round-trip",
        replayed: true,
      });
      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed when a Google-normalised list continuation changes", async () => {
      const { result, adapter, calls } = setup({
        normaliseMisplacedLists: true,
        mutate: (misplaced) => {
          const continuation = misplaced.find((item, index) => index > 0 && item.paragraph?.bullet);
          continuation.paragraph.elements[0].textRun.content = "Changed continuation\n";
        },
      });

      await expect(adapter.export(`${key}-changed-continuation`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("reports the exact bulletless-continuation rejection without logging content", async () => {
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { result, adapter, calls } = setup({
        normaliseMisplacedLists: true,
        omitContinuationBulletMetadata: true,
        mutate: (misplaced) => {
          const continuation = misplaced.find(
            (item, index) => index > 0 && item.paragraph && !item.paragraph.bullet,
          );
          continuation.paragraph.elements[0].textRun.content = "Private changed continuation\n";
        },
      });

      await expect(adapter.export(`${key}-diagnostic`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
      const log = output.find((line) => line.includes("google_docs.provider_failed"));
      expect(log).toContain('"stage":"docs_historical_table_repair"');
      expect(log).toContain('"reason":"misplaced_suffix_not_decodable"');
      expect(log).toContain('"decoder_rejection_reason":"no_supported_suffix_order_match"');
      expect(log).toContain('"forward_decoder_rejection_reason":"list_text_mismatch"');
      expect(log).toContain(
        '"reverse_decoder_rejection_reason":"first_list_paragraph_missing_bullet"',
      );
      expect(log).toContain('"expected_operation_index":61');
      expect(log).toContain('"expected_operation_type":"list_item"');
      expect(log).toContain('"actual_misplaced_paragraph_index":2');
      expect(log).toContain('"actual_structural_type":"paragraph"');
      expect(log).toContain('"bullet_metadata_present":false');
      expect(log).toContain('"list_marker_present":false');
      expect(log).toContain('"paragraph_count_consumed":2');
      expect(log).toContain('"span_count":0');
      expect(log).toContain('"span_style_categories":"none"');
      expect(log).toContain('"text_length_matches_expected":false');
      expect(log).toContain('"text_hash_matches_expected":false');
      expect(log).not.toContain("Private changed continuation");
      expect(log).not.toContain("doc-round-trip");
      expect(log).not.toContain(result.render_hash);
      expect(log).not.toContain(result.content_hash);
      expect(log).not.toContain("access-token");
    });

    it("repairs the proven corruption in place: deletes only the misplaced suffix and appends the rest", async () => {
      const { result, corruption, adapter, calls } = setup();

      await expect(adapter.export(key, result)).resolves.toMatchObject({
        external_document_id: "doc-round-trip",
        replayed: true,
      });

      expect(calls.batches).toHaveLength(1);
      expect(calls.driveCreate).toBe(0);
      const requests = calls.batches[0] as any[];

      // Exactly one deletion, covering only the misplaced cell range.
      const deletions = requests.filter((request) => request.deleteContentRange);
      expect(deletions).toHaveLength(30);
      expect(deletions[0].deleteContentRange.range).toEqual({
        startIndex: corruption.misplaced[0].startIndex,
        endIndex: corruption.misplaced.at(-1).endIndex,
      });

      // Revision-fenced.
      expect(calls.writeControls[0]).toEqual({ requiredRevisionId: "revision-1" });

      // Exactly the operations after the table, plus exactly one marker.
      const markers = requests.filter((request) =>
        String(request.insertText?.text ?? "").startsWith(COMPLETE_PREFIX),
      );
      expect(markers).toHaveLength(0);
      const expectedSuffix = (result.operations as GoogleDocsOperation[]).slice(
        corruption.tableOperationIndex + 1,
      );
      const inserted = requests.filter(
        (request) =>
          request.insertText &&
          !String(request.insertText.text).startsWith(COMPLETE_PREFIX) &&
          !request.deleteContentRange,
      );
      expect(inserted).toHaveLength(expectedSuffix.length);

      // Operations 0..table are never rewritten: no insert lands before the
      // deletion point, and no table is recreated.
      expect(requests.some((request) => request.insertTable)).toBe(false);
      const deletionStart = deletions[0].deleteContentRange.range.startIndex as number;
      for (const request of inserted)
        expect(request.insertText.location.index).toBeGreaterThanOrEqual(
          deletionStart - corruption.misplacedLength,
        );
    });

    it("performs zero writes when a repeated retry finds the repair already complete", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const { adapter, calls } = repairAdapter(nativeDocument(result), {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
      });
      await expect(adapter.export(key, result)).resolves.toMatchObject({ replayed: true });
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed with no write when reserved Drive metadata does not match", async () => {
      const { result, adapter, calls } = setup(
        {},
        { contentHash: undefined, renderHash: undefined },
      );
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed with no write when the revision changes before the guarded repair", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const first = historicalCorruptionDocument(result, { revisionId: "revision-1" });
      const moved = historicalCorruptionDocument(result, { revisionId: "revision-2" });
      const { adapter, calls } = repairAdapter(first.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [first.document, moved.document],
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails closed when the misplaced suffix does not decode to the expected operations", async () => {
      const { result, adapter, calls } = setup({
        mutate: (misplaced) => {
          const run = misplaced.at(-1).paragraph.elements[0].textRun;
          run.content = `Not an expected operation\n`;
        },
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails closed when the misplaced suffix is reordered", async () => {
      const { result, adapter, calls } = setup({
        mutate: (misplaced) => {
          if (misplaced.length < 2) throw new Error("fixture needs at least two misplaced items");
          const first = misplaced[0].paragraph;
          misplaced[0].paragraph = misplaced[1].paragraph;
          misplaced[1].paragraph = first;
        },
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails closed when a misplaced paragraph is duplicated", async () => {
      const { result, adapter, calls } = setup({
        mutate: (misplaced, cell) => {
          cell.content = [...cell.content, structuredClone(misplaced.at(-1))];
        },
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails closed with zero writes when a misplaced paragraph is missing", async () => {
      const { result, adapter, calls } = setup({
        normaliseMisplacedLists: true,
        omitContinuationBulletMetadata: true,
        mutate: (misplaced, cell) => {
          const missing = misplaced.at(-1);
          cell.content = cell.content.filter((item: any) => item !== missing);
        },
      });
      await expect(adapter.export(`${key}-missing`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed with zero writes when a misplaced paragraph is extra", async () => {
      const { result, adapter, calls } = setup({
        mutate: (_misplaced, cell) => {
          cell.content = [
            ...cell.content,
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "Unexpected extra paragraph\n" } }],
              },
            },
          ];
        },
      });
      await expect(adapter.export(`${key}-extra`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed with zero writes on unsupported misplaced content", async () => {
      const { result, adapter, calls } = setup({
        mutate: (misplaced) => {
          misplaced[0].paragraph.elements.push({
            inlineObjectElement: { inlineObjectId: "foreign-object" },
          });
        },
      });
      await expect(adapter.export(`${key}-unsupported`, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
      expect(calls.driveCreate).toBe(0);
    });

    it("fails closed when another table cell also differs", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const corruption = historicalCorruptionDocument(result);
      const rows = (corruption.document.body.content as any[]).find((item: any) => item.table).table
        .tableRows;
      const firstCell = rows[0].tableCells[0];
      firstCell.content[0].paragraph.elements[0].textRun.content = "Tampered header\n";
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        rereads: [corruption.document, corruption.document],
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails closed when a completion marker is hidden inside the misplaced suffix", async () => {
      const { result, adapter, calls } = setup({
        mutate: (misplaced) => {
          misplaced.at(-1).paragraph.elements[0].textRun.content = `${COMPLETE_PREFIX}unexpected\n`;
        },
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(0);
    });

    it("fails post-repair verification when the reread is not exactly the frozen export", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const corruption = historicalCorruptionDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        // The repair is accepted, but the document still does not verify.
        rereads: [corruption.document, corruption.document, nativeDocument(result)],
      });
      await expect(adapter.export(key, result)).rejects.toThrow(
        "Google Docs export structure mismatch",
      );
      expect(calls.batches).toHaveLength(1);
    });

    it("treats a lost repair response as a replay only when the reread proves exact success", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const corruption = historicalCorruptionDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        batchOk: false,
        rereads: [
          corruption.document,
          corruption.document,
          nativeDocument(result),
          nativeDocument(result),
          nativeDocument(result),
        ],
      });
      await expect(adapter.export(key, result)).resolves.toMatchObject({ replayed: true });
      // Exactly one attempted write, never a second.
      expect(calls.batches).toHaveLength(1);
    });

    it("fails closed after a rejected repair whose reread does not prove success", async () => {
      const result = rendered({ rejected_findings: [rejectedFinding()] });
      const corruption = historicalCorruptionDocument(result);
      const { adapter, calls } = repairAdapter(corruption.document, {
        contentHash: result.content_hash,
        renderHash: result.render_hash,
        batchOk: false,
        rereads: [corruption.document, corruption.document, corruption.document],
      });
      await expect(adapter.export(key, result)).rejects.toThrow();
      expect(calls.batches).toHaveLength(1);
    });

    it("logs only bounded safe metadata for the repair", async () => {
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { result, adapter } = setup();
      await adapter.export(key, result);
      const logs = output.filter((line) => line.includes("historical_table_repair"));
      expect(logs.length).toBeGreaterThan(0);
      const joined = logs.join("\n");
      expect(joined).toContain('"historical_repair_eligible":true');
      expect(joined).toContain('"revision_fence_present":true');
      expect(joined).toContain('"reserved_document_reused":true');
      expect(joined).toContain('"misplaced_paragraph_count"');
      expect(joined).toContain('"table_row_count"');
      // No content, identifiers, URLs, hashes or credentials.
      expect(joined).not.toContain("Wishbone");
      expect(joined).not.toContain("hardwood");
      expect(joined).not.toContain("doc-round-trip");
      expect(joined).not.toContain("docs.google.com");
      expect(joined).not.toContain(result.render_hash);
      expect(joined).not.toContain(result.content_hash);
      expect(joined).not.toContain("access-token");
      expect(joined).not.toContain("Authorization");
      expect(joined).not.toContain("revision-1");
    });
  });

  it("rejects an unreadable document shape without echoing Google's payload", async () => {
    const result = rendered();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const unreadable = {
      documentId: null,
      body: { content: null },
      unexpected: "sensitive-google-payload",
    };
    const { adapter } = adapterAgainst(unreadable, {
      empty: true,
      afterBatchDocument: unreadable,
      reservedAppProperties: {
        mobelaris_content_hash: result.content_hash,
        mobelaris_render_hash: result.render_hash,
      },
    });
    await expect(adapter.export("schema-key", result)).rejects.toThrow(
      "Google Docs export structure mismatch",
    );
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"reason":"document_schema_invalid"');
    expect(log).toContain('"issue_count":2');
    expect(log).toContain('"nullable_issue_count":2');
    expect(log).toContain('"issue_path_counts":"body.content=1,documentId=1"');
    expect(log).toContain('"expected_received_counts":"array<-null=1,string<-null=1"');
    expect(log).not.toContain("sensitive-google-payload");
  });
});

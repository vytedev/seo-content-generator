import type { GoogleDocsOperation } from "../../shared/export.js";

/**
 * Semantic export components and a reread-driven batch planner.
 *
 * The previous writer emitted every request for a document in one pass, deriving
 * every absolute index from source text lengths and two hand-derived table
 * formulas. A single wrong delta shifted every later request, and because
 * `batchUpdate` validates atomically the whole export failed - which is why each
 * new article shape surfaced another failure and another arithmetic patch.
 *
 * Here, positions Google owns come from Google:
 *
 *   - the append position is the reread document's trailing paragraph;
 *   - a table's own start index is read back from the document, never derived;
 *   - each cell's paragraph start index is read back, never derived.
 *
 * The only arithmetic that remains is within a single string this module itself
 * authored in a single request, which is exact regardless of document shape.
 *
 * `planNextBatch` is a pure function of the document as it currently stands, so
 * every phase is idempotent and resumable by construction: the canonical prefix
 * already in the document is the checkpoint, and no separate progress state can
 * drift away from it.
 */

export const DOCS_LINE_BREAK = "\u000b";
/** Authored line breaks stay inside one paragraph; a real newline would split it. */
export const toDocsText = (value: string) => value.replaceAll("\n", DOCS_LINE_BREAK);
export const fromDocsText = (value: string) => value.replaceAll(DOCS_LINE_BREAK, "\n");

export const BODY_TEXT_COLOUR = {
  color: { rgbColor: { red: 0.145, green: 0.122, blue: 0.106 } },
};

/** Raised when the document cannot be advanced towards the target safely. */
export class GoogleDocsWriteConflictError extends Error {
  override readonly name = "GoogleDocsWriteConflictError";
  constructor(
    readonly reason: string,
    readonly detail: Record<string, string | number | boolean> = {},
  ) {
    super(`Google Docs write conflict: ${reason}`);
  }
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: "bold" | "italic" | "code" | "link";
  readonly target?: string | undefined;
}
interface Rich {
  readonly text: string;
  readonly spans?: readonly Span[] | undefined;
}

const FONT_SIZE: Record<string, number> = {
  TITLE: 22,
  HEADING_1: 19,
  HEADING_2: 15,
  HEADING_3: 13,
  NORMAL_TEXT: 11,
  TABLE_HEADER: 9.5,
  TABLE_BODY: 9,
};

/** Inline emphasis, code and links, positioned from a caller-supplied content start. */
function spanRequests(contentStart: number, rich: Rich): unknown[] {
  return (rich.spans ?? []).map((span) => ({
    updateTextStyle: {
      range: { startIndex: contentStart + span.start, endIndex: contentStart + span.end },
      textStyle:
        span.kind === "link"
          ? { link: { url: span.target } }
          : span.kind === "bold"
            ? { bold: true }
            : span.kind === "italic"
              ? { italic: true }
              : { weightedFontFamily: { fontFamily: "Roboto Mono" } },
      fields:
        span.kind === "link" ? "link" : span.kind === "code" ? "weightedFontFamily" : span.kind,
    },
  }));
}

function typographyRequest(contentStart: number, rich: Rich, role: string): unknown[] {
  const length = toDocsText(rich.text).length;
  if (length === 0) return [];
  const heading = role === "TITLE" || role.startsWith("HEADING_");
  return [
    {
      updateTextStyle: {
        range: { startIndex: contentStart, endIndex: contentStart + length },
        textStyle: {
          weightedFontFamily: { fontFamily: "Arial" },
          fontSize: { magnitude: FONT_SIZE[role] ?? FONT_SIZE.NORMAL_TEXT, unit: "PT" },
          bold: heading || role === "TABLE_HEADER",
          foregroundColor: BODY_TEXT_COLOUR,
        },
        fields: "weightedFontFamily,fontSize,bold,foregroundColor",
      },
    },
  ];
}

/**
 * One semantic component per canonical operation that occupies a single
 * top-level paragraph. Each declares the text it contributes and how it is
 * decorated once its real position is known; neither depends on any other
 * operation, so any ordering of any shapes composes.
 */
interface ParagraphComponent {
  /** Leading tabs consumed by createParagraphBullets to establish nesting. */
  readonly tabs: number;
  /** The authored text, line breaks already encoded. */
  readonly text: string;
  /** Requests applied once the paragraph's real start index is known. */
  decorate(paragraphStart: number, contentStart: number): unknown[];
}

function paragraphComponent(operation: GoogleDocsOperation): ParagraphComponent | null {
  if (operation.type === "table") return null;
  const text = toDocsText(operation.text);
  const full = (start: number, length: number) => ({
    startIndex: start,
    endIndex: start + length,
  });

  if (operation.type === "paragraph") {
    const style = operation.style;
    return {
      tabs: 0,
      text,
      decorate: (paragraphStart, contentStart) => [
        {
          updateParagraphStyle: {
            range: full(paragraphStart, text.length + 1),
            paragraphStyle: {
              namedStyleType: style,
              spaceAbove: {
                magnitude: style === "TITLE" ? 12 : style.startsWith("HEADING_") ? 10 : 0,
                unit: "PT",
              },
              spaceBelow: { magnitude: style === "NORMAL_TEXT" ? 6 : 8, unit: "PT" },
            },
            fields: "namedStyleType,spaceAbove,spaceBelow",
          },
        },
        ...typographyRequest(contentStart, operation, style),
        ...spanRequests(contentStart, operation),
      ],
    };
  }

  if (operation.type === "blockquote")
    return {
      tabs: 0,
      text,
      decorate: (paragraphStart, contentStart) => [
        {
          updateParagraphStyle: {
            range: full(paragraphStart, text.length + 1),
            paragraphStyle: {
              namedStyleType: "NORMAL_TEXT",
              indentStart: { magnitude: 18, unit: "PT" },
              spaceAbove: { magnitude: 6, unit: "PT" },
              spaceBelow: { magnitude: 6, unit: "PT" },
            },
            fields: "namedStyleType,indentStart,spaceAbove,spaceBelow",
          },
        },
        ...typographyRequest(contentStart, operation, "NORMAL_TEXT"),
        ...spanRequests(contentStart, operation),
      ],
    };

  if (operation.type === "list_item") {
    const tabs = operation.nesting_level ?? 0;
    const ordered = operation.ordered;
    return {
      tabs,
      text,
      decorate: (paragraphStart, contentStart) => [
        ...typographyRequest(contentStart, operation, "NORMAL_TEXT"),
        ...spanRequests(contentStart, operation),
        // Last for this paragraph: it consumes the leading tabs, which shortens
        // the paragraph. Decoration runs in reverse document order so the
        // paragraphs still to be decorated are all earlier and unaffected.
        {
          createParagraphBullets: {
            range: full(paragraphStart, tabs + text.length + 1),
            bulletPreset: ordered ? "NUMBERED_DECIMAL_NESTED" : "BULLET_DISC_CIRCLE_SQUARE",
          },
        },
      ],
    };
  }

  // image_marker: plain text, no decoration beyond body typography.
  return {
    tabs: 0,
    text,
    decorate: (_paragraphStart, contentStart) =>
      typographyRequest(contentStart, operation, "NORMAL_TEXT"),
  };
}

/** A table cell's real paragraph position, taken from the reread document. */
export interface CellSlot {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly paragraphStart: number;
  readonly textLength: number;
}
export interface TableSlot {
  readonly startIndex: number;
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly CellSlot[];
}

/**
 * Reads every table's real geometry out of the document Google returned.
 *
 * Nothing here derives a position: `startIndex` on the table, and on each cell's
 * first paragraph, is exactly what the API reported.
 */
export function tableSlotsFromDocument(document: unknown): TableSlot[] {
  const content = (document as any)?.body?.content ?? [];
  const slots: TableSlot[] = [];
  for (const item of content) {
    if (!item?.table) continue;
    const rows = item.table.tableRows ?? [];
    const cells: CellSlot[] = [];
    rows.forEach((row: any, rowIndex: number) =>
      (row.tableCells ?? []).forEach((cell: any, columnIndex: number) => {
        const paragraph = (cell.content ?? []).find((entry: any) => entry?.paragraph);
        if (!paragraph || !Number.isInteger(paragraph.startIndex))
          throw new GoogleDocsWriteConflictError("table_cell_paragraph_missing", {
            table_row: rowIndex,
            table_column: columnIndex,
          });
        const textLength = (paragraph.paragraph.elements ?? [])
          .map((element: any) => String(element.textRun?.content ?? ""))
          .join("")
          .replace(/\n$/, "").length;
        cells.push({
          rowIndex,
          columnIndex,
          paragraphStart: paragraph.startIndex,
          textLength,
        });
      }),
    );
    if (!Number.isInteger(item.startIndex))
      throw new GoogleDocsWriteConflictError("table_start_index_missing");
    slots.push({
      startIndex: item.startIndex,
      rows: rows.length,
      columns: rows[0]?.tableCells?.length ?? 0,
      cells,
    });
  }
  return slots;
}

export type NextBatch =
  | {
      readonly phase: "text_run";
      readonly requests: unknown[];
      readonly operationCount: number;
    }
  | { readonly phase: "table_skeleton"; readonly requests: unknown[]; readonly operationCount: 0 }
  | { readonly phase: "table_fill"; readonly requests: unknown[]; readonly operationCount: 1 };

/**
 * One insertText carrying a whole run of paragraphs, then their decoration in
 * reverse document order.
 *
 * Every index here is an offset inside a single string this function authored,
 * placed at an append position Google reported. No document geometry is assumed,
 * so the run composes with whatever precedes or follows it.
 */
function textRunBatch(operations: readonly GoogleDocsOperation[], appendIndex: number): NextBatch {
  const components = operations.map((operation) => {
    const component = paragraphComponent(operation);
    if (!component)
      throw new GoogleDocsWriteConflictError("text_run_contains_table", { type: operation.type });
    return component;
  });
  const text = components
    .map((component) => `${"\t".repeat(component.tabs)}${component.text}\n`)
    .join("");
  const requests: unknown[] = [{ insertText: { location: { index: appendIndex }, text } }];

  const starts: number[] = [];
  let cursor = appendIndex;
  for (const component of components) {
    starts.push(cursor);
    cursor += component.tabs + component.text.length + 1;
  }
  // Reverse: a paragraph's bullet request consumes its leading tabs and shifts
  // everything after it, and everything after it is already decorated.
  for (let index = components.length - 1; index >= 0; index -= 1) {
    const component = components[index]!;
    const paragraphStart = starts[index]!;
    requests.push(...component.decorate(paragraphStart, paragraphStart + component.tabs));
  }
  return { phase: "text_run", requests, operationCount: operations.length };
}

/** Fills an existing table using only the indexes Google reported for its cells. */
function tableFillBatch(slot: TableSlot, operation: GoogleDocsOperation): NextBatch {
  if (operation.type !== "table")
    throw new GoogleDocsWriteConflictError("table_fill_target_not_table");
  if (slot.rows !== operation.rows.length || slot.columns !== (operation.rows[0]?.length ?? 0))
    throw new GoogleDocsWriteConflictError("table_dimensions_mismatch", {
      document_rows: slot.rows,
      document_columns: slot.columns,
      expected_rows: operation.rows.length,
      expected_columns: operation.rows[0]?.length ?? 0,
    });
  const requests: unknown[] = [];
  // Reverse cell order so an insertion never moves a cell still to be filled.
  for (const cell of [...slot.cells].reverse()) {
    const rich = operation.rows[cell.rowIndex]?.[cell.columnIndex];
    if (!rich) throw new GoogleDocsWriteConflictError("table_cell_out_of_bounds");
    if (cell.textLength > 0)
      throw new GoogleDocsWriteConflictError("table_cell_already_populated", {
        table_row: cell.rowIndex,
        table_column: cell.columnIndex,
      });
    const text = toDocsText(rich.text);
    if (!text) continue;
    const role = cell.rowIndex === 0 ? "TABLE_HEADER" : "TABLE_BODY";
    requests.push({ insertText: { location: { index: cell.paragraphStart }, text } });
    requests.push(...typographyRequest(cell.paragraphStart, rich, role));
    requests.push(...spanRequests(cell.paragraphStart, rich));
  }
  const tableCellLocation = (rowIndex: number) => ({
    tableStartLocation: { index: slot.startIndex },
    rowIndex,
    columnIndex: 0,
  });
  requests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: tableCellLocation(0),
        rowSpan: slot.rows,
        columnSpan: slot.columns,
      },
      tableCellStyle: {
        contentAlignment: "TOP",
        paddingTop: { magnitude: 5, unit: "PT" },
        paddingBottom: { magnitude: 5, unit: "PT" },
        paddingLeft: { magnitude: 5, unit: "PT" },
        paddingRight: { magnitude: 5, unit: "PT" },
      },
      fields: "contentAlignment,paddingTop,paddingBottom,paddingLeft,paddingRight",
    },
  });
  requests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: tableCellLocation(0),
        rowSpan: 1,
        columnSpan: slot.columns,
      },
      tableCellStyle: {
        backgroundColor: { color: { rgbColor: { red: 0.93, green: 0.91, blue: 0.88 } } },
      },
      fields: "backgroundColor",
    },
  });
  requests.push({
    pinTableHeaderRows: {
      tableStartLocation: { index: slot.startIndex },
      pinnedHeaderRowsCount: 1,
    },
  });
  return { phase: "table_fill", requests, operationCount: 1 };
}

export interface PlanInput {
  /** The document exactly as Google returned it on the most recent read. */
  readonly document: unknown;
  /** Canonical operations reconstructed from that document. */
  readonly present: readonly unknown[];
  /** The immutable canonical operations this export must produce. */
  readonly target: readonly GoogleDocsOperation[];
  /** The reread trailing paragraph: where new content is appended. */
  readonly appendIndex: number;
  /** Largest number of paragraphs to place in one request. */
  readonly maxRunLength?: number;
}

/**
 * Decides the next batch from the document as it currently stands.
 *
 * Returns `null` when the document already carries every target operation. The
 * caller reads, plans, writes under revision fencing, and reads again; because
 * this is a pure function of the document, an interrupted export resumes simply
 * by planning again from whatever is actually there.
 */
export function planNextBatch(input: PlanInput): NextBatch | null {
  const { present, target } = input;
  const limit = Math.min(present.length, target.length);
  let matched = 0;
  while (
    matched < limit &&
    JSON.stringify(present[matched]) === JSON.stringify(JSON.parse(JSON.stringify(target[matched])))
  )
    matched += 1;

  if (matched === target.length) {
    if (present.length === target.length) return null;
    throw new GoogleDocsWriteConflictError("document_has_unexpected_trailing_operations", {
      operation_count: present.length,
      expected_operation_count: target.length,
    });
  }

  const next = target[matched]!;
  const extra = present.length - matched;

  if (extra === 0) {
    if (next.type === "table")
      return {
        phase: "table_skeleton",
        operationCount: 0,
        requests: [
          {
            insertTable: {
              rows: next.rows.length,
              columns: next.rows[0]!.length,
              location: { index: input.appendIndex },
            },
          },
        ],
      };
    const run: GoogleDocsOperation[] = [];
    const max = input.maxRunLength ?? Number.POSITIVE_INFINITY;
    for (let index = matched; index < target.length && run.length < max; index += 1) {
      const operation = target[index]!;
      if (operation.type === "table") break;
      run.push(operation);
    }
    return textRunBatch(run, input.appendIndex);
  }

  // Exactly one unexpected trailing operation, and it is the empty table
  // skeleton this planner just created: fill it from its reported geometry.
  if (extra === 1 && next.type === "table") {
    const slots = tableSlotsFromDocument(input.document);
    const slot = slots[slots.length - 1];
    if (!slot) throw new GoogleDocsWriteConflictError("table_skeleton_missing");
    return tableFillBatch(slot, next);
  }

  throw new GoogleDocsWriteConflictError("document_diverges_from_export", {
    matching_prefix_operation_count: matched,
    operation_count: present.length,
    expected_operation_count: target.length,
  });
}

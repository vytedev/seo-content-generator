/**
 * An independent, executable model of the Google Docs structural rules.
 *
 * This exists because the previous test doubles captured the emitted
 * `batchUpdate` requests and returned HTTP 200 unconditionally. They proved the
 * adapter agreed with a copy of its own index arithmetic, which is why every new
 * article shape found a new failure only in production.
 *
 * This simulator is a TEST ORACLE, never a source of production indexes. It
 * applies requests to a real document model and rejects invalid positions the
 * way Google does, so an off-by-one fails locally instead of at the API.
 *
 * The rules implemented here are Google's documented ones:
 *   - the body always ends with a paragraph;
 *   - `insertText` must address a character position inside an existing
 *     paragraph, never a structural boundary such as a table or row start;
 *   - `insertTable` inserts a newline before the table, so the table's own
 *     start is the requested index + 1;
 *   - a table occupies 1 + rows × (1 + 2 × columns) indexes;
 *   - `createParagraphBullets` consumes the leading tabs that set nesting,
 *     which shortens the paragraph and moves everything after it;
 *   - `batchUpdate` applies requests sequentially and validates each one against
 *     the document as it stands at that point.
 */

/** Mirrors the shape of a Google API 400 so adapter error classification is exercised too. */
export class SimulatedGoogleApiError extends Error {
  constructor(
    readonly requestIndex: number,
    readonly requestType: string,
    readonly detail: string,
  ) {
    super(`Invalid requests[${requestIndex}].${requestType}: ${detail}`);
    this.name = "SimulatedGoogleApiError";
  }
}

interface Run {
  content: string;
  textStyle: Record<string, unknown>;
}
interface Paragraph {
  runs: Run[];
  paragraphStyle: Record<string, unknown>;
  bullet?: { listId: string; nestingLevel: number };
}
interface Cell {
  content: Paragraph[];
}
interface Table {
  rows: Cell[][];
}
type Element = { kind: "paragraph"; paragraph: Paragraph } | { kind: "table"; table: Table };

const paragraphText = (paragraph: Paragraph) => paragraph.runs.map((run) => run.content).join("");
const emptyParagraph = (): Paragraph => ({
  runs: [{ content: "\n", textStyle: {} }],
  paragraphStyle: {},
});

/** Where a given index falls, so validation can distinguish text from structure. */
interface ParagraphSlot {
  paragraph: Paragraph;
  start: number;
  /** Exclusive; the trailing newline occupies end - 1. */
  end: number;
}

export interface SimulatorOptions {
  /** Presets the adapter is allowed to use, mapped to Google's list metadata. */
  readonly bulletPresets?: Readonly<Record<string, "ordered" | "unordered">>;
  /**
   * Table geometry variant.
   *
   * Nothing in this repository is independent ground truth for Google's exact
   * table index layout - the implementation, its tests and its fixtures all
   * restate the same formula, which is why the same class of failure kept
   * reaching production. Rather than enshrine one more guess, the simulator can
   * present more than one plausible geometry.
   *
   * A writer that takes its positions from a reread is correct under every
   * variant. A writer that predicts them passes only the variant it happens to
   * assume. That difference is the acceptance property for this adapter.
   */
  readonly tableGeometry?: TableGeometry;
}

export interface TableGeometry {
  /** Google documents a newline inserted before the table; vary it to prove independence. */
  readonly newlineBeforeTable: boolean;
  /** Extra structural indexes consumed by a row before its first cell. */
  readonly rowOverhead: number;
  /** Extra structural indexes consumed by a cell before its first paragraph. */
  readonly cellOverhead: number;
}

export const DEFAULT_TABLE_GEOMETRY: TableGeometry = {
  newlineBeforeTable: true,
  rowOverhead: 1,
  cellOverhead: 1,
};

/** Plausible alternative layouts. Production must pass under all of them. */
export const TABLE_GEOMETRY_VARIANTS: ReadonlyArray<readonly [string, TableGeometry]> = [
  ["documented", DEFAULT_TABLE_GEOMETRY],
  ["no newline before table", { ...DEFAULT_TABLE_GEOMETRY, newlineBeforeTable: false }],
  ["wider row overhead", { ...DEFAULT_TABLE_GEOMETRY, rowOverhead: 2 }],
  ["wider cell overhead", { ...DEFAULT_TABLE_GEOMETRY, cellOverhead: 2 }],
];

const DEFAULT_PRESETS: Record<string, "ordered" | "unordered"> = {
  NUMBERED_DECIMAL_NESTED: "ordered",
  BULLET_DISC_CIRCLE_SQUARE: "unordered",
};

export class GoogleDocsSimulator {
  private elements: Element[] = [{ kind: "paragraph", paragraph: emptyParagraph() }];
  private readonly lists = new Map<string, "ordered" | "unordered">();
  private listCounter = 0;
  private revision = 1;
  private readonly presets: Record<string, "ordered" | "unordered">;
  private readonly geometry: TableGeometry;

  constructor(
    readonly documentId = "simulated-document",
    options: SimulatorOptions = {},
  ) {
    this.presets = { ...DEFAULT_PRESETS, ...(options.bulletPresets ?? {}) };
    this.geometry = options.tableGeometry ?? DEFAULT_TABLE_GEOMETRY;
  }

  get revisionId(): string {
    return `revision-${this.revision}`;
  }

  /** Every paragraph in document order with its absolute index range. */
  private slots(): ParagraphSlot[] {
    const slots: ParagraphSlot[] = [];
    let cursor = 1;
    for (const element of this.elements) {
      if (element.kind === "paragraph") {
        const length = paragraphText(element.paragraph).length;
        slots.push({ paragraph: element.paragraph, start: cursor, end: cursor + length });
        cursor += length;
        continue;
      }
      cursor += 1; // the table element itself
      for (const row of element.table.rows) {
        cursor += this.geometry.rowOverhead;
        for (const cell of row) {
          cursor += this.geometry.cellOverhead;
          for (const paragraph of cell.content) {
            const length = paragraphText(paragraph).length;
            slots.push({ paragraph, start: cursor, end: cursor + length });
            cursor += length;
          }
        }
      }
    }
    return slots;
  }

  /** Absolute start index of each table element, used to validate table requests. */
  private tableStarts(): Map<number, Table> {
    const starts = new Map<number, Table>();
    let cursor = 1;
    for (const element of this.elements) {
      if (element.kind === "paragraph") {
        cursor += paragraphText(element.paragraph).length;
        continue;
      }
      starts.set(cursor, element.table);
      cursor += 1;
      for (const row of element.table.rows) {
        cursor += this.geometry.rowOverhead;
        for (const cell of row) {
          cursor += this.geometry.cellOverhead;
          for (const paragraph of cell.content) cursor += paragraphText(paragraph).length;
        }
      }
    }
    return starts;
  }

  /** The end of the body: what `marker_insertion_index` resolves to on a reread. */
  get endIndex(): number {
    const slots = this.slots();
    return slots.length ? slots[slots.length - 1]!.end : 1;
  }

  private locate(index: number, requestIndex: number, requestType: string): ParagraphSlot {
    // A character position inside a paragraph, including immediately before its
    // trailing newline. Anything else is a structural boundary.
    const slot = this.slots().find((item) => index >= item.start && index <= item.end - 1);
    if (!slot)
      throw new SimulatedGoogleApiError(
        requestIndex,
        requestType,
        `The index ${index} does not address a paragraph in the document`,
      );
    return slot;
  }

  private replaceParagraph(target: Paragraph, replacement: Paragraph[]): void {
    for (const element of this.elements) {
      if (element.kind === "paragraph") {
        if (element.paragraph === target) {
          const position = this.elements.indexOf(element);
          this.elements.splice(
            position,
            1,
            ...replacement.map((paragraph) => ({ kind: "paragraph" as const, paragraph })),
          );
          return;
        }
        continue;
      }
      for (const row of element.table.rows)
        for (const cell of row) {
          const position = cell.content.indexOf(target);
          if (position >= 0) {
            cell.content.splice(position, 1, ...replacement);
            return;
          }
        }
    }
    throw new Error("simulator: paragraph is not attached to the document");
  }

  /** Splits a paragraph's text at an offset, preserving per-character styling. */
  private static styledCharacters(paragraph: Paragraph) {
    return paragraph.runs.flatMap((run) =>
      [...run.content].map((character) => ({ character, textStyle: run.textStyle })),
    );
  }

  private static fromCharacters(
    characters: Array<{ character: string; textStyle: Record<string, unknown> }>,
    template: Paragraph,
  ): Paragraph {
    const runs: Run[] = [];
    for (const item of characters) {
      const last = runs[runs.length - 1];
      if (last && JSON.stringify(last.textStyle) === JSON.stringify(item.textStyle))
        last.content += item.character;
      else runs.push({ content: item.character, textStyle: { ...item.textStyle } });
    }
    return {
      runs: runs.length ? runs : [{ content: "", textStyle: {} }],
      paragraphStyle: { ...template.paragraphStyle },
      ...(template.bullet ? { bullet: { ...template.bullet } } : {}),
    };
  }

  private insertText(index: number, text: string, requestIndex: number): void {
    if (text.length === 0)
      throw new SimulatedGoogleApiError(requestIndex, "insertText", "The text must not be empty");
    const slot = this.locate(index, requestIndex, "insertText");
    const characters = GoogleDocsSimulator.styledCharacters(slot.paragraph);
    const offset = index - slot.start;
    const inserted = [...text].map((character) => ({ character, textStyle: {} }));
    const merged = [...characters.slice(0, offset), ...inserted, ...characters.slice(offset)];
    // A newline splits the paragraph, exactly as typing one does.
    const pieces: Array<typeof merged> = [[]];
    for (const item of merged) {
      pieces[pieces.length - 1]!.push(item);
      if (item.character === "\n" && item !== merged[merged.length - 1]) pieces.push([]);
    }
    this.replaceParagraph(
      slot.paragraph,
      pieces.map((piece) => GoogleDocsSimulator.fromCharacters(piece, slot.paragraph)),
    );
  }

  private insertTable(index: number, rows: number, columns: number, requestIndex: number): void {
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1)
      throw new SimulatedGoogleApiError(
        requestIndex,
        "insertTable",
        "A table requires at least one row and one column",
      );
    const slot = this.locate(index, requestIndex, "insertTable");
    // Google documents a newline inserted before the table, which is what makes
    // the table's own start the requested index + 1.
    if (this.geometry.newlineBeforeTable) this.insertText(index, "\n", requestIndex);
    const boundary = this.geometry.newlineBeforeTable ? index + 1 : index;
    const after = this.slots().find((item) => item.start === boundary);
    if (!after)
      throw new SimulatedGoogleApiError(
        requestIndex,
        "insertTable",
        "The inserted table boundary is not a paragraph",
      );
    void slot;
    const table: Table = {
      rows: Array.from({ length: rows }, () =>
        Array.from({ length: columns }, () => ({ content: [emptyParagraph()] })),
      ),
    };
    const position = this.elements.findIndex(
      (element) => element.kind === "paragraph" && element.paragraph === after.paragraph,
    );
    if (position < 0)
      throw new SimulatedGoogleApiError(
        requestIndex,
        "insertTable",
        "A table may only be inserted at a top-level paragraph",
      );
    this.elements.splice(position, 0, { kind: "table", table });
  }

  private createParagraphBullets(
    range: { startIndex: number; endIndex: number },
    preset: string,
    requestIndex: number,
  ): void {
    const kind = this.presets[preset];
    if (!kind)
      throw new SimulatedGoogleApiError(
        requestIndex,
        "createParagraphBullets",
        `Unknown bulletPreset ${preset}`,
      );
    const covered = this.slots().filter(
      (slot) => slot.start < range.endIndex && slot.end > range.startIndex,
    );
    if (covered.length === 0)
      throw new SimulatedGoogleApiError(
        requestIndex,
        "createParagraphBullets",
        `The range ${range.startIndex}-${range.endIndex} covers no paragraph`,
      );
    const listId = `list-${(this.listCounter += 1)}`;
    this.lists.set(listId, kind);
    for (const slot of covered) {
      const text = paragraphText(slot.paragraph);
      const tabs = /^\t*/.exec(text)?.[0].length ?? 0;
      slot.paragraph.bullet = { listId, nestingLevel: tabs };
      if (tabs > 0) {
        // The tabs are consumed to establish nesting, shortening the paragraph.
        const characters = GoogleDocsSimulator.styledCharacters(slot.paragraph).slice(tabs);
        const replacement = GoogleDocsSimulator.fromCharacters(characters, slot.paragraph);
        this.replaceParagraph(slot.paragraph, [replacement]);
      }
    }
  }

  private assertRange(
    range: { startIndex: number; endIndex: number },
    requestIndex: number,
    requestType: string,
  ): ParagraphSlot[] {
    if (
      !Number.isInteger(range.startIndex) ||
      !Number.isInteger(range.endIndex) ||
      range.endIndex <= range.startIndex
    )
      throw new SimulatedGoogleApiError(
        requestIndex,
        requestType,
        `The range ${range.startIndex}-${range.endIndex} is invalid`,
      );
    const covered = this.slots().filter(
      (slot) => slot.start < range.endIndex && slot.end > range.startIndex,
    );
    if (covered.length === 0)
      throw new SimulatedGoogleApiError(
        requestIndex,
        requestType,
        `The range ${range.startIndex}-${range.endIndex} covers no content`,
      );
    if (range.endIndex > this.endIndex + 1)
      throw new SimulatedGoogleApiError(
        requestIndex,
        requestType,
        `The range end ${range.endIndex} must be less than the document length`,
      );
    return covered;
  }

  private updateTextStyle(
    range: { startIndex: number; endIndex: number },
    textStyle: Record<string, unknown>,
    requestIndex: number,
  ): void {
    const covered = this.assertRange(range, requestIndex, "updateTextStyle");
    for (const slot of covered) {
      const characters = GoogleDocsSimulator.styledCharacters(slot.paragraph);
      const updated = characters.map((item, offset) => {
        const absolute = slot.start + offset;
        return absolute >= range.startIndex && absolute < range.endIndex
          ? { ...item, textStyle: { ...item.textStyle, ...textStyle } }
          : item;
      });
      this.replaceParagraph(slot.paragraph, [
        GoogleDocsSimulator.fromCharacters(updated, slot.paragraph),
      ]);
    }
  }

  private updateParagraphStyle(
    range: { startIndex: number; endIndex: number },
    paragraphStyle: Record<string, unknown>,
    requestIndex: number,
  ): void {
    for (const slot of this.assertRange(range, requestIndex, "updateParagraphStyle"))
      slot.paragraph.paragraphStyle = { ...slot.paragraph.paragraphStyle, ...paragraphStyle };
  }

  private tableAt(index: number, requestIndex: number, requestType: string): Table {
    const table = this.tableStarts().get(index);
    if (!table)
      throw new SimulatedGoogleApiError(
        requestIndex,
        requestType,
        `No table begins at index ${index}`,
      );
    return table;
  }

  /** Applies one batchUpdate, sequentially, failing exactly where Google would. */
  apply(requests: readonly unknown[]): void {
    requests.forEach((raw, requestIndex) => {
      const request = raw as Record<string, any>;
      const type = Object.keys(request)[0];
      if (!type) throw new SimulatedGoogleApiError(requestIndex, "unknown", "The request is empty");
      const body = request[type];
      switch (type) {
        case "insertText":
          this.insertText(body.location.index, String(body.text), requestIndex);
          break;
        case "insertTable":
          this.insertTable(body.location.index, body.rows, body.columns, requestIndex);
          break;
        case "createParagraphBullets":
          this.createParagraphBullets(body.range, body.bulletPreset, requestIndex);
          break;
        case "updateTextStyle":
          this.updateTextStyle(body.range, body.textStyle ?? {}, requestIndex);
          break;
        case "updateParagraphStyle":
          this.updateParagraphStyle(body.range, body.paragraphStyle ?? {}, requestIndex);
          break;
        case "updateTableCellStyle": {
          const location = body.tableRange?.tableCellLocation;
          const table = this.tableAt(
            location?.tableStartLocation?.index,
            requestIndex,
            "updateTableCellStyle",
          );
          const rowIndex = location?.rowIndex ?? 0;
          const columnIndex = location?.columnIndex ?? 0;
          const rowSpan = body.tableRange?.rowSpan ?? 1;
          const columnSpan = body.tableRange?.columnSpan ?? 1;
          if (
            rowIndex + rowSpan > table.rows.length ||
            columnIndex + columnSpan > (table.rows[0]?.length ?? 0)
          )
            throw new SimulatedGoogleApiError(
              requestIndex,
              "updateTableCellStyle",
              "The table range exceeds the table dimensions",
            );
          break;
        }
        case "pinTableHeaderRows": {
          const table = this.tableAt(
            body.tableStartLocation?.index,
            requestIndex,
            "pinTableHeaderRows",
          );
          if ((body.pinnedHeaderRowsCount ?? 0) > table.rows.length)
            throw new SimulatedGoogleApiError(
              requestIndex,
              "pinTableHeaderRows",
              "More header rows were pinned than the table has",
            );
          break;
        }
        case "deleteContentRange": {
          const covered = this.assertRange(body.range, requestIndex, "deleteContentRange");
          for (const slot of covered) {
            const characters = GoogleDocsSimulator.styledCharacters(slot.paragraph).filter(
              (_, offset) => {
                const absolute = slot.start + offset;
                return absolute < body.range.startIndex || absolute >= body.range.endIndex;
              },
            );
            this.replaceParagraph(slot.paragraph, [
              GoogleDocsSimulator.fromCharacters(characters, slot.paragraph),
            ]);
          }
          break;
        }
        default:
          throw new SimulatedGoogleApiError(
            requestIndex,
            type,
            "The simulator does not model this request type",
          );
      }
    });
    this.revision += 1;
  }

  /** The document as the Docs API would return it, for canonical reconstruction. */
  document(): Record<string, unknown> {
    const content: unknown[] = [];
    let cursor = 1;
    const paragraphJson = (paragraph: Paragraph, start: number) => {
      const length = paragraphText(paragraph).length;
      const json = {
        startIndex: start,
        endIndex: start + length,
        paragraph: {
          paragraphStyle: paragraph.paragraphStyle,
          ...(paragraph.bullet ? { bullet: paragraph.bullet } : {}),
          elements: paragraph.runs
            .filter((run) => run.content.length > 0)
            .map((run) => ({ textRun: { content: run.content, textStyle: run.textStyle } })),
        },
      };
      return { json, length };
    };
    for (const element of this.elements) {
      if (element.kind === "paragraph") {
        const { json, length } = paragraphJson(element.paragraph, cursor);
        content.push(json);
        cursor += length;
        continue;
      }
      const tableStart = cursor;
      cursor += 1;
      const tableRows = element.table.rows.map((row) => {
        const rowStart = cursor;
        cursor += this.geometry.rowOverhead;
        const tableCells = row.map((cell) => {
          const cellStart = cursor;
          cursor += this.geometry.cellOverhead;
          const cellContent = cell.content.map((paragraph) => {
            const { json, length } = paragraphJson(paragraph, cursor);
            cursor += length;
            return json;
          });
          return { startIndex: cellStart, endIndex: cursor, content: cellContent };
        });
        return { startIndex: rowStart, endIndex: cursor, tableCells };
      });
      content.push({ startIndex: tableStart, endIndex: cursor, table: { tableRows } });
    }
    const lists: Record<string, unknown> = {};
    for (const [listId, kind] of this.lists)
      lists[listId] = {
        listProperties: {
          nestingLevels: Array.from({ length: 9 }, () =>
            kind === "ordered" ? { glyphType: "DECIMAL" } : { glyphSymbol: "●" },
          ),
        },
      };
    return {
      documentId: this.documentId,
      revisionId: this.revisionId,
      body: { content },
      ...(this.lists.size ? { lists } : {}),
    };
  }
}

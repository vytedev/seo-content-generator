import { z } from "zod";
import {
  GoogleDocsExportSchema,
  GoogleDocsOperationSchema,
  type ExportRenderResult,
  type GoogleDocsAdapter,
  type GoogleDocsExport,
  type GoogleDocsOperation,
} from "../../shared/export.js";
import { contentHash, stableId } from "../../shared/milestone-two.js";
import { logger } from "../logger.js";
import { GoogleDocsWriteConflictError, planNextBatch } from "./google-docs-writer.js";
import {
  boundedFetch,
  GoogleOAuthError,
  retryingBoundedFetch,
  type GoogleOAuthClient,
} from "./google-oauth.js";

const driveFilesSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string().min(1),
        appProperties: z
          .object({
            mobelaris_content_hash: z.string().optional(),
            mobelaris_render_hash: z.string().optional(),
            mobelaris_export_complete_hash: z.string().optional(),
            mobelaris_export_format_version: z.string().optional(),
            mobelaris_provider_idempotency_key: z.string().optional(),
          })
          .passthrough()
          .optional(),
      }),
    )
    .default([]),
});
type ReservedDriveFile = z.infer<typeof driveFilesSchema>["files"][number];
const driveFileSchema = z.object({ id: z.string().min(1) });
class GoogleApiStatusError extends GoogleOAuthError {
  constructor(
    readonly status: number,
    readonly requestIndex?: number,
    readonly requestType?: string,
    readonly reportedRequestType?: string,
    readonly reason?: string,
    readonly requestShape?: ReturnType<typeof safeRequestShape>,
    readonly previousRequestShape?: ReturnType<typeof safeRequestShape>,
  ) {
    super("Google Docs export failed.");
  }
}

/**
 * A post-update verification failure: Google accepted the batch, so this is a
 * structural/reconstruction problem, never a connection or API rejection. The
 * distinct message lets Step 1.12 classify it away from `google_api` so the
 * operator is not told to reconnect Google for a reread mismatch.
 */
export type GoogleDocsStructureReason =
  | "document_schema_invalid"
  | "native_list_metadata_invalid"
  | "body_control_text_invalid"
  | "unsupported_document_structure"
  | "reserved_document_mismatch"
  | "suffix_recovery_verification_failed"
  | "marker_recovery_verification_failed"
  | "completion_marker_missing"
  | "list_marker_missing"
  | "canonical_reread_mismatch"
  | "historical_table_repair_not_proven"
  | "historical_table_repair_verification_failed";

export class GoogleDocsStructureError extends GoogleOAuthError {
  constructor(
    readonly reason: GoogleDocsStructureReason,
    /** Safe booleans/counts only — never document text, Google messages or bodies. */
    readonly detail: Record<string, string | number | boolean> = {},
  ) {
    super("Google Docs export structure mismatch.");
  }
}

type GoogleDocsIdempotencyConflictReason =
  | "completion_marker_mismatch"
  | "canonical_operations_mismatch"
  | "reserved_document_not_exact_prefix"
  | "reserved_metadata_mismatch"
  | "reserved_document_changed"
  | "reserved_document_conflict";

class GoogleDocsIdempotencyConflictError extends Error {
  constructor(
    readonly reason: GoogleDocsIdempotencyConflictReason,
    readonly detail: Record<string, string | number | boolean>,
  ) {
    super("Export idempotency conflict");
  }
}

function safeRequestShape(request: unknown) {
  if (typeof request !== "object" || request === null) return undefined;
  const record = request as Record<string, any>;
  const type = Object.keys(record)[0];
  if (!type) return undefined;
  const payload = record[type] as Record<string, any> | undefined;
  const range = payload?.range as Record<string, unknown> | undefined;
  const location = payload?.location as Record<string, unknown> | undefined;
  const tableCellLocation = payload?.tableCellLocation as Record<string, any> | undefined;
  return {
    type,
    ...(typeof location?.index === "number" ? { location_index: location.index } : {}),
    ...(typeof range?.startIndex === "number" ? { range_start: range.startIndex } : {}),
    ...(typeof range?.endIndex === "number" ? { range_end: range.endIndex } : {}),
    ...(typeof payload?.rows === "number" ? { rows: payload.rows } : {}),
    ...(typeof payload?.columns === "number" ? { columns: payload.columns } : {}),
    ...(typeof tableCellLocation?.rowIndex === "number"
      ? { table_row: tableCellLocation.rowIndex }
      : {}),
    ...(typeof tableCellLocation?.columnIndex === "number"
      ? { table_column: tableCellLocation.columnIndex }
      : {}),
  };
}

async function googleBatchError(
  response: Response,
  requests: readonly unknown[],
): Promise<GoogleApiStatusError> {
  let message = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown; status?: unknown } };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the redacted generic classification when Google returns no JSON.
  }
  const indexed = /requests\[(\d+)](?:\.([A-Za-z][A-Za-z0-9]*))?/i.exec(message);
  const requestIndex = indexed ? Number(indexed[1]) : undefined;
  const request = requestIndex === undefined ? undefined : requests[requestIndex];
  const requestType =
    request && typeof request === "object" && request !== null
      ? Object.keys(request as Record<string, unknown>)[0]
      : undefined;
  const reportedRequestType = indexed?.[2];
  const reason = /index.+must be less than/i.test(message)
    ? "index_out_of_bounds"
    : /range.+invalid|invalid.+range/i.test(message)
      ? "invalid_range"
      : /table/i.test(message)
        ? "table_request_invalid"
        : /bullet/i.test(message)
          ? "bullet_request_invalid"
          : /style/i.test(message)
            ? "style_request_invalid"
            : "invalid_batch_request";
  return new GoogleApiStatusError(
    response.status,
    requestIndex,
    requestType?.slice(0, 80),
    reportedRequestType?.slice(0, 80),
    reason,
    safeRequestShape(request),
    requestIndex === undefined ? undefined : safeRequestShape(requests[requestIndex - 1]),
  );
}
const COMPLETE_PREFIX = "MOBELARIS_EXPORT_COMPLETE:";
const EXPORT_FORMAT_VERSION = "2";
const BODY_TEXT_COLOUR = { color: { rgbColor: { red: 0.145, green: 0.122, blue: 0.106 } } };
const LIST_MARKER = "\u2063MOBELARIS_LIST:";
const listMarker = (ordered: boolean) => `${LIST_MARKER}${ordered ? "ORDERED" : "UNORDERED"}\u2063`;
/**
 * Google Docs starts a NEW PARAGRAPH at every "\n" in inserted text, so a single
 * rendered operation whose text spans several lines (a rejected-findings list
 * item, for example) would come back as several paragraphs \u2014 the continuations
 * carrying the bullet but not the structural list marker. U+000B (vertical tab)
 * is Docs' in-paragraph line break instead, keeping one operation to exactly one
 * paragraph. Both characters are one UTF-16 unit, so every inline span offset
 * and running document index is unchanged by the substitution.
 */
const DOCS_LINE_BREAK = "\u000b";
const toDocsText = (value: string) => value.replaceAll("\n", DOCS_LINE_BREAK);
const fromDocsText = (value: string) => value.replaceAll(DOCS_LINE_BREAK, "\n");
// Inherited/unset Docs styles can be returned as explicit JSON nulls. Accept
// null only on those documented optional style leaves; structural content and
// concrete style objects remain strictly typed for canonical reconstruction.
const textRunSchema = z
  .object({
    content: z.string(),
    textStyle: z
      .object({
        bold: z.boolean().nullable().optional(),
        italic: z.boolean().nullable().optional(),
        link: z.object({ url: z.string() }).passthrough().nullable().optional(),
        weightedFontFamily: z
          .object({ fontFamily: z.string() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const paragraphSchema: z.ZodType<any> = z
  .object({
    paragraphStyle: z
      .object({
        namedStyleType: z.string().optional(),
        indentStart: z
          .object({ magnitude: z.number().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    bullet: z
      .object({
        listId: z.string().min(1),
        nestingLevel: z.number().int().min(0).max(8).optional(),
      })
      .passthrough()
      .optional(),
    elements: z.array(z.object({ textRun: textRunSchema.optional() }).passthrough()).default([]),
  })
  .passthrough();
const structuralSchema: z.ZodType<any> = z
  .object({
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    paragraph: paragraphSchema.optional(),
    table: z
      .object({
        tableRows: z
          .array(
            z
              .object({
                tableCells: z
                  .array(
                    z
                      .object({ content: z.array(z.lazy(() => structuralSchema)).default([]) })
                      .passthrough(),
                  )
                  .default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const nativeListSchema = z
  .object({
    listProperties: z
      .object({
        nestingLevels: z
          .array(
            z
              .object({ glyphType: z.string().optional(), glyphSymbol: z.string().optional() })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough(),
  })
  .passthrough();
const documentSchema = z
  .object({
    documentId: z.string().min(1),
    revisionId: z.string().min(1).optional(),
    body: z.object({ content: z.array(structuralSchema).default([]) }).optional(),
    lists: z.record(z.string(), nativeListSchema).optional(),
  })
  .passthrough();

const OPERATION_TYPES = new Set(["paragraph", "blockquote", "list_item", "image_marker", "table"]);
const safeOperationType = (value: unknown) => {
  if (value === undefined) return "absent";
  if (typeof value !== "object" || value === null || !("type" in value)) return "unknown";
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && OPERATION_TYPES.has(type) ? type : "unknown";
};

/**
 * Canonical reconstruction only understands paragraphs, tables and the one
 * default section break Google may place at the start of a document. Reject
 * every other content-bearing union member before an idempotency decision so
 * an ignored inline object, TOC or foreign structural element can never make a
 * modified document look like an exact app-produced prefix.
 */
function assertSupportedDocumentStructure(document: z.infer<typeof documentSchema>) {
  let unsupportedCount = 0;
  let firstUnsupportedKind:
    | "structural_element"
    | "paragraph_element"
    | "section_break"
    | "ambiguous_element"
    | "nested_table"
    | "positioned_object"
    | "suggestion_state"
    | null = null;
  const unsupported = (kind: NonNullable<typeof firstUnsupportedKind>) => {
    unsupportedCount += 1;
    firstUnsupportedKind ??= kind;
  };
  const hasMeaningfulSuggestionState = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasMeaningfulSuggestionState);
    if (typeof value !== "object" || value === null) return false;
    return Object.entries(value).some(
      ([key, child]) =>
        (key.startsWith("suggested") &&
          (Array.isArray(child)
            ? child.length > 0
            : typeof child === "object" && child !== null
              ? Object.keys(child).length > 0
              : child !== undefined && child !== null && child !== "")) ||
        hasMeaningfulSuggestionState(child),
    );
  };
  if (hasMeaningfulSuggestionState({ body: document.body, lists: document.lists }))
    unsupported("suggestion_state");

  const visit = (content: any[], allowDefaultSectionBreak: boolean, allowTables: boolean) => {
    content.forEach((item, index) => {
      const structuralKeys = Object.keys(item).filter(
        (key) => !["startIndex", "endIndex", "paragraph", "table", "sectionBreak"].includes(key),
      );
      if (structuralKeys.length) unsupported("structural_element");

      const hasParagraph = item.paragraph !== undefined;
      const hasTable = item.table !== undefined;
      const hasSectionBreak = item.sectionBreak !== undefined;
      const contentKindCount = Number(hasParagraph) + Number(hasTable) + Number(hasSectionBreak);
      if (contentKindCount !== 1) unsupported("ambiguous_element");

      if (hasSectionBreak) {
        const isDefaultLeadingBreak =
          allowDefaultSectionBreak &&
          index === 0 &&
          (item.startIndex === undefined || item.startIndex === 0) &&
          item.endIndex === 1 &&
          !hasParagraph &&
          !hasTable &&
          structuralKeys.length === 0;
        if (!isDefaultLeadingBreak) unsupported("section_break");
      }

      if (hasParagraph) {
        const paragraphKeys = Object.keys(item.paragraph).filter(
          (key) => !["paragraphStyle", "bullet", "elements", "positionedObjectIds"].includes(key),
        );
        if (paragraphKeys.length) unsupported("paragraph_element");
        const positionedObjectIds = item.paragraph.positionedObjectIds;
        if (
          positionedObjectIds !== undefined &&
          (!Array.isArray(positionedObjectIds) || positionedObjectIds.length > 0)
        )
          unsupported("positioned_object");
        for (const element of item.paragraph.elements ?? []) {
          const elementKeys = Object.keys(element).filter(
            (key) => !["startIndex", "endIndex", "textRun"].includes(key),
          );
          if (element.textRun === undefined || elementKeys.length) unsupported("paragraph_element");
        }
      }

      if (hasTable) {
        if (!allowTables) unsupported("nested_table");
        for (const row of item.table.tableRows ?? [])
          for (const cell of row.tableCells ?? []) visit(cell.content ?? [], false, false);
      }
    });
  };
  visit(document.body?.content ?? [], true, true);
  if (unsupportedCount)
    throw new GoogleDocsStructureError("unsupported_document_structure", {
      unsupported_structure_count: unsupportedCount,
      unsupported_structure_kind: firstUnsupportedKind ?? "structural_element",
    });
}

const SAFE_ZOD_TYPES = new Set([
  "array",
  "boolean",
  "date",
  "float",
  "integer",
  "map",
  "nan",
  "never",
  "null",
  "number",
  "object",
  "promise",
  "set",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);
const safeZodType = (value: unknown) =>
  typeof value === "string" && SAFE_ZOD_TYPES.has(value) ? value : "other";
const countedSummary = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 24)
    .map(([value, count]) => `${value}=${count}`)
    .join(",")
    .slice(0, 1_000);
};
function safeDocumentSchemaDiagnostics(error: z.ZodError) {
  const typed = error.issues.map((issue) => {
    const typeIssue = issue as z.ZodIssue & { expected?: unknown; received?: unknown };
    return {
      path:
        issue.path
          .map((segment) => (typeof segment === "number" ? "[]" : String(segment)))
          .join(".") || "(root)",
      expected: safeZodType(typeIssue.expected),
      received: safeZodType(typeIssue.received),
    };
  });
  return {
    issue_count: typed.length,
    nullable_issue_count: typed.filter((issue) => issue.received === "null").length,
    issue_path_unique_count: new Set(typed.map((issue) => issue.path)).size,
    issue_path_counts: countedSummary(typed.map((issue) => issue.path)),
    expected_received_counts: countedSummary(
      typed.map((issue) => `${issue.expected}<-${issue.received}`),
    ),
  };
}

type Span = {
  start: number;
  end: number;
  kind: "bold" | "italic" | "code" | "link";
  target?: string | undefined;
};
type Rich = { text: string; spans: Span[] };
function richFromParagraph(paragraph: any, normaliseFullRangeBold = false): Rich {
  let text = "";
  const spans: Span[] = [];
  for (const element of paragraph.elements ?? []) {
    const run = element.textRun;
    if (!run) continue;
    const start = text.length;
    text += run.content;
    const end = text.length;
    if (run.textStyle?.bold) spans.push({ start, end, kind: "bold" });
    if (run.textStyle?.italic) spans.push({ start, end, kind: "italic" });
    if (run.textStyle?.weightedFontFamily?.fontFamily === "Roboto Mono")
      spans.push({ start, end, kind: "code" });
    if (run.textStyle?.link?.url)
      spans.push({ start, end, kind: "link", target: run.textStyle.link.url });
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  const marker = new RegExp(`^${LIST_MARKER}(ORDERED|UNORDERED)\\u2063`).exec(text);
  const markerLength = marker?.[0].length ?? 0;
  if (markerLength) text = text.slice(markerLength);
  return {
    // Same length in, same length out, so the span shifts below stay exact.
    text: fromDocsText(text),
    spans: spans
      .map((s) => ({
        ...s,
        start: Math.max(0, s.start - markerLength),
        end: Math.min(s.end - markerLength, text.length),
      }))
      .filter((s) => s.end > s.start)
      .filter(
        (s) =>
          !(normaliseFullRangeBold && s.kind === "bold" && s.start === 0 && s.end === text.length),
      )
      .sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind)),
  };
}
function listTypeFromParagraph(paragraph: any): boolean | null {
  const raw = (paragraph.elements ?? [])
    .map((element: any) => element.textRun?.content ?? "")
    .join("");
  const marker = new RegExp(`^${LIST_MARKER}(ORDERED|UNORDERED)\\u2063`).exec(raw);
  return marker ? marker[1] === "ORDERED" : null;
}
interface NativeListSemantics {
  readonly ordered: boolean;
  readonly nestingLevel: number;
  readonly legacyMarker: boolean;
}
const ORDERED_GLYPH_TYPE =
  /^(?:DECIMAL|ZERO_DECIMAL|UPPER_ALPHA|ALPHA|LOWER_ALPHA|UPPER_ROMAN|ROMAN|LOWER_ROMAN)$/;

function nativeListSemantics(
  document: z.infer<typeof documentSchema>,
  paragraph: any,
): NativeListSemantics {
  const bullet = paragraph.bullet;
  const marker = listTypeFromParagraph(paragraph);
  const nestingLevel = bullet?.nestingLevel ?? 0;
  if (!bullet)
    throw new GoogleDocsStructureError("native_list_metadata_invalid", {
      reason: "bullet_missing",
    });
  if (!document.lists) {
    if (marker === null)
      throw new GoogleDocsStructureError("native_list_metadata_invalid", {
        reason: "document_lists_missing",
      });
    return { ordered: marker, nestingLevel, legacyMarker: true };
  }
  const definition = document.lists[bullet.listId];
  const level = definition?.listProperties.nestingLevels[nestingLevel];
  if (!level)
    throw new GoogleDocsStructureError("native_list_metadata_invalid", {
      reason: definition ? "nesting_level_missing" : "list_id_unknown",
      nesting_level: nestingLevel,
    });
  const glyphType = level.glyphType ?? "";
  const glyphSymbol = level.glyphSymbol ?? "";
  const ordered = ORDERED_GLYPH_TYPE.test(glyphType);
  const unordered = glyphSymbol.length > 0 && !ordered;
  if ((!ordered && !unordered) || (ordered && glyphSymbol.length > 0))
    throw new GoogleDocsStructureError("native_list_metadata_invalid", {
      reason: "glyph_metadata_ambiguous",
      nesting_level: nestingLevel,
    });
  if (marker !== null && marker !== ordered)
    throw new GoogleDocsStructureError("native_list_metadata_invalid", {
      reason: "legacy_marker_native_type_mismatch",
      nesting_level: nestingLevel,
    });
  return { ordered, nestingLevel, legacyMarker: marker !== null };
}
function isIgnorableStructuralTableCellParagraph(paragraph: any, rich: Rich): boolean {
  if (rich.text.length > 0 || paragraph.bullet !== undefined) return false;
  // Google requires a terminal paragraph in every table cell and may return
  // inherited paragraph/text styles on it. With no characters beyond the
  // terminator, those styles cannot contribute to the canonical cell value.
  // Content-bearing foreign structures and positioned objects are rejected by
  // assertSupportedDocumentStructure before reconstruction; an empty bullet is
  // retained as meaningful structure and rejected here.
  return (paragraph.elements ?? []).every((element: any) => {
    const run = element.textRun;
    return Boolean(run && fromDocsText(run.content).replaceAll("\n", "").length === 0);
  });
}
function canonicalOperations(operations: GoogleDocsOperation[]): unknown[] {
  return operations.map((operation) => JSON.parse(JSON.stringify(operation)));
}
/**
 * Canonical operations as reconstructed from a document exactly as the Docs API
 * returned it. This is the reread that the writer plans against, so it is the
 * one place a document's real structure is interpreted.
 */
export function readCanonicalDocument(raw: unknown) {
  return operationsFromDocument(documentSchema.parse(raw));
}

function operationsFromDocument(document: z.infer<typeof documentSchema>): {
  operations: unknown[];
  completion: string | null;
  completion_count: number;
  revision_id: string | null;
  marker_insertion_index: number | null;
  legacy_list_marker_ranges: Array<{ startIndex: number; endIndex: number }>;
  completion_ranges: Array<{ startIndex: number; endIndex: number }>;
  native_list_count: number;
} {
  assertSupportedDocumentStructure(document);
  const operations: unknown[] = [];
  const legacyListMarkerRanges: Array<{ startIndex: number; endIndex: number }> = [];
  const completionRanges: Array<{ startIndex: number; endIndex: number }> = [];
  let nativeListCount = 0;
  let completion: string | null = null;
  let completionCount = 0;
  const parseParagraph = (paragraph: any, tableHeader = false): Rich =>
    richFromParagraph(
      paragraph,
      tableHeader ||
        /^(?:TITLE|HEADING_[1-3])$/.test(paragraph.paragraphStyle?.namedStyleType ?? ""),
    );
  for (const item of document.body?.content ?? []) {
    if (item.paragraph) {
      const raw = (item.paragraph.elements ?? [])
        .map((element: any) => String(element.textRun?.content ?? ""))
        .join("");
      const rawText = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      const legacyMatch = new RegExp(`^${LIST_MARKER}(ORDERED|UNORDERED)\\u2063`).exec(rawText);
      if (rawText.includes(LIST_MARKER) && !legacyMatch)
        throw new GoogleDocsStructureError("body_control_text_invalid", {
          reason: "legacy_list_marker_malformed_or_misplaced",
        });
      if (rawText.includes(COMPLETE_PREFIX) && !rawText.startsWith(COMPLETE_PREFIX))
        throw new GoogleDocsStructureError("body_control_text_invalid", {
          reason: "completion_marker_misplaced",
        });
      const rich = parseParagraph(item.paragraph);
      if (!rich.text) continue;
      if (rich.text.startsWith(COMPLETE_PREFIX)) {
        if (
          item.paragraph.bullet !== undefined ||
          legacyMatch !== null ||
          !Number.isInteger(item.startIndex) ||
          !Number.isInteger(item.endIndex) ||
          item.endIndex! <= item.startIndex!
        )
          throw new GoogleDocsStructureError("body_control_text_invalid", {
            reason: "completion_marker_structure_invalid",
          });
        completionCount += 1;
        completion = rich.text;
        completionRanges.push({
          startIndex: item.startIndex!,
          endIndex: item.endIndex!,
        });
        continue;
      }
      const marker = /^\[IMAGE ([^ ]+) \| filename: (.+) \| alt: (.*)]$/.exec(rich.text);
      if (marker)
        operations.push({
          type: "image_marker",
          marker_id: marker[1],
          filename: marker[2],
          alt: marker[3],
          text: rich.text,
        });
      else if (item.paragraph.bullet) {
        const semantics = nativeListSemantics(document, item.paragraph);
        if (semantics.legacyMarker) {
          const markerLength = legacyMatch?.[0].length ?? 0;
          if (
            markerLength === 0 ||
            !Number.isInteger(item.startIndex) ||
            item.startIndex! + markerLength >= (item.endIndex ?? 0)
          )
            throw new GoogleDocsStructureError("body_control_text_invalid", {
              reason: "legacy_list_marker_range_invalid",
            });
          legacyListMarkerRanges.push({
            startIndex: item.startIndex!,
            endIndex: item.startIndex! + markerLength,
          });
        }
        nativeListCount += 1;
        operations.push({
          type: "list_item",
          ordered: semantics.ordered,
          ...(semantics.nestingLevel > 0 ? { nesting_level: semantics.nestingLevel } : {}),
          ...rich,
        });
      } else if (legacyMatch)
        throw new GoogleDocsStructureError("body_control_text_invalid", {
          reason: "legacy_list_marker_without_bullet",
        });
      else if (item.paragraph.paragraphStyle?.indentStart?.magnitude === 18)
        operations.push({ type: "blockquote", ...rich });
      else
        operations.push({
          type: "paragraph",
          style: item.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
          ...rich,
        });
    } else if (item.table) {
      const rows = item.table.tableRows.map((row: any, rowIndex: number) =>
        row.tableCells.map((cell: any, columnIndex: number) => {
          const paragraphs = cell.content.flatMap((x: any) =>
            x.paragraph ? [parseParagraph(x.paragraph, rowIndex === 0)] : [],
          );
          // Google may retain structural empty paragraphs before or after the
          // one paragraph populated by this adapter. Authored cell line breaks
          // are encoded as U+000B inside that paragraph, so a second non-empty
          // paragraph is never app-owned and must fail closed rather than being
          // silently merged into the canonical table operation.
          const authored = paragraphs.filter((paragraph: Rich, index: number) => {
            if (paragraph.text.length > 0) return true;
            const source = cell.content.filter((x: any) => x.paragraph)[index]?.paragraph;
            if (isIgnorableStructuralTableCellParagraph(source, paragraph)) return false;
            throw new GoogleDocsStructureError("unsupported_document_structure", {
              unsupported_structure_count: 1,
              unsupported_structure_kind: "table_cell_meaningful_empty_paragraph",
              table_row: rowIndex,
              table_column: columnIndex,
            });
          });
          if (authored.length > 1)
            throw new GoogleDocsStructureError("unsupported_document_structure", {
              unsupported_structure_count: authored.length,
              unsupported_structure_kind: "table_cell_multiple_nonempty_paragraphs",
              table_row: rowIndex,
              table_column: columnIndex,
            });
          return authored[0] ?? { text: "", spans: [] };
        }),
      );
      operations.push({ type: "table", rows });
    }
  }
  const tail = document.body?.content.at(-1);
  const tailStart = tail?.startIndex;
  const tailEnd = tail?.endIndex;
  const markerInsertionIndex =
    tail?.paragraph &&
    richFromParagraph(tail.paragraph).text === "" &&
    Number.isInteger(tailStart) &&
    Number.isInteger(tailEnd) &&
    tailEnd === tailStart! + 1
      ? tailStart!
      : null;
  return {
    operations,
    completion,
    completion_count: completionCount,
    revision_id: document.revisionId ?? null,
    marker_insertion_index: markerInsertionIndex,
    legacy_list_marker_ranges: legacyListMarkerRanges,
    completion_ranges: completionRanges,
    native_list_count: nativeListCount,
  };
}

/**
 * Detection for the one historically app-owned corruption: the table index size
 * omitted the final cell paragraph's newline, so every operation following a
 * table was inserted onto that paragraph — inside the table — instead of after
 * it. See the derivation on `tableSize` in nativeRequestsForOperations.
 *
 * This is deliberately narrow. It proves the corruption was produced by that
 * exact bug and nothing else, then plans a delete-and-append repair. It never
 * rewrites correct operations, never clears the document, and refuses anything
 * it cannot prove — including any foreign content, because the pruned document
 * and the extracted suffix are both re-decoded by the ordinary reconstruction,
 * which fails closed on unsupported structures.
 */
interface HistoricalTableRepairPlan {
  readonly deleteRange: { readonly startIndex: number; readonly endIndex: number };
  readonly styleResetRange?: { readonly startIndex: number; readonly endIndex: number };
  readonly insertIndex: number;
  readonly operations: GoogleDocsOperation[];
  readonly detail: Record<string, string | number | boolean>;
}

function structuralParagraphs(cell: any): any[] {
  return (cell?.content ?? []).filter((item: any) => item?.paragraph);
}

/** Bounded, content-free description of why a repair could not be proven. */
function notProven(reason: string, extra: Record<string, string | number | boolean> = {}) {
  return { plan: undefined, detail: { historical_repair_eligible: false, reason, ...extra } };
}

interface HistoricalSuffixDecodeResult {
  readonly operations: GoogleDocsOperation[] | undefined;
  readonly detail: Record<string, string | number | boolean>;
}

function safeStructuralType(item: unknown) {
  if (item === undefined) return "absent";
  if (typeof item !== "object" || item === null) return "unknown";
  const record = item as Record<string, unknown>;
  if (record.paragraph !== undefined) return "paragraph";
  if (record.table !== undefined) return "table";
  if (record.sectionBreak !== undefined) return "section_break";
  return "unknown";
}

function spanStyleCategories(spans: readonly Span[]) {
  const categories = [...new Set(spans.map((span) => span.kind))].sort();
  return categories.length ? categories.join(",") : "none";
}

function isPlainHistoricalListContinuation(paragraph: any) {
  const style = paragraph?.paragraphStyle;
  return (
    paragraph?.bullet === undefined &&
    (style?.namedStyleType === undefined || style.namedStyleType === "NORMAL_TEXT") &&
    style?.indentStart?.magnitude === undefined
  );
}

const HISTORICAL_MAPPING_LIMIT = 64;

function historicalMarkerState(paragraph: any) {
  if (!paragraph) return "not_applicable";
  const markerType = listTypeFromParagraph(paragraph);
  if (markerType !== null) return markerType ? "ordered" : "unordered";
  const raw = (paragraph.elements ?? [])
    .map((element: any) => String(element.textRun?.content ?? ""))
    .join("");
  return raw.startsWith(LIST_MARKER) ? "unrecognised" : "absent";
}

/**
 * Bounded, content-free map of every candidate misplaced paragraph. Exact
 * expected-operation indexes are derived by canonical equality; no document
 * text, hash value, list ID or upstream payload is returned or logged.
 */
function historicalMisplacedMapping(
  misplaced: any[],
  expected: unknown[],
  expectedStartIndex: number,
): Record<string, string | number | boolean> {
  const visible = misplaced.slice(0, HISTORICAL_MAPPING_LIMIT);
  const expectedCanonical = expected.map((operation) => JSON.stringify(operation));
  const structuralTypes: string[] = [];
  const textLengths: string[] = [];
  const bulletStates: string[] = [];
  const markerStates: string[] = [];
  const exactExpectedIndexes: string[] = [];
  for (const item of visible) {
    structuralTypes.push(safeStructuralType(item));
    const paragraph = item?.paragraph;
    textLengths.push(String(paragraph ? richFromParagraph(paragraph).text.length : 0));
    bulletStates.push(paragraph?.bullet === undefined ? "absent" : "present");
    markerStates.push(historicalMarkerState(paragraph));
    let actualCanonical: string | undefined;
    try {
      const operations = operationsFromDocument({
        documentId: "historical-repair-mapping",
        body: { content: [item] },
      } as never).operations;
      if (operations.length === 1) actualCanonical = JSON.stringify(operations[0]);
    } catch {
      // The fixed structural type and no-match result are sufficient and safe.
    }
    const matches: number[] = [];
    if (actualCanonical !== undefined)
      for (let index = 0; index < expectedCanonical.length; index += 1)
        if (actualCanonical === expectedCanonical[index]) matches.push(expectedStartIndex + index);
    // Keep diagnostics bounded even when the frozen render contains repeated
    // canonical operations. A repeated operation has no single exact mapping,
    // so report that ambiguity instead of emitting an unbounded index list.
    exactExpectedIndexes.push(
      matches.length === 0 ? "none" : matches.length === 1 ? String(matches[0]) : "ambiguous",
    );
  }
  return {
    misplaced_mapping_count: misplaced.length,
    misplaced_mapping_limit: HISTORICAL_MAPPING_LIMIT,
    misplaced_mapping_truncated: misplaced.length > HISTORICAL_MAPPING_LIMIT,
    misplaced_structural_types: structuralTypes.join(","),
    misplaced_text_lengths: textLengths.join(","),
    misplaced_bullet_states: bulletStates.join(","),
    misplaced_marker_states: markerStates.join(","),
    misplaced_exact_expected_operation_indexes: exactExpectedIndexes.join(","),
  };
}

function decodeHistoricalMisplacedSuffix(
  misplaced: any[],
  expected: unknown[],
  expectedStartIndex: number,
  expectedOperationIndexes?: readonly number[],
): HistoricalSuffixDecodeResult {
  const decoded: GoogleDocsOperation[] = [];
  let cursor = 0;
  let bulletlessContinuationCount = 0;
  const reject = (
    decoderRejectionReason: string,
    expectedOffset: number,
    expectedValue: unknown,
    actualIndex: number,
    consumed: number,
  ): HistoricalSuffixDecodeResult => {
    const item = misplaced[actualIndex];
    const paragraph = item?.paragraph;
    const rich = paragraph ? richFromParagraph(paragraph) : undefined;
    const expectedText =
      typeof expectedValue === "object" &&
      expectedValue !== null &&
      typeof (expectedValue as { text?: unknown }).text === "string"
        ? ((expectedValue as { text: string }).text ?? "")
        : undefined;
    const raw = paragraph
      ? (paragraph.elements ?? [])
          .map((element: any) => String(element.textRun?.content ?? ""))
          .join("")
      : "";
    const markerType = paragraph ? listTypeFromParagraph(paragraph) : null;
    return {
      operations: undefined,
      detail: {
        decoder_rejection_reason: decoderRejectionReason,
        expected_operation_index:
          expectedOperationIndexes?.[expectedOffset] ?? expectedStartIndex + expectedOffset,
        expected_operation_type: safeOperationType(expectedValue),
        actual_misplaced_paragraph_index: actualIndex,
        actual_structural_type: safeStructuralType(item),
        bullet_metadata_present: paragraph?.bullet !== undefined,
        list_marker_present: raw.startsWith(LIST_MARKER),
        list_marker_recognised: markerType !== null,
        paragraph_count_consumed: consumed,
        span_count: rich?.spans.length ?? 0,
        span_style_categories: rich ? spanStyleCategories(rich.spans) : "none",
        ...(rich && expectedText !== undefined
          ? {
              actual_text_length: rich.text.length,
              expected_text_length: expectedText.length,
              text_length_matches_expected: rich.text.length === expectedText.length,
              text_hash_matches_expected: contentHash(rich.text) === contentHash(expectedText),
            }
          : {}),
      },
    };
  };

  for (let expectedOffset = 0; expectedOffset < expected.length; expectedOffset += 1) {
    const expectedValue = expected[expectedOffset];
    const expectedOperation = GoogleDocsOperationSchema.safeParse(expectedValue);
    if (!expectedOperation.success)
      return reject("expected_operation_invalid", expectedOffset, expectedValue, cursor, 0);
    const target = expectedOperation.data;
    if (target.type !== "list_item") {
      const item = misplaced[cursor];
      if (!item) return reject("ordinary_operation_missing", expectedOffset, target, cursor, 0);
      let operation: unknown;
      try {
        operation = operationsFromDocument({
          documentId: "historical-repair",
          body: { content: [item] },
        } as never).operations[0];
      } catch {
        return reject("ordinary_operation_not_decodable", expectedOffset, target, cursor, 0);
      }
      if (JSON.stringify(operation) !== JSON.stringify(target))
        return reject("ordinary_operation_mismatch", expectedOffset, target, cursor, 1);
      decoded.push(target);
      cursor += 1;
      continue;
    }

    // When the old table index placed a multi-line list item inside a cell,
    // Google normalised its U+000B line breaks into several paragraphs. The
    // first retains the bullet plus our hidden ORDERED/UNORDERED marker, while
    // some live responses omit both from plain continuation paragraphs.
    // Reassemble only when every paragraph is an exact next line of the frozen
    // operation and the final text, spans and ordering match byte-for-byte.
    let text = "";
    const spans: Span[] = [];
    let consumed = 0;
    let complete = false;
    while (cursor + consumed < misplaced.length) {
      const actualIndex = cursor + consumed;
      const paragraph = misplaced[actualIndex]?.paragraph;
      if (!paragraph)
        return reject(
          "list_structural_element_not_paragraph",
          expectedOffset,
          target,
          actualIndex,
          consumed,
        );
      const markerType = listTypeFromParagraph(paragraph);
      if (consumed === 0) {
        if (!paragraph.bullet)
          return reject(
            "first_list_paragraph_missing_bullet",
            expectedOffset,
            target,
            actualIndex,
            consumed,
          );
        if (markerType === null)
          return reject("first_list_marker_missing", expectedOffset, target, actualIndex, consumed);
      } else if (!paragraph.bullet) {
        if (markerType !== null || !isPlainHistoricalListContinuation(paragraph))
          return reject(
            "bulletless_list_continuation_not_plain",
            expectedOffset,
            target,
            actualIndex,
            consumed,
          );
        bulletlessContinuationCount += 1;
      }
      if (markerType !== null && markerType !== target.ordered)
        return reject("list_marker_order_mismatch", expectedOffset, target, actualIndex, consumed);
      const rich = richFromParagraph(paragraph);
      if (rich.text.startsWith(COMPLETE_PREFIX))
        return reject(
          "completion_marker_inside_suffix",
          expectedOffset,
          target,
          actualIndex,
          consumed,
        );
      const offset = text.length + (consumed ? 1 : 0);
      text += `${consumed ? "\n" : ""}${rich.text}`;
      spans.push(
        ...rich.spans.map((span) => ({
          ...span,
          start: span.start + offset,
          end: span.end + offset,
        })),
      );
      consumed += 1;
      if (text === target.text) {
        const sortedSpans = spans.sort(
          (left, right) =>
            left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind),
        );
        const candidate = GoogleDocsOperationSchema.safeParse({
          type: "list_item",
          ordered: target.ordered,
          text,
          spans: sortedSpans,
        });
        if (!candidate.success || JSON.stringify(candidate.data) !== JSON.stringify(target))
          return reject(
            "list_spans_or_schema_mismatch",
            expectedOffset,
            target,
            actualIndex,
            consumed,
          );
        decoded.push(candidate.data);
        cursor += consumed;
        complete = true;
        break;
      }
      if (!target.text.startsWith(`${text}\n`))
        return reject("list_text_mismatch", expectedOffset, target, actualIndex, consumed);
    }
    if (!complete)
      return reject(
        "list_paragraphs_exhausted",
        expectedOffset,
        target,
        cursor + consumed,
        consumed,
      );
  }
  if (cursor !== misplaced.length)
    return reject("extra_misplaced_paragraphs", expected.length, undefined, cursor, 0);
  return {
    operations: decoded,
    detail: {
      decoder_exact_match: true,
      decoded_paragraph_count: cursor,
      decoded_operation_count: decoded.length,
      bulletless_continuation_count: bulletlessContinuationCount,
    },
  };
}

interface Attempt47MergedHeadingDecodeResult {
  readonly operations: GoogleDocsOperation[] | undefined;
  readonly trimmedParagraph?: any;
  readonly deleteRange?: { readonly startIndex: number; readonly endIndex: number };
  readonly styleResetRange?: { readonly startIndex: number; readonly endIndex: number };
  readonly detail: Record<string, string | number | boolean>;
}

function trimHistoricalParagraph(paragraph: any, textLength: number) {
  let remaining = textLength;
  const elements: any[] = [];
  for (const element of paragraph.elements ?? []) {
    const run = element.textRun;
    if (!run || remaining <= 0) break;
    const content = String(run.content ?? "");
    const taken = content.slice(0, Math.min(content.length, remaining));
    if (taken.length) elements.push({ ...element, textRun: { ...run, content: taken } });
    remaining -= taken.length;
  }
  if (remaining !== 0) return undefined;
  if (elements.length)
    elements[elements.length - 1] = {
      ...elements[elements.length - 1],
      textRun: {
        ...elements[elements.length - 1].textRun,
        content: `${elements[elements.length - 1].textRun.content}\n`,
      },
    };
  else elements.push({ textRun: { content: "\n" } });
  return { ...paragraph, elements };
}

/**
 * Attempt 47 proved the exact legacy write shape: operation 60 was inserted at
 * the last cell terminator and merged into its authored paragraph; operations
 * 61-64 followed in canonical order but each five-line list item became five
 * paragraphs; the old completion marker became the final populated in-cell
 * paragraph, followed by the retained original cell terminator.
 */
function decodeAttempt47MergedHeading(
  firstAuthored: any,
  misplaced: any[],
  retainedTerminator: any,
  expected: unknown[],
  expectedStartIndex: number,
  expectedTable: unknown,
  completeMarker: string,
): Attempt47MergedHeadingDecodeResult {
  const expectedTableOperation = GoogleDocsOperationSchema.safeParse(expectedTable);
  const headingOperation = GoogleDocsOperationSchema.safeParse(expected[0]);
  const base = {
    attempt47_expected_operation_start: expectedStartIndex,
    attempt47_expected_operation_count: expected.length,
    attempt47_misplaced_paragraph_count: misplaced.length,
  };
  const reject = (
    reason: string,
    detail: Record<string, string | number | boolean> = {},
  ): Attempt47MergedHeadingDecodeResult => ({
    operations: undefined,
    detail: {
      ...base,
      attempt47_decoder_rejection_reason: reason,
      ...detail,
    },
  });
  if (
    expectedStartIndex !== 60 ||
    expected.length !== 5 ||
    !expectedTableOperation.success ||
    expectedTableOperation.data.type !== "table" ||
    expectedTableOperation.data.rows.length !== 13 ||
    expectedTableOperation.data.rows.some((row) => row.length !== 8) ||
    !headingOperation.success ||
    headingOperation.data.type !== "paragraph" ||
    expected.slice(1).some((operation) => {
      const parsed = GoogleDocsOperationSchema.safeParse(operation);
      return !parsed.success || parsed.data.type !== "list_item" || parsed.data.ordered;
    })
  )
    return reject("expected_attempt47_shape_absent");

  const expectedCell = expectedTableOperation.data.rows.at(-1)?.at(-1);
  const actualCell = firstAuthored?.paragraph
    ? richFromParagraph(firstAuthored.paragraph)
    : undefined;
  if (!expectedCell || !actualCell) return reject("merged_cell_unreadable");
  const heading = headingOperation.data;
  const expectedCombined: Rich = {
    text: `${expectedCell.text}${heading.text}`,
    spans: [
      ...expectedCell.spans,
      ...heading.spans.map((span) => ({
        ...span,
        start: span.start + expectedCell.text.length,
        end: span.end + expectedCell.text.length,
      })),
    ].sort(
      (left, right) =>
        left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind),
    ),
  };
  const cellDetail = {
    merged_cell_actual_text_length: actualCell.text.length,
    merged_cell_expected_text_length: expectedCell.text.length,
    merged_heading_expected_text_length: heading.text.length,
    merged_cell_expected_prefix_matches: actualCell.text.startsWith(expectedCell.text),
    merged_heading_suffix_matches: actualCell.text.slice(expectedCell.text.length) === heading.text,
    merged_cell_text_matches_exact_combination: actualCell.text === expectedCombined.text,
    merged_cell_spans_match_exact_combination:
      JSON.stringify(actualCell.spans) === JSON.stringify(expectedCombined.spans),
    merged_cell_heading_style_matches:
      typeof heading.style === "string" &&
      firstAuthored.paragraph?.paragraphStyle?.namedStyleType === heading.style,
  };
  if (
    !cellDetail.merged_cell_text_matches_exact_combination ||
    !cellDetail.merged_cell_spans_match_exact_combination ||
    !cellDetail.merged_cell_heading_style_matches
  )
    return reject("merged_cell_not_expected_value_plus_heading", cellDetail);

  if (misplaced.length !== 21) return reject("attempt47_paragraph_count_mismatch", cellDetail);
  const markerItem = misplaced.at(-1);
  const markerRich = markerItem?.paragraph ? richFromParagraph(markerItem.paragraph) : undefined;
  const markerMatches =
    markerRich?.text === completeMarker &&
    markerRich.spans.length === 0 &&
    markerItem?.paragraph?.bullet === undefined &&
    listTypeFromParagraph(markerItem?.paragraph) === null;
  const markerDetail = {
    ...cellDetail,
    in_cell_completion_text_length: markerRich?.text.length ?? 0,
    in_cell_completion_matches_expected: markerMatches,
  };
  if (!markerMatches) return reject("in_cell_completion_marker_mismatch", markerDetail);

  const listParagraphs = misplaced.slice(0, -1);
  const markerPositions = listParagraphs.flatMap((item, index) =>
    listTypeFromParagraph(item.paragraph) === false ? [index] : [],
  );
  const exactMarkerPattern = JSON.stringify(markerPositions) === JSON.stringify([0, 5, 10, 15]);
  const everyParagraphBulleted = listParagraphs.every((item) => item.paragraph?.bullet);
  if (!exactMarkerPattern || !everyParagraphBulleted)
    return reject("forward_multiline_list_structure_mismatch", {
      ...markerDetail,
      forward_list_marker_positions_match: exactMarkerPattern,
      forward_list_every_paragraph_bulleted: everyParagraphBulleted,
    });

  const decodedLists = decodeHistoricalMisplacedSuffix(
    listParagraphs,
    expected.slice(1),
    expectedStartIndex + 1,
  );
  if (!decodedLists.operations)
    return reject("forward_multiline_lists_not_exact", {
      ...markerDetail,
      ...decodedLists.detail,
    });
  const operations = [heading, ...decodedLists.operations];
  if (JSON.stringify(operations) !== JSON.stringify(expected))
    return reject("attempt47_canonical_operations_mismatch", markerDetail);

  const firstStart = firstAuthored?.startIndex;
  const firstEnd = firstAuthored?.endIndex;
  const markerEnd = markerItem?.endIndex;
  const terminatorStart = retainedTerminator?.startIndex;
  const terminatorEnd = retainedTerminator?.endIndex;
  const terminatorRich = retainedTerminator?.paragraph
    ? richFromParagraph(retainedTerminator.paragraph)
    : undefined;
  const retainedTerminatorMatches =
    terminatorRich?.text === "" &&
    terminatorRich.spans.length === 0 &&
    retainedTerminator?.paragraph?.bullet === undefined &&
    listTypeFromParagraph(retainedTerminator?.paragraph) === null &&
    (retainedTerminator?.paragraph?.paragraphStyle?.namedStyleType === undefined ||
      retainedTerminator?.paragraph?.paragraphStyle?.namedStyleType === "NORMAL_TEXT") &&
    Number.isInteger(terminatorStart) &&
    Number.isInteger(terminatorEnd) &&
    terminatorStart === markerEnd &&
    terminatorEnd === (terminatorStart as number) + 1;
  if (!retainedTerminatorMatches)
    return reject("retained_cell_terminator_mismatch", {
      ...markerDetail,
      retained_cell_terminator_matches: false,
    });
  const rangesReadable =
    Number.isInteger(firstStart) &&
    Number.isInteger(firstEnd) &&
    Number.isInteger(markerEnd) &&
    firstEnd === listParagraphs[0]?.startIndex;
  if (!rangesReadable) return reject("attempt47_range_unreadable", markerDetail);
  for (let index = 1; index < misplaced.length; index += 1)
    if (misplaced[index]!.startIndex !== misplaced[index - 1]!.endIndex)
      return reject("attempt47_range_not_contiguous", markerDetail);
  const startIndex = (firstStart as number) + expectedCell.text.length;
  const endIndex = markerEnd as number;
  if (endIndex <= startIndex) return reject("attempt47_range_unreadable", markerDetail);
  const trimmedParagraph = trimHistoricalParagraph(
    firstAuthored.paragraph,
    expectedCell.text.length,
  );
  if (!trimmedParagraph) return reject("merged_cell_trim_not_proven", markerDetail);

  return {
    operations,
    trimmedParagraph,
    deleteRange: { startIndex, endIndex },
    styleResetRange: {
      startIndex: firstStart as number,
      endIndex: (firstStart as number) + expectedCell.text.length + 1,
    },
    detail: {
      ...base,
      ...markerDetail,
      ...decodedLists.detail,
      decoder_order: "attempt47_merged_heading_forward_lists",
      merged_heading_recovery: true,
      forward_list_marker_positions_match: true,
      forward_list_every_paragraph_bulleted: true,
      retained_cell_terminator_matches: true,
      attempt47_decoder_exact_match: true,
    },
  };
}

function decodeHistoricalMisplacedSuffixInSupportedOrder(
  misplaced: any[],
  expected: unknown[],
  expectedStartIndex: number,
): HistoricalSuffixDecodeResult {
  const mapping = historicalMisplacedMapping(misplaced, expected, expectedStartIndex);
  if (misplaced.length > HISTORICAL_MAPPING_LIMIT)
    return {
      operations: undefined,
      detail: {
        ...mapping,
        decoder_rejection_reason: "misplaced_mapping_limit_exceeded",
      },
    };

  const forwardIndexes = expected.map((_, index) => expectedStartIndex + index);
  const forward = decodeHistoricalMisplacedSuffix(
    misplaced,
    expected,
    expectedStartIndex,
    forwardIndexes,
  );
  if (forward.operations)
    return {
      operations: forward.operations,
      detail: {
        ...mapping,
        ...forward.detail,
        decoder_order: "forward",
        reversed_suffix_recovery: false,
      },
    };

  // The historical off-by-one inserted every later request at the final table
  // cell's terminating boundary. Live attempt 46 proves canonical forward order
  // is false: a marked tail list item appears where the section heading is
  // expected. That boundary behaviour can materialise a reversed suffix. Accept
  // it only when every operation proves a complete byte-for-byte reverse —
  // never a partial or arbitrary permutation.
  const reversedExpected = [...expected].reverse();
  const reversedIndexes = [...forwardIndexes].reverse();
  const reversed = decodeHistoricalMisplacedSuffix(
    misplaced,
    reversedExpected,
    expectedStartIndex,
    reversedIndexes,
  );
  if (reversed.operations)
    return {
      operations: [...reversed.operations].reverse(),
      detail: {
        ...mapping,
        ...reversed.detail,
        decoder_order: "reversed",
        reversed_suffix_recovery: true,
        forward_decoder_rejection_reason: String(
          forward.detail.decoder_rejection_reason ?? "unknown",
        ),
      },
    };

  return {
    operations: undefined,
    detail: {
      ...mapping,
      ...forward.detail,
      decoder_rejection_reason: "no_supported_suffix_order_match",
      forward_decoder_rejection_reason: String(
        forward.detail.decoder_rejection_reason ?? "unknown",
      ),
      reverse_decoder_rejection_reason: String(
        reversed.detail.decoder_rejection_reason ?? "unknown",
      ),
    },
  };
}

function planHistoricalTableRepair(
  document: z.infer<typeof documentSchema>,
  rendered: ExportRenderResult,
): {
  plan: HistoricalTableRepairPlan | undefined;
  detail: Record<string, string | number | boolean>;
} {
  const expected = canonicalOperations(rendered.operations);
  const body = document.body?.content ?? [];
  // Exactly one table may carry a misplaced suffix, and it must be the last
  // table in the body: the bug appends following operations into it.
  const tableItems = body.filter((item: any) => item.table);
  if (tableItems.length === 0) return notProven("no_table_present");
  const tableItem: any = tableItems.at(-1);
  const rows = tableItem.table.tableRows ?? [];
  const lastRow = rows.at(-1);
  const lastCell = lastRow?.tableCells?.at(-1);
  if (!lastCell) return notProven("table_shape_unreadable");
  const cellParagraphs = structuralParagraphs(lastCell);
  const authored = cellParagraphs.filter(
    (item: any) => richFromParagraph(item.paragraph).text.length > 0,
  );
  // The authored cell value plus at least one misplaced operation paragraph.
  if (authored.length < 2) return notProven("no_misplaced_cell_paragraphs");
  const misplaced = authored.slice(1);

  // Re-decode the document with the misplaced paragraphs pruned. Reusing the
  // ordinary reconstruction keeps every existing structural guard in force.
  const prunedCell = {
    ...lastCell,
    content: (lastCell.content ?? []).filter((item: any) => !misplaced.includes(item)),
  };
  const prunedRows = rows.map((row: any, rowIndex: number) =>
    rowIndex === rows.length - 1
      ? {
          ...row,
          tableCells: row.tableCells.map((cell: any, columnIndex: number) =>
            columnIndex === row.tableCells.length - 1 ? prunedCell : cell,
          ),
        }
      : row,
  );
  const prunedDocument = {
    ...document,
    body: {
      content: body.map((item: any) =>
        item === tableItem ? { ...item, table: { ...item.table, tableRows: prunedRows } } : item,
      ),
    },
  };
  let pruned: ReturnType<typeof operationsFromDocument>;
  try {
    pruned = operationsFromDocument(prunedDocument as never);
  } catch (error) {
    return notProven(
      error instanceof GoogleDocsStructureError ? error.reason : "prefix_not_decodable",
    );
  }
  if (pruned.completion !== null || pruned.completion_count !== 0)
    return notProven("completion_marker_present");
  if (pruned.marker_insertion_index === null) return notProven("insertion_index_unreadable");

  const tableOperationIndex = pruned.operations.length - 1;
  const expectedTable: any = expected[tableOperationIndex];
  if (!expectedTable || expectedTable.type !== "table")
    return notProven("mismatch_operation_not_table");
  const expectedSuffix = expected.slice(pruned.operations.length);
  const suffixDecode = decodeHistoricalMisplacedSuffixInSupportedOrder(
    misplaced,
    expectedSuffix,
    pruned.operations.length,
  );
  let styleResetRange: { startIndex: number; endIndex: number } | undefined;
  let suffixOperations = suffixDecode.operations;
  let suffixDetail = suffixDecode.detail;
  let effectivePruned = pruned;
  let deleteRange: { startIndex: number; endIndex: number } | undefined;
  if (!suffixOperations) {
    const attempt47 = decodeAttempt47MergedHeading(
      authored[0],
      misplaced,
      cellParagraphs.at(-1),
      expectedSuffix,
      pruned.operations.length,
      expectedTable,
      `${COMPLETE_PREFIX}${rendered.render_hash}`,
    );
    if (
      !attempt47.operations ||
      !attempt47.trimmedParagraph ||
      !attempt47.deleteRange ||
      !attempt47.styleResetRange
    )
      return notProven("misplaced_suffix_not_decodable", {
        ...suffixDecode.detail,
        ...attempt47.detail,
      });

    const trimmedCell = {
      ...prunedCell,
      content: (prunedCell.content ?? []).map((item: any) =>
        item === authored[0] ? { ...item, paragraph: attempt47.trimmedParagraph } : item,
      ),
    };
    const trimmedRows = rows.map((row: any, rowIndex: number) =>
      rowIndex === rows.length - 1
        ? {
            ...row,
            tableCells: row.tableCells.map((cell: any, columnIndex: number) =>
              columnIndex === row.tableCells.length - 1 ? trimmedCell : cell,
            ),
          }
        : row,
    );
    const trimmedDocument = {
      ...document,
      body: {
        content: body.map((item: any) =>
          item === tableItem ? { ...item, table: { ...item.table, tableRows: trimmedRows } } : item,
        ),
      },
    };
    try {
      effectivePruned = operationsFromDocument(trimmedDocument as never);
    } catch (error) {
      return notProven(
        error instanceof GoogleDocsStructureError ? error.reason : "trimmed_prefix_not_decodable",
        attempt47.detail,
      );
    }
    if (effectivePruned.completion !== null || effectivePruned.completion_count !== 0)
      return notProven("completion_marker_present_after_trim", attempt47.detail);
    if (effectivePruned.marker_insertion_index === null)
      return notProven("insertion_index_unreadable_after_trim", attempt47.detail);
    suffixOperations = attempt47.operations;
    suffixDetail = { ...suffixDecode.detail, ...attempt47.detail };
    deleteRange = attempt47.deleteRange;
    styleResetRange = attempt47.styleResetRange;
  }
  const detail = {
    historical_repair_eligible: false,
    operation_count: effectivePruned.operations.length,
    expected_operation_count: expected.length,
    misplaced_paragraph_count: misplaced.length,
    misplaced_operation_count: suffixOperations.length,
    ...suffixDetail,
    table_row_count: rows.length,
    table_column_count: lastRow?.tableCells?.length ?? 0,
    malformed_cell_row: rows.length - 1,
    malformed_cell_column: (lastRow?.tableCells?.length ?? 0) - 1,
    mismatch_index: tableOperationIndex,
  };

  // The pruned document must be an exact prefix of the expectation, and the
  // decoded suffix must supply exactly the remaining operations, in order.
  if (effectivePruned.operations.length + suffixOperations.length !== expected.length)
    return { plan: undefined, detail: { ...detail, reason: "operation_totals_mismatch" } };
  for (let i = 0; i < effectivePruned.operations.length; i += 1)
    if (JSON.stringify(effectivePruned.operations[i]) !== JSON.stringify(expected[i]))
      return {
        plan: undefined,
        detail: { ...detail, reason: "prefix_mismatch", mismatch_index: i },
      };
  for (let i = 0; i < suffixOperations.length; i += 1)
    if (
      JSON.stringify(suffixOperations[i]) !==
      JSON.stringify(expected[effectivePruned.operations.length + i])
    )
      return {
        plan: undefined,
        detail: {
          ...detail,
          reason: "misplaced_suffix_mismatch",
          mismatch_index: effectivePruned.operations.length + i,
        },
      };

  // Every repair range is terminal inside the final cell. The attempt-47 path
  // begins inside the authored paragraph after its exact expected value and
  // preserves the final cell terminator; the older path keeps its proven range.
  const misplacedRangeIsTerminal = styleResetRange
    ? cellParagraphs.at(-2) === misplaced.at(-1)
    : cellParagraphs.at(-1) === misplaced.at(-1);
  if (!misplacedRangeIsTerminal)
    return {
      plan: undefined,
      detail: { ...detail, reason: "misplaced_range_not_terminal" },
    };
  if (!deleteRange) {
    const startIndex = misplaced[0]?.startIndex;
    const endIndex = misplaced.at(-1)?.endIndex;
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || endIndex <= startIndex)
      return { plan: undefined, detail: { ...detail, reason: "misplaced_range_unreadable" } };
    for (let index = 1; index < misplaced.length; index += 1)
      if (misplaced[index]!.startIndex !== misplaced[index - 1]!.endIndex)
        return {
          plan: undefined,
          detail: { ...detail, reason: "misplaced_range_not_contiguous" },
        };
    deleteRange = { startIndex: startIndex as number, endIndex: endIndex as number };
  }
  if (effectivePruned.marker_insertion_index === null)
    return { plan: undefined, detail: { ...detail, reason: "insertion_index_unreadable" } };

  const deletedLength = deleteRange.endIndex - deleteRange.startIndex;
  return {
    plan: {
      deleteRange,
      ...(styleResetRange ? { styleResetRange } : {}),
      insertIndex: effectivePruned.marker_insertion_index - deletedLength,
      operations: rendered.operations.slice(effectivePruned.operations.length),
      detail: { ...detail, historical_repair_eligible: true, reason: "historical_table_index_bug" },
    },
    detail: { ...detail, historical_repair_eligible: true },
  };
}

function historicalFinalCellStyleRestored(document: z.infer<typeof documentSchema>) {
  const body = document.body?.content ?? [];
  const tableItem: any = body.filter((item: any) => item.table).at(-1);
  const rows = tableItem?.table?.tableRows ?? [];
  const lastCell = rows.at(-1)?.tableCells?.at(-1);
  if (!lastCell) return false;
  const authored = structuralParagraphs(lastCell).filter(
    (item: any) => richFromParagraph(item.paragraph).text.length > 0,
  );
  return (
    authored.length === 1 &&
    authored[0]?.paragraph?.paragraphStyle?.namedStyleType === "NORMAL_TEXT"
  );
}
function topLevelLegacyListMarkerRanges(
  document: z.infer<typeof documentSchema>,
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  for (const item of document.body?.content ?? []) {
    if (!item.paragraph) continue;
    const raw = (item.paragraph.elements ?? [])
      .map((element: any) => String(element.textRun?.content ?? ""))
      .join("");
    const marker = new RegExp(`^${LIST_MARKER}(ORDERED|UNORDERED)\\u2063`).exec(raw);
    if (!marker) continue;
    const semantics = nativeListSemantics(document, item.paragraph);
    if (
      !semantics.legacyMarker ||
      !Number.isInteger(item.startIndex) ||
      item.startIndex! + marker[0].length >= (item.endIndex ?? 0)
    )
      throw new GoogleDocsStructureError("body_control_text_invalid", {
        reason: "legacy_list_marker_range_invalid",
      });
    ranges.push({
      startIndex: item.startIndex!,
      endIndex: item.startIndex! + marker[0].length,
    });
  }
  return ranges;
}

export class RealGoogleDocsAdapter implements GoogleDocsAdapter {
  constructor(
    private readonly oauth: GoogleOAuthClient,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async export(key: string, rendered: ExportRenderResult): Promise<GoogleDocsExport> {
    let stage = "token_acquisition";
    let status: number | undefined;
    try {
      const accessToken = await this.oauth.accessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
      const completionHash = contentHash(
        JSON.stringify({
          content_hash: rendered.content_hash,
          render_hash: rendered.render_hash,
          format_version: EXPORT_FORMAT_VERSION,
        }),
      );
      const legacyCompletion = `${COMPLETE_PREFIX}${rendered.render_hash}`;
      stage = "drive_lookup";
      let reserved = await this.findReservedDocument(key, headers);
      let documentId = reserved?.id;
      let created = false;
      if (!documentId) {
        stage = "drive_create";
        const response = await boundedFetch(
          this.fetchImpl,
          "https://www.googleapis.com/drive/v3/files?fields=id",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: rendered.title,
              mimeType: "application/vnd.google-apps.document",
              appProperties: {
                mobelaris_provider_idempotency_key: key,
                mobelaris_content_hash: rendered.content_hash,
                mobelaris_render_hash: rendered.render_hash,
                mobelaris_export_format_version: EXPORT_FORMAT_VERSION,
              },
            }),
          },
          10_000,
        );
        if (!response.ok) {
          status = response.status;
          throw new GoogleApiStatusError(response.status);
        }
        documentId = driveFileSchema.parse(await response.json()).id;
        created = true;
        reserved = {
          id: documentId,
          appProperties: {
            mobelaris_provider_idempotency_key: key,
            mobelaris_content_hash: rendered.content_hash,
            mobelaris_render_hash: rendered.render_hash,
            mobelaris_export_format_version: EXPORT_FORMAT_VERSION,
          },
        };
      }

      stage = "docs_read_before_update";
      let firstRaw: z.infer<typeof documentSchema>;
      let first: ReturnType<typeof operationsFromDocument>;
      firstRaw = await this.readRawDocument(documentId, headers);
      try {
        first = operationsFromDocument(firstRaw);
      } catch (error) {
        if (
          !created &&
          error instanceof GoogleDocsStructureError &&
          error.reason === "unsupported_document_structure" &&
          error.detail.unsupported_structure_kind === "table_cell_multiple_nonempty_paragraphs"
        ) {
          stage = "docs_historical_table_repair";
          return await this.repairHistoricalTableCorruptionV2({
            documentId,
            headers,
            key,
            rendered,
            legacyCompletion,
            completionHash,
            firstRaw,
            reservation: this.reservationState(reserved, rendered, documentId),
          });
        }
        throw error;
      }

      const reservation = this.reservationState(reserved, rendered, documentId);
      if (
        !reservation.reserved_document_matches_expected ||
        !reservation.reserved_content_hash_matches_expected ||
        !reservation.reserved_render_hash_matches_expected
      )
        throw new GoogleDocsIdempotencyConflictError("reserved_metadata_mismatch", reservation);

      const metadataComplete = reserved?.appProperties?.mobelaris_export_complete_hash;
      const metadataVersion = reserved?.appProperties?.mobelaris_export_format_version;
      if (
        (metadataComplete !== undefined && metadataComplete !== completionHash) ||
        (metadataComplete !== undefined && metadataVersion !== EXPORT_FORMAT_VERSION) ||
        (metadataVersion !== undefined &&
          metadataVersion !== "1" &&
          metadataVersion !== EXPORT_FORMAT_VERSION)
      )
        throw new GoogleDocsIdempotencyConflictError("reserved_metadata_mismatch", {
          ...reservation,
          completion_metadata_present: metadataComplete !== undefined,
          completion_metadata_matches_expected: metadataComplete === completionHash,
          completion_format_matches_expected: metadataVersion === EXPORT_FORMAT_VERSION,
        });

      const firstState = this.canonicalRereadState(first.operations, rendered);
      if (first.completion_count > 1)
        throw new GoogleDocsIdempotencyConflictError("reserved_document_conflict", {
          ...this.recoveryState(first, rendered, legacyCompletion, !created),
          completion_count: first.completion_count,
        });
      if (first.completion !== null && first.completion !== legacyCompletion)
        throw new GoogleDocsIdempotencyConflictError(
          "completion_marker_mismatch",
          this.recoveryState(first, rendered, legacyCompletion, !created),
        );
      if (first.completion !== null && !firstState.matches)
        throw new GoogleDocsIdempotencyConflictError(
          "canonical_operations_mismatch",
          this.recoveryState(first, rendered, legacyCompletion, !created),
        );
      if (first.operations.length > 0 && !firstState.matches && !firstState.exact_prefix_match)
        throw new GoogleDocsIdempotencyConflictError(
          "reserved_document_not_exact_prefix",
          this.recoveryState(first, rendered, legacyCompletion, !created),
        );

      stage = "docs_recovery_reread";
      const latestRaw = await this.readRawDocument(documentId, headers);
      const latest = operationsFromDocument(latestRaw);
      const latestState = this.canonicalRereadState(latest.operations, rendered);
      if (
        latestRaw.revisionId !== firstRaw.revisionId ||
        latest.completion !== first.completion ||
        latest.completion_count !== first.completion_count ||
        JSON.stringify(latest.legacy_list_marker_ranges) !==
          JSON.stringify(first.legacy_list_marker_ranges) ||
        (!latestState.matches && !latestState.exact_prefix_match)
      )
        throw new GoogleDocsIdempotencyConflictError(
          "reserved_document_changed",
          this.recoveryState(latest, rendered, legacyCompletion, true),
        );
      if (!latestRaw.revisionId || latest.marker_insertion_index === null)
        throw new GoogleDocsIdempotencyConflictError(
          "reserved_document_conflict",
          this.recoveryState(latest, rendered, legacyCompletion, true),
        );

      if (
        latestState.matches &&
        latest.completion === null &&
        latest.completion_count === 0 &&
        latest.legacy_list_marker_ranges.length === 0 &&
        metadataComplete === completionHash &&
        metadataVersion === EXPORT_FORMAT_VERSION
      )
        return this.result(documentId, true);

      const suffix = latestState.matches ? [] : rendered.operations.slice(latest.operations.length);
      const ranges = [
        ...latest.legacy_list_marker_ranges,
        ...(latest.completion === legacyCompletion ? latest.completion_ranges : []),
      ].sort((left, right) => left.startIndex - right.startIndex);
      if (
        latest.completion !== null &&
        (latest.completion_count !== 1 || latest.completion_ranges.length !== 1)
      )
        throw new GoogleDocsIdempotencyConflictError(
          "reserved_document_conflict",
          this.recoveryState(latest, rendered, legacyCompletion, true),
        );
      if (latest.legacy_list_marker_ranges.length > 0 && !latestRaw.lists)
        throw new GoogleDocsStructureError("native_list_metadata_invalid", {
          reason: "legacy_migration_native_lists_missing",
        });
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index]!;
        if (
          !Number.isInteger(range.startIndex) ||
          !Number.isInteger(range.endIndex) ||
          range.endIndex <= range.startIndex ||
          (index > 0 && range.startIndex < ranges[index - 1]!.endIndex)
        )
          throw new GoogleDocsStructureError("body_control_text_invalid", {
            reason: "legacy_migration_range_invalid",
            control_range_count: ranges.length,
          });
      }

      if (suffix.length > 0 || ranges.length > 0) {
        stage = "drive_recovery_confirm";
        const latestReserved = await this.findReservedDocument(key, headers);
        const latestReservation = this.reservationState(latestReserved, rendered, documentId);
        if (
          !latestReservation.reserved_document_matches_expected ||
          !latestReservation.reserved_content_hash_matches_expected ||
          !latestReservation.reserved_render_hash_matches_expected
        )
          throw new GoogleDocsIdempotencyConflictError(
            "reserved_document_changed",
            latestReservation,
          );
        logger.info(
          suffix.length > 0
            ? "google_docs.suffix_recovery_started"
            : "google_docs.legacy_control_migration_started",
          {
            stage: "docs_read_before_update",
            category: "idempotency_recovery",
            reason: suffix.length > 0 ? "exact_prefix_recoverable" : "legacy_controls_proven",
            ...this.recoveryState(latest, rendered, legacyCompletion, true),
            ...latestReservation,
            legacy_control_range_count: ranges.length,
          },
        );
        // A legacy control migration only deletes app-owned control text and
        // restores presentation. It appends no content, so it stays one fenced
        // batch; content is written phase by phase below.
        if (ranges.length > 0) {
          stage = "docs_legacy_control_migration";
          await this.sendFencedBatch({
            documentId,
            headers,
            rendered,
            revisionId: latestRaw.revisionId,
            requests: [
              ...this.presentationRequestsForRawDocument(latestRaw),
              ...[...ranges]
                .sort((left, right) => right.startIndex - left.startIndex)
                .map((range) => ({ deleteContentRange: { range } })),
            ],
            onStatus: (value) => {
              status = value;
            },
          });
        }
        stage = "docs_suffix_recovery_update";
        await this.writeOperationPhases({
          documentId,
          headers,
          rendered,
          onStatus: (value) => {
            status = value;
          },
          onStage: (value) => {
            stage = value;
          },
        });
      }

      stage = "docs_canonical_verify";
      const verified = operationsFromDocument(await this.readRawDocument(documentId, headers));
      this.assertCanonicalReread(verified.operations, rendered);
      if (
        verified.completion !== null ||
        verified.completion_count !== 0 ||
        verified.completion_ranges.length !== 0 ||
        verified.legacy_list_marker_ranges.length !== 0
      )
        throw new GoogleDocsStructureError("canonical_reread_mismatch", {
          operation_count: verified.operations.length,
          expected_operation_count: rendered.operation_count,
          body_control_marker_count:
            verified.completion_count + verified.legacy_list_marker_ranges.length,
        });

      stage = "drive_completion_update";
      const metadataResponse = await boundedFetch(
        this.fetchImpl,
        "https://www.googleapis.com/drive/v3/files/" +
          encodeURIComponent(documentId) +
          "?fields=id,appProperties",
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            appProperties: {
              mobelaris_provider_idempotency_key: key,
              mobelaris_content_hash: rendered.content_hash,
              mobelaris_render_hash: rendered.render_hash,
              mobelaris_export_complete_hash: completionHash,
              mobelaris_export_format_version: EXPORT_FORMAT_VERSION,
            },
          }),
        },
        10_000,
      );
      if (!metadataResponse.ok) {
        const recovered = await this.findReservedDocument(key, headers);
        if (
          recovered?.id !== documentId ||
          recovered.appProperties?.mobelaris_export_complete_hash !== completionHash ||
          recovered.appProperties?.mobelaris_export_format_version !== EXPORT_FORMAT_VERSION
        ) {
          status = metadataResponse.status;
          throw new GoogleApiStatusError(metadataResponse.status);
        }
      }

      stage = "drive_completion_verify";
      const completedReservation = await this.findReservedDocument(key, headers);
      const finalDocument = operationsFromDocument(await this.readRawDocument(documentId, headers));
      this.assertCanonicalReread(finalDocument.operations, rendered);
      if (
        completedReservation?.id !== documentId ||
        completedReservation.appProperties?.mobelaris_content_hash !== rendered.content_hash ||
        completedReservation.appProperties?.mobelaris_render_hash !== rendered.render_hash ||
        completedReservation.appProperties?.mobelaris_export_complete_hash !== completionHash ||
        completedReservation.appProperties?.mobelaris_export_format_version !==
          EXPORT_FORMAT_VERSION ||
        finalDocument.completion !== null ||
        finalDocument.legacy_list_marker_ranges.length !== 0
      )
        throw new GoogleDocsStructureError("canonical_reread_mismatch", {
          operation_count: finalDocument.operations.length,
          expected_operation_count: rendered.operation_count,
          completion_metadata_present:
            completedReservation?.appProperties?.mobelaris_export_complete_hash !== undefined,
          completion_metadata_matches_expected:
            completedReservation?.appProperties?.mobelaris_export_complete_hash === completionHash,
          body_control_marker_count:
            finalDocument.completion_count + finalDocument.legacy_list_marker_ranges.length,
        });
      return this.result(documentId, !created);
    } catch (error) {
      status ??= error instanceof GoogleApiStatusError ? error.status : undefined;
      logger.warn("google_docs.provider_failed", {
        stage,
        category:
          stage === "token_acquisition"
            ? "google_connection"
            : error instanceof GoogleDocsIdempotencyConflictError
              ? "idempotency_conflict"
              : error instanceof GoogleDocsStructureError
                ? "google_structure"
                : "google_api",
        ...(status !== undefined ? { status } : {}),
        ...(error instanceof GoogleDocsStructureError ||
        error instanceof GoogleDocsIdempotencyConflictError
          ? { reason: error.reason, ...error.detail }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.requestIndex !== undefined
          ? { request_index: error.requestIndex }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.requestType
          ? { request_type: error.requestType }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.reportedRequestType
          ? { reported_request_type: error.reportedRequestType }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.reason ? { reason: error.reason } : {}),
        ...(error instanceof GoogleApiStatusError && error.requestShape
          ? { request: error.requestShape }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.previousRequestShape
          ? { previous_request: error.previousRequestShape }
          : {}),
      });
      if (error instanceof GoogleOAuthError || error instanceof GoogleDocsIdempotencyConflictError)
        throw error;
      throw new GoogleOAuthError("Google Docs export failed.");
    }
  }
  private async exportBodyMarkerV1(
    key: string,
    rendered: ExportRenderResult,
  ): Promise<GoogleDocsExport> {
    let stage = "token_acquisition";
    let status: number | undefined;
    try {
      const accessToken = await this.oauth.accessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
      stage = "drive_lookup";
      let reservedDocument = await this.findReservedDocument(key, headers);
      let documentId = reservedDocument?.id;
      let created = false;
      if (!documentId) {
        stage = "drive_create";
        const response = await boundedFetch(
          this.fetchImpl,
          "https://www.googleapis.com/drive/v3/files?fields=id",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: rendered.title,
              mimeType: "application/vnd.google-apps.document",
              appProperties: {
                mobelaris_provider_idempotency_key: key,
                mobelaris_content_hash: rendered.content_hash,
                mobelaris_render_hash: rendered.render_hash,
              },
            }),
          },
          10_000,
        );
        if (!response.ok) {
          status = response.status;
          throw new GoogleApiStatusError(response.status);
        }
        documentId = driveFileSchema.parse(await response.json()).id;
        created = true;
      }
      const completeMarker = `${COMPLETE_PREFIX}${rendered.render_hash}`;
      stage = "docs_read_before_update";
      const existingRaw = await this.readRawDocument(documentId, headers);
      const existingReservationState = this.reservationState(
        reservedDocument,
        rendered,
        documentId,
      );
      let existing: ReturnType<typeof operationsFromDocument>;
      try {
        existing = operationsFromDocument(existingRaw);
      } catch (error) {
        // The historical table-index bug inserted later operations into the
        // final table cell, which canonical reconstruction rightly refuses. Only
        // that exact, provable app-owned shape may be repaired in place; the
        // reconstruction guard is never relaxed.
        if (
          !created &&
          error instanceof GoogleDocsStructureError &&
          error.reason === "unsupported_document_structure" &&
          // Only the exact malformed shape this bug produces. Every other
          // unsupported structure — foreign objects, suggestions, nested tables
          // — keeps its existing fail-closed reason and is never repaired.
          error.detail.unsupported_structure_kind === "table_cell_multiple_nonempty_paragraphs"
        ) {
          stage = "docs_historical_table_repair";
          return await this.repairHistoricalTableCorruption({
            documentId,
            headers,
            key,
            rendered,
            completeMarker,
            firstRaw: existingRaw,
            reservation: existingReservationState,
          });
        }
        throw error;
      }
      const existingState = this.recoveryState(existing, rendered, completeMarker, !created);
      if (existing.completion === completeMarker) {
        if (existing.completion_count !== 1)
          throw new GoogleDocsIdempotencyConflictError("reserved_document_conflict", existingState);
        this.assertCanonicalReread(existing.operations, rendered);
        return this.result(documentId, true);
      }
      if (existing.operations.length || existing.completion !== null) {
        if (existing.completion !== null)
          throw new GoogleDocsIdempotencyConflictError("completion_marker_mismatch", existingState);
        const recoveryMode = existingState.canonical_operations_match_expected
          ? "marker"
          : "suffix";
        if (recoveryMode === "suffix" && !existingState.exact_prefix_match)
          throw new GoogleDocsIdempotencyConflictError(
            "reserved_document_not_exact_prefix",
            existingState,
          );
        if (
          recoveryMode === "suffix" &&
          (!existingReservationState.reserved_content_hash_matches_expected ||
            !existingReservationState.reserved_render_hash_matches_expected)
        )
          throw new GoogleDocsIdempotencyConflictError("reserved_metadata_mismatch", {
            ...existingState,
            ...existingReservationState,
          });

        logger.info(`google_docs.${recoveryMode}_recovery_started`, {
          stage,
          category: "idempotency_recovery",
          reason:
            recoveryMode === "marker"
              ? "missing_completion_marker_recoverable"
              : "incomplete_reserved_document_recoverable",
          ...existingState,
          ...(recoveryMode === "suffix" ? existingReservationState : {}),
        });
        stage = `docs_${recoveryMode}_recovery_reread`;
        const latest = await this.readDocument(documentId, headers);
        const latestState = this.recoveryState(latest, rendered, completeMarker, true);
        if (latest.completion === completeMarker) {
          if (latest.completion_count !== 1)
            throw new GoogleDocsIdempotencyConflictError("reserved_document_conflict", latestState);
          this.assertCanonicalReread(latest.operations, rendered);
          return this.result(documentId, true);
        }
        if (latest.completion !== null)
          throw new GoogleDocsIdempotencyConflictError("completion_marker_mismatch", latestState);
        if (latest.revision_id !== existing.revision_id)
          throw new GoogleDocsIdempotencyConflictError("reserved_document_changed", latestState);
        if (recoveryMode === "marker" && !latestState.canonical_operations_match_expected)
          throw new GoogleDocsIdempotencyConflictError(
            "canonical_operations_mismatch",
            latestState,
          );
        if (
          recoveryMode === "suffix" &&
          (!latestState.exact_prefix_match ||
            latestState.operation_count !== existingState.operation_count)
        )
          throw new GoogleDocsIdempotencyConflictError("reserved_document_changed", latestState);
        if (latest.revision_id === null || latest.marker_insertion_index === null)
          throw new GoogleDocsIdempotencyConflictError("reserved_document_conflict", latestState);

        stage = `drive_${recoveryMode}_recovery_confirm`;
        const latestReservation = await this.findReservedDocument(key, headers);
        const latestReservationState = this.reservationState(
          latestReservation,
          rendered,
          documentId,
        );
        if (!latestReservationState.reserved_document_matches_expected)
          throw new GoogleDocsIdempotencyConflictError("reserved_document_changed", latestState);
        if (
          recoveryMode === "suffix" &&
          (!latestReservationState.reserved_content_hash_matches_expected ||
            !latestReservationState.reserved_render_hash_matches_expected)
        )
          throw new GoogleDocsIdempotencyConflictError("reserved_metadata_mismatch", {
            ...latestState,
            ...latestReservationState,
          });

        const recoveryRequests =
          recoveryMode === "marker"
            ? [this.completionMarkerRequest(completeMarker, latest.marker_insertion_index)]
            : this.nativeRequestsForOperations(
                rendered.operations.slice(latest.operations.length),
                completeMarker,
                latest.marker_insertion_index,
              );
        stage = `docs_${recoveryMode}_recovery_update`;
        const recoveryResponse = await boundedFetch(
          this.fetchImpl,
          "https://docs.googleapis.com/v1/documents/" +
            encodeURIComponent(documentId) +
            ":batchUpdate",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              requests: recoveryRequests,
              writeControl: { requiredRevisionId: latest.revision_id },
            }),
          },
          10_000,
        );
        if (!recoveryResponse.ok) {
          // A concurrent identical recovery may have won the revision race.
          // Reread before reporting the guarded write failure so that delivery
          // remains idempotent without ever attempting a second append.
          stage = `docs_${recoveryMode}_recovery_verify`;
          const concurrent = await this.readDocument(documentId, headers);
          const concurrentState = this.recoveryState(concurrent, rendered, completeMarker, true);
          if (concurrent.completion === completeMarker) {
            if (concurrent.completion_count !== 1)
              throw new GoogleDocsIdempotencyConflictError(
                "reserved_document_conflict",
                concurrentState,
              );
            this.assertCanonicalReread(concurrent.operations, rendered);
            return this.result(documentId, true);
          }
          const concurrentRecoveryStateMatches =
            recoveryMode === "marker"
              ? concurrentState.canonical_operations_match_expected
              : concurrentState.exact_prefix_match &&
                concurrentState.operation_count === latestState.operation_count;
          if (
            concurrent.revision_id !== latest.revision_id ||
            concurrent.completion !== null ||
            !concurrentRecoveryStateMatches
          )
            throw new GoogleDocsIdempotencyConflictError(
              "reserved_document_changed",
              concurrentState,
            );
          status = recoveryResponse.status;
          throw await googleBatchError(recoveryResponse, recoveryRequests);
        }

        stage = "drive_confirm";
        const reserved = await this.findReservedDocument(key, headers);
        stage = `docs_${recoveryMode}_recovery_verify`;
        const confirmed = await this.readDocument(documentId, headers);
        const confirmedState = this.recoveryState(confirmed, rendered, completeMarker, true);
        if (reserved?.id !== documentId)
          throw new GoogleDocsStructureError("reserved_document_mismatch", {
            reserved_present: reserved !== undefined,
          });
        if (
          confirmed.completion !== completeMarker ||
          confirmed.completion_count !== 1 ||
          !confirmedState.canonical_operations_match_expected
        )
          throw new GoogleDocsStructureError(
            recoveryMode === "marker"
              ? "marker_recovery_verification_failed"
              : "suffix_recovery_verification_failed",
            confirmedState,
          );
        logger.info(`google_docs.${recoveryMode}_recovery_succeeded`, {
          stage,
          category: "idempotency_recovery",
          reason:
            recoveryMode === "marker"
              ? "missing_completion_marker_recoverable"
              : "incomplete_reserved_document_recoverable",
          ...confirmedState,
        });
        return this.result(documentId, true);
      }
      stage = "docs_batch_update";
      const requests = this.nativeRequests(rendered, completeMarker);
      const updateResponse = await boundedFetch(
        this.fetchImpl,
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ requests }),
        },
        10_000,
      );
      if (!updateResponse.ok) {
        status = updateResponse.status;
        throw await googleBatchError(updateResponse, requests);
      }
      stage = "drive_confirm";
      const reserved = await this.findReservedDocument(key, headers);
      stage = "docs_read_after_update";
      const confirmed = await this.readDocument(documentId, headers);
      if (reserved?.id !== documentId)
        throw new GoogleDocsStructureError("reserved_document_mismatch", {
          reserved_present: reserved !== undefined,
        });
      if (confirmed.completion !== completeMarker)
        throw new GoogleDocsStructureError("completion_marker_missing", {
          completion_present: confirmed.completion !== null,
          operation_count: confirmed.operations.length,
          expected_operation_count: rendered.operation_count,
        });
      this.assertCanonicalReread(confirmed.operations, rendered);
      return this.result(documentId, !created);
    } catch (error) {
      status ??= error instanceof GoogleApiStatusError ? error.status : undefined;
      logger.warn("google_docs.provider_failed", {
        stage,
        category:
          stage === "token_acquisition"
            ? "google_connection"
            : error instanceof Error && error.message.includes("idempotency conflict")
              ? "idempotency_conflict"
              : error instanceof GoogleDocsStructureError
                ? "google_structure"
                : "google_api",
        ...(status !== undefined ? { status } : {}),
        ...(error instanceof GoogleDocsStructureError ||
        error instanceof GoogleDocsIdempotencyConflictError
          ? { reason: error.reason, ...error.detail }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.requestIndex !== undefined
          ? { request_index: error.requestIndex }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.requestType
          ? { request_type: error.requestType }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.reportedRequestType
          ? { reported_request_type: error.reportedRequestType }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.reason ? { reason: error.reason } : {}),
        ...(error instanceof GoogleApiStatusError && error.requestShape
          ? { request: error.requestShape }
          : {}),
        ...(error instanceof GoogleApiStatusError && error.previousRequestShape
          ? { previous_request: error.previousRequestShape }
          : {}),
      });
      if (
        error instanceof GoogleOAuthError ||
        (error instanceof Error && error.message.includes("idempotency conflict"))
      )
        throw error;
      throw new GoogleOAuthError("Google Docs export failed.");
    }
  }
  /**
   * One `batchUpdate`, fenced on the revision the caller most recently read.
   *
   * A rejected batch is atomic, so the document is unchanged and the next
   * attempt simply re-plans from it. The one case that is not a failure is a
   * concurrent writer having completed the very same export, which is proven by
   * rereading rather than assumed.
   */
  private async sendFencedBatch(input: {
    documentId: string;
    headers: Record<string, string>;
    rendered: ExportRenderResult;
    revisionId: string;
    requests: unknown[];
    onStatus: (status: number) => void;
  }): Promise<void> {
    if (input.requests.length === 0) return;
    const response = await boundedFetch(
      this.fetchImpl,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(input.documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify({
          requests: input.requests,
          writeControl: { requiredRevisionId: input.revisionId },
        }),
      },
      10_000,
    );
    if (response.ok) return;
    const concurrentRaw = await this.readRawDocument(input.documentId, input.headers);
    const concurrent = operationsFromDocument(concurrentRaw);
    const concurrentState = this.canonicalRereadState(concurrent.operations, input.rendered);
    if (
      concurrentState.matches &&
      concurrent.completion === null &&
      concurrent.completion_count === 0 &&
      concurrent.legacy_list_marker_ranges.length === 0
    )
      return;
    if (concurrentRaw.revisionId !== input.revisionId)
      throw new GoogleDocsIdempotencyConflictError("reserved_document_changed", {
        revision_changed: true,
        reserved_document_reused: true,
      });
    input.onStatus(response.status);
    throw await googleBatchError(response, input.requests);
  }

  /**
   * Writes the export in phases, each planned from a fresh read.
   *
   * Every position the plan uses is one Google reported: the append point is the
   * document's trailing paragraph, and a table's own index and its cell indexes
   * are read back after it is created rather than derived from a formula. That
   * is what makes the adapter independent of any particular article shape.
   *
   * Each phase is fenced on the revision it was planned against, and the plan is
   * a pure function of the document, so an interrupted export resumes with no
   * state other than the document itself and can never duplicate content.
   */
  private async writeOperationPhases(input: {
    documentId: string;
    headers: Record<string, string>;
    rendered: ExportRenderResult;
    onStatus: (status: number) => void;
    onStage: (stage: string) => void;
  }): Promise<void> {
    // Two phases per table (create, then fill) plus one per run of paragraphs;
    // the bound is generous and exists only to refuse a non-converging plan.
    const limit = input.rendered.operations.length * 2 + 8;
    let previous: string | null = null;
    for (let phase = 0; phase < limit; phase += 1) {
      const raw = await this.readRawDocument(input.documentId, input.headers);
      const read = operationsFromDocument(raw);
      // A phase that leaves the document exactly as it was has not advanced it,
      // so repeating would loop rather than converge. Fail closed at once.
      const state = JSON.stringify([raw.revisionId, read.operations]);
      if (previous !== null && state === previous) {
        input.onStage("docs_canonical_verify");
        this.assertCanonicalReread(read.operations, input.rendered);
        throw new GoogleDocsStructureError("canonical_reread_mismatch", {
          phase_failure: "phase_made_no_progress",
          operation_count: read.operations.length,
          expected_operation_count: input.rendered.operation_count,
        });
      }
      previous = state;
      if (read.marker_insertion_index === null || !raw.revisionId) {
        // A body that does not end in an empty paragraph is not a document this
        // export can complete, which is a structural verification failure.
        input.onStage("docs_canonical_verify");
        throw new GoogleDocsStructureError("canonical_reread_mismatch", {
          phase_failure: "document_has_no_append_position",
          operation_count: read.operations.length,
          expected_operation_count: input.rendered.operation_count,
        });
      }
      let batch;
      try {
        batch = planNextBatch({
          document: raw,
          present: read.operations,
          target: input.rendered.operations,
          appendIndex: read.marker_insertion_index,
        });
      } catch (error) {
        if (!(error instanceof GoogleDocsWriteConflictError)) throw error;
        // The document is not a prefix of this export, so it can never be
        // advanced into it. Report it as the canonical verification failure it
        // is, with the same safe diagnostics and no document text.
        input.onStage("docs_canonical_verify");
        this.assertCanonicalReread(read.operations, input.rendered);
        throw error;
      }
      if (!batch) return;
      logger.info("google_docs.phase_planned", {
        stage: "docs_phase_write",
        phase: batch.phase,
        phase_index: phase,
        request_count: batch.requests.length,
        operation_count: read.operations.length,
        expected_operation_count: input.rendered.operation_count,
      });
      await this.sendFencedBatch({
        documentId: input.documentId,
        headers: input.headers,
        rendered: input.rendered,
        revisionId: raw.revisionId,
        requests: batch.requests,
        onStatus: input.onStatus,
      });
    }
    input.onStage("docs_canonical_verify");
    throw new GoogleDocsStructureError("canonical_reread_mismatch", {
      phase_failure: "phased_write_did_not_converge",
      expected_operation_count: input.rendered.operation_count,
    });
  }

  private canonicalRereadState(actual: unknown[], rendered: ExportRenderResult) {
    const expected = canonicalOperations(rendered.operations);
    const actualHash = contentHash(JSON.stringify(actual));
    const expectedHash = contentHash(JSON.stringify(expected));
    let matchingPrefixOperationCount = 0;
    while (
      matchingPrefixOperationCount < Math.min(actual.length, expected.length) &&
      JSON.stringify(actual[matchingPrefixOperationCount]) ===
        JSON.stringify(expected[matchingPrefixOperationCount])
    )
      matchingPrefixOperationCount += 1;
    const mismatchIndex =
      matchingPrefixOperationCount < Math.max(actual.length, expected.length)
        ? matchingPrefixOperationCount
        : null;
    return {
      matches: expectedHash === rendered.render_hash && actualHash === rendered.render_hash,
      exact_prefix_match:
        expectedHash === rendered.render_hash &&
        actual.length < expected.length &&
        matchingPrefixOperationCount === actual.length,
      matching_prefix_operation_count: matchingPrefixOperationCount,
      ...(mismatchIndex === null
        ? {}
        : {
            mismatch_index: mismatchIndex,
            mismatch_actual_type: safeOperationType(actual[mismatchIndex]),
            mismatch_expected_type: safeOperationType(expected[mismatchIndex]),
          }),
      operation_count: actual.length,
      expected_operation_count: expected.length,
      expected_hash_matches_render_hash: expectedHash === rendered.render_hash,
      expected,
    };
  }
  private recoveryState(
    document: ReturnType<typeof operationsFromDocument>,
    rendered: ExportRenderResult,
    completeMarker: string,
    reservedDocumentReused: boolean,
  ) {
    const canonical = this.canonicalRereadState(document.operations, rendered);
    return {
      reserved_document_reused: reservedDocumentReused,
      completion_present: document.completion !== null,
      completion_matches_expected: document.completion === completeMarker,
      operation_count: canonical.operation_count,
      expected_operation_count: canonical.expected_operation_count,
      canonical_operations_match_expected: canonical.matches,
      exact_prefix_match: canonical.exact_prefix_match,
      matching_prefix_operation_count: canonical.matching_prefix_operation_count,
      ...(canonical.mismatch_index === undefined
        ? {}
        : {
            mismatch_index: canonical.mismatch_index,
            mismatch_actual_type: canonical.mismatch_actual_type,
            mismatch_expected_type: canonical.mismatch_expected_type,
          }),
    };
  }
  private reservationState(
    reserved: ReservedDriveFile | undefined,
    rendered: ExportRenderResult,
    expectedDocumentId: string,
  ) {
    return {
      reserved_document_matches_expected: reserved?.id === expectedDocumentId,
      reserved_content_hash_matches_expected:
        reserved?.appProperties?.mobelaris_content_hash === rendered.content_hash,
      reserved_render_hash_matches_expected:
        reserved?.appProperties?.mobelaris_render_hash === rendered.render_hash,
    };
  }
  private assertCanonicalReread(actual: unknown[], rendered: ExportRenderResult) {
    const state = this.canonicalRereadState(actual, rendered);
    if (state.matches) return;
    // First differing operation index and its types, so a mismatch is
    // actionable without ever logging document text.
    let index = -1;
    for (let i = 0; i < Math.max(actual.length, state.expected.length); i += 1)
      if (JSON.stringify(actual[i]) !== JSON.stringify(state.expected[i])) {
        index = i;
        break;
      }
    throw new GoogleDocsStructureError("canonical_reread_mismatch", {
      operation_count: actual.length,
      expected_operation_count: state.expected.length,
      expected_hash_matches_render_hash: state.expected_hash_matches_render_hash,
      ...(index >= 0
        ? {
            mismatch_index: index,
            mismatch_actual_type: safeOperationType(actual[index]),
            mismatch_expected_type: safeOperationType(state.expected[index]),
          }
        : {}),
    });
  }
  private completionMarkerRequest(marker: string, index: number) {
    return {
      insertText: {
        location: { index },
        text: marker + "\n",
      },
    };
  }
  private nativeRequests(rendered: ExportRenderResult, marker: string): unknown[] {
    return this.nativeRequestsForOperations(rendered.operations, marker, 1);
  }
  private nativeRequestsForOperations(
    operations: GoogleDocsOperation[],
    marker: string,
    startIndex: number,
  ): unknown[] {
    let index = startIndex;
    const requests: any[] = [];
    const styles = (start: number, rich: Rich) => {
      for (const span of rich.spans)
        requests.push({
          updateTextStyle: {
            range: { startIndex: start + span.start, endIndex: start + span.end },
            textStyle:
              span.kind === "link"
                ? { link: { url: span.target } }
                : span.kind === "bold"
                  ? { bold: true }
                  : span.kind === "italic"
                    ? { italic: true }
                    : { weightedFontFamily: { fontFamily: "Roboto Mono" } },
            fields:
              span.kind === "link"
                ? "link"
                : span.kind === "code"
                  ? "weightedFontFamily"
                  : span.kind,
          },
        });
    };
    const typography = (
      start: number,
      rich: Rich,
      role: string = "NORMAL_TEXT",
      tableHeader = false,
    ) => {
      if (!rich.text.length) return;
      const fontSize =
        role === "TITLE"
          ? 22
          : role === "HEADING_1"
            ? 19
            : role === "HEADING_2"
              ? 15
              : role === "HEADING_3"
                ? 13
                : tableHeader
                  ? 9.5
                  : role === "TABLE_BODY"
                    ? 9
                    : 11;
      requests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: start + toDocsText(rich.text).length },
          textStyle: {
            weightedFontFamily: { fontFamily: "Arial" },
            fontSize: { magnitude: fontSize, unit: "PT" },
            bold: tableHeader || role === "TITLE" || role.startsWith("HEADING_"),
            foregroundColor: BODY_TEXT_COLOUR,
          },
          fields: "weightedFontFamily,fontSize,bold,foregroundColor",
        },
      });
    };
    const insert = (
      rich: Rich,
      paragraph?: {
        style?: string;
        quote?: boolean;
        list?: "ordered" | "bullet";
        nestingLevel?: number;
      },
    ) => {
      const structuralPrefix = paragraph?.list ? "\t".repeat(paragraph.nestingLevel ?? 0) : "",
        start = index,
        contentStart = start,
        // Leading tabs are consumed by createParagraphBullets to establish nesting.
        // U+000B keeps authored line breaks inside the same semantic list item.
        value = `${structuralPrefix}${toDocsText(rich.text)}\n`,
        finalLength = toDocsText(rich.text).length + 1;
      requests.push({ insertText: { location: { index }, text: value } });
      if (paragraph?.style)
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: start + value.length },
            paragraphStyle: {
              namedStyleType: paragraph.style,
              spaceAbove: {
                magnitude:
                  paragraph.style === "TITLE"
                    ? 12
                    : paragraph.style.startsWith("HEADING_")
                      ? 10
                      : 0,
                unit: "PT",
              },
              spaceBelow: {
                magnitude: paragraph.style === "NORMAL_TEXT" ? 6 : 8,
                unit: "PT",
              },
            },
            fields: "namedStyleType,spaceAbove,spaceBelow",
          },
        });
      if (paragraph?.quote)
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: start + value.length },
            paragraphStyle: { indentStart: { magnitude: 18, unit: "PT" } },
            fields: "indentStart",
          },
        });
      if (paragraph?.list)
        requests.push({
          createParagraphBullets: {
            range: { startIndex: start, endIndex: start + value.length },
            bulletPreset:
              paragraph.list === "ordered"
                ? "NUMBERED_DECIMAL_NESTED"
                : "BULLET_DISC_CIRCLE_SQUARE",
          },
        });
      typography(contentStart, rich, paragraph?.style ?? "NORMAL_TEXT");
      styles(contentStart, rich);
      index += finalLength;
    };
    for (const operation of operations) {
      if (operation.type === "paragraph") insert(operation, { style: operation.style });
      else if (operation.type === "blockquote") insert(operation, { quote: true });
      else if (operation.type === "list_item")
        insert(operation, {
          list: operation.ordered ? "ordered" : "bullet",
          nestingLevel: operation.nesting_level ?? 0,
        });
      else if (operation.type === "image_marker") insert({ text: operation.text, spans: [] });
      else {
        const rows = operation.rows.length,
          columns = operation.rows[0]!.length;
        if (operation.rows.some((row) => row.length !== columns))
          throw new Error("Google Docs tables must be rectangular");
        const tableIndex = index;
        // Google inserts a structural newline before a table, so table-scoped
        // requests must address insertion index + 1. Cell text offsets below
        // are intentionally based on the insertion index (first cell = +4).
        const tableStartIndex = tableIndex + 1;
        requests.push({ insertTable: { rows, columns, location: { index: tableIndex } } });
        // Derived from the cell-paragraph formula below rather than guessed: the
        // last cell's paragraph sits at tableIndex + 2·R·C + R + 1, and that
        // paragraph's own newline occupies one further index, so the first index
        // AFTER the table is tableIndex + 2·R·C + R + 2.
        //
        // The historical value omitted that final newline (…+ R + 1), so every
        // operation following a table was inserted onto the last cell's
        // paragraph — inside the table — instead of after it.
        const tableSize = 2 * rows * columns + rows + 2;
        index += tableSize;
        for (let r = rows - 1; r >= 0; r--)
          for (let c = columns - 1; c >= 0; c--) {
            const cell = operation.rows[r]![c]!,
              // Google places the first cell paragraph at tableStart + 4.
              // Populate in reverse order so inserted text cannot shift the
              // still-pending cell indices.
              cellIndex = tableIndex + 4 + r * (2 * columns + 1) + c * 2;
            if (cell.text) {
              // A newline inside a cell would otherwise split it into a second
              // cell paragraph; keep one cell to one paragraph.
              const cellText = toDocsText(cell.text);
              requests.push({ insertText: { location: { index: cellIndex }, text: cellText } });
              typography(cellIndex, cell, r === 0 ? "TABLE_HEADER" : "TABLE_BODY", r === 0);
              styles(cellIndex, cell);
              index += cellText.length;
            }
          }
        requests.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: { index: tableStartIndex },
                rowIndex: 0,
                columnIndex: 0,
              },
              rowSpan: rows,
              columnSpan: columns,
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
              tableCellLocation: {
                tableStartLocation: { index: tableStartIndex },
                rowIndex: 0,
                columnIndex: 0,
              },
              rowSpan: 1,
              columnSpan: columns,
            },
            tableCellStyle: {
              backgroundColor: {
                color: { rgbColor: { red: 0.93, green: 0.91, blue: 0.88 } },
              },
            },
            fields: "backgroundColor",
          },
        });
        requests.push({
          pinTableHeaderRows: {
            tableStartLocation: { index: tableStartIndex },
            pinnedHeaderRowsCount: 1,
          },
        });
        if (index < tableIndex + tableSize)
          throw new Error(
            "Google Docs table index calculation placed following content inside a cell",
          );
      }
    }
    return requests;
  }
  private presentationRequestsForRawDocument(document: z.infer<typeof documentSchema>): unknown[] {
    const requests: any[] = [];
    const applyText = (
      item: any,
      rich: Rich,
      fontSize: number,
      bold?: boolean,
      markerLength = 0,
    ) => {
      if (!rich.text.length) return;
      const startIndex = item.startIndex;
      const endIndex = item.endIndex;
      if (
        !Number.isInteger(startIndex) ||
        !Number.isInteger(endIndex) ||
        endIndex! <= startIndex! + markerLength
      )
        throw new GoogleDocsStructureError("unsupported_document_structure", {
          unsupported_structure_count: 1,
          unsupported_structure_kind: "presentation_range_unreadable",
        });
      requests.push({
        updateTextStyle: {
          range: { startIndex, endIndex: endIndex! - 1 },
          textStyle: {
            weightedFontFamily: { fontFamily: "Arial" },
            fontSize: { magnitude: fontSize, unit: "PT" },
            foregroundColor: BODY_TEXT_COLOUR,
            ...(bold === undefined ? {} : { bold }),
          },
          fields:
            "weightedFontFamily,fontSize,foregroundColor" + (bold === undefined ? "" : ",bold"),
        },
      });
      for (const span of rich.spans)
        if (span.kind === "code")
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: startIndex! + markerLength + span.start,
                endIndex: startIndex! + markerLength + span.end,
              },
              textStyle: { weightedFontFamily: { fontFamily: "Roboto Mono" } },
              fields: "weightedFontFamily",
            },
          });
    };
    for (const item of document.body?.content ?? []) {
      if (item.paragraph) {
        const rich = richFromParagraph(item.paragraph);
        if (!rich.text || rich.text.startsWith(COMPLETE_PREFIX)) continue;
        const style = item.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
        const markerLength =
          new RegExp(`^${LIST_MARKER}(?:ORDERED|UNORDERED)\\u2063`).exec(
            (item.paragraph.elements ?? [])
              .map((element: any) => String(element.textRun?.content ?? ""))
              .join(""),
          )?.[0].length ?? 0;
        const fontSize =
          style === "TITLE"
            ? 22
            : style === "HEADING_1"
              ? 19
              : style === "HEADING_2"
                ? 15
                : style === "HEADING_3"
                  ? 13
                  : 11;
        const heading = /^(?:TITLE|HEADING_[1-3])$/.test(style);
        applyText(item, rich, fontSize, heading ? true : undefined, markerLength);
        if (!Number.isInteger(item.startIndex) || !Number.isInteger(item.endIndex))
          throw new GoogleDocsStructureError("unsupported_document_structure", {
            unsupported_structure_count: 1,
            unsupported_structure_kind: "presentation_range_unreadable",
          });
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: item.startIndex, endIndex: item.endIndex },
            paragraphStyle: {
              ...(item.paragraph.bullet ? {} : { namedStyleType: style }),
              spaceAbove: {
                magnitude: style === "TITLE" ? 12 : heading ? 10 : 0,
                unit: "PT",
              },
              spaceBelow: { magnitude: style === "NORMAL_TEXT" ? 6 : 8, unit: "PT" },
            },
            fields: (item.paragraph.bullet ? "" : "namedStyleType,") + "spaceAbove,spaceBelow",
          },
        });
      } else if (item.table) {
        if (!Number.isInteger(item.startIndex))
          throw new GoogleDocsStructureError("unsupported_document_structure", {
            unsupported_structure_count: 1,
            unsupported_structure_kind: "presentation_table_index_unreadable",
          });
        const rows = item.table.tableRows ?? [];
        const columns = rows[0]?.tableCells?.length ?? 0;
        if (
          rows.length === 0 ||
          columns === 0 ||
          rows.some((row: any) => row.tableCells?.length !== columns)
        )
          throw new GoogleDocsStructureError("unsupported_document_structure", {
            unsupported_structure_count: 1,
            unsupported_structure_kind: "presentation_table_shape_invalid",
          });
        rows.forEach((row: any, rowIndex: number) =>
          row.tableCells.forEach((cell: any) =>
            (cell.content ?? []).forEach((cellItem: any) => {
              if (!cellItem.paragraph) return;
              const rich = richFromParagraph(cellItem.paragraph, rowIndex === 0);
              applyText(
                cellItem,
                rich,
                rowIndex === 0 ? 9.5 : 9,
                rowIndex === 0 ? true : undefined,
              );
            }),
          ),
        );
        requests.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: { index: item.startIndex },
                rowIndex: 0,
                columnIndex: 0,
              },
              rowSpan: rows.length,
              columnSpan: columns,
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
              tableCellLocation: {
                tableStartLocation: { index: item.startIndex },
                rowIndex: 0,
                columnIndex: 0,
              },
              rowSpan: 1,
              columnSpan: columns,
            },
            tableCellStyle: {
              backgroundColor: {
                color: { rgbColor: { red: 0.93, green: 0.91, blue: 0.88 } },
              },
            },
            fields: "backgroundColor",
          },
        });
        requests.push({
          pinTableHeaderRows: {
            tableStartLocation: { index: item.startIndex },
            pinnedHeaderRowsCount: 1,
          },
        });
      }
    }
    return requests;
  }
  private async findReservedDocument(key: string, headers: Record<string, string>) {
    const escaped = key.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const query = `trashed = false and appProperties has { key='mobelaris_provider_idempotency_key' and value='${escaped}' }`;
    const response = await retryingBoundedFetch(
      this.fetchImpl,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,appProperties)&pageSize=2`,
      { method: "GET", headers },
      10_000,
    );
    if (!response.ok) throw new GoogleApiStatusError(response.status);
    const files = driveFilesSchema.parse(await response.json()).files;
    if (files.length > 1) throw new Error("Export idempotency conflict");
    return files[0];
  }
  /**
   * Repairs the one proven app-owned corruption in place, under a Google
   * revision fence. Operations 0–59 are never rewritten, the document is never
   * cleared, and no second document is ever created. Every unproven condition
   * fails closed with no write at all.
   */
  private async repairHistoricalTableCorruptionV2(input: {
    documentId: string;
    headers: Record<string, string>;
    key: string;
    rendered: ExportRenderResult;
    legacyCompletion: string;
    completionHash: string;
    firstRaw: z.infer<typeof documentSchema>;
    reservation: ReturnType<RealGoogleDocsAdapter["reservationState"]>;
  }): Promise<GoogleDocsExport> {
    const { documentId, headers, key, rendered, legacyCompletion, completionHash } = input;
    const first = planHistoricalTableRepair(input.firstRaw, rendered);
    const firstMarkers = topLevelLegacyListMarkerRanges(input.firstRaw);
    const firstReserved = await this.findReservedDocument(key, headers);
    if (
      !first.plan ||
      !input.firstRaw.revisionId ||
      !input.reservation.reserved_document_matches_expected ||
      !input.reservation.reserved_content_hash_matches_expected ||
      !input.reservation.reserved_render_hash_matches_expected ||
      (firstReserved?.appProperties?.mobelaris_export_complete_hash !== undefined &&
        firstReserved.appProperties.mobelaris_export_complete_hash !== completionHash)
    )
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
        ...first.detail,
        ...input.reservation,
        revision_fence_present: Boolean(input.firstRaw.revisionId),
        completion_metadata_conflict:
          firstReserved?.appProperties?.mobelaris_export_complete_hash !== undefined &&
          firstReserved.appProperties.mobelaris_export_complete_hash !== completionHash,
      });

    logger.info("google_docs.historical_table_repair_started", {
      stage: "docs_historical_table_repair",
      category: "idempotency_recovery",
      reason: "historical_table_index_bug",
      revision_fence_present: true,
      reserved_document_reused: true,
      legacy_list_marker_count: firstMarkers.length,
      ...first.plan.detail,
    });

    const latestRaw = await this.readRawDocument(documentId, headers);
    const latest = planHistoricalTableRepair(latestRaw, rendered);
    const latestMarkers = topLevelLegacyListMarkerRanges(latestRaw);
    const latestReserved = await this.findReservedDocument(key, headers);
    const latestReservation = this.reservationState(latestReserved, rendered, documentId);
    if (
      !latest.plan ||
      latestRaw.revisionId !== input.firstRaw.revisionId ||
      JSON.stringify(latest.plan.deleteRange) !== JSON.stringify(first.plan.deleteRange) ||
      JSON.stringify(latest.plan.styleResetRange) !== JSON.stringify(first.plan.styleResetRange) ||
      latest.plan.insertIndex !== first.plan.insertIndex ||
      JSON.stringify(latestMarkers) !== JSON.stringify(firstMarkers) ||
      !latestReservation.reserved_document_matches_expected ||
      !latestReservation.reserved_content_hash_matches_expected ||
      !latestReservation.reserved_render_hash_matches_expected
    )
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
        ...(latest.plan?.detail ?? latest.detail),
        ...latestReservation,
        reason: "reserved_document_changed",
      });

    const markerRanges = [...latestMarkers].sort(
      (left, right) => right.startIndex - left.startIndex,
    );
    const markerLengthBeforeInsertion = markerRanges
      .filter((range) => range.startIndex < latest.plan!.insertIndex)
      .reduce((total, range) => total + range.endIndex - range.startIndex, 0);
    const requests = [
      ...this.presentationRequestsForRawDocument(latestRaw),
      { deleteContentRange: { range: latest.plan.deleteRange } },
      ...(latest.plan.styleResetRange
        ? [
            {
              updateParagraphStyle: {
                range: latest.plan.styleResetRange,
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                fields: "namedStyleType",
              },
            },
          ]
        : []),
      ...markerRanges.map((range) => ({ deleteContentRange: { range } })),
      ...this.nativeRequestsForOperations(
        latest.plan.operations,
        "",
        latest.plan.insertIndex - markerLengthBeforeInsertion,
      ),
    ];
    const response = await boundedFetch(
      this.fetchImpl,
      "https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId) + ":batchUpdate",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          requests,
          writeControl: { requiredRevisionId: latestRaw.revisionId },
        }),
      },
      10_000,
    );
    if (!response.ok) {
      const concurrent = operationsFromDocument(await this.readRawDocument(documentId, headers));
      const concurrentReservation = this.reservationState(
        await this.findReservedDocument(key, headers),
        rendered,
        documentId,
      );
      const concurrentState = this.canonicalRereadState(concurrent.operations, rendered);
      if (
        !concurrentReservation.reserved_document_matches_expected ||
        !concurrentReservation.reserved_content_hash_matches_expected ||
        !concurrentReservation.reserved_render_hash_matches_expected
      )
        throw new GoogleDocsIdempotencyConflictError(
          "reserved_document_changed",
          concurrentReservation,
        );
      if (
        !concurrentState.matches ||
        concurrent.completion !== null ||
        concurrent.legacy_list_marker_ranges.length !== 0
      )
        throw await googleBatchError(response, requests);
    }

    const verified = operationsFromDocument(await this.readRawDocument(documentId, headers));
    this.assertCanonicalReread(verified.operations, rendered);
    if (
      verified.completion !== null ||
      verified.completion_count !== 0 ||
      verified.legacy_list_marker_ranges.length !== 0
    )
      throw new GoogleDocsStructureError("historical_table_repair_verification_failed", {
        operation_count: verified.operations.length,
        expected_operation_count: rendered.operation_count,
        body_control_marker_count:
          verified.completion_count + verified.legacy_list_marker_ranges.length,
      });

    const metadataResponse = await boundedFetch(
      this.fetchImpl,
      "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(documentId) +
        "?fields=id,appProperties",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          appProperties: {
            mobelaris_provider_idempotency_key: key,
            mobelaris_content_hash: rendered.content_hash,
            mobelaris_render_hash: rendered.render_hash,
            mobelaris_export_complete_hash: completionHash,
            mobelaris_export_format_version: EXPORT_FORMAT_VERSION,
          },
        }),
      },
      10_000,
    );
    if (!metadataResponse.ok) {
      const recovered = await this.findReservedDocument(key, headers);
      if (
        recovered?.id !== documentId ||
        recovered.appProperties?.mobelaris_export_complete_hash !== completionHash ||
        recovered.appProperties?.mobelaris_export_format_version !== EXPORT_FORMAT_VERSION
      )
        throw new GoogleApiStatusError(metadataResponse.status);
    }

    const completed = await this.findReservedDocument(key, headers);
    const finalDocument = operationsFromDocument(await this.readRawDocument(documentId, headers));
    this.assertCanonicalReread(finalDocument.operations, rendered);
    if (
      completed?.id !== documentId ||
      completed.appProperties?.mobelaris_export_complete_hash !== completionHash ||
      completed.appProperties?.mobelaris_export_format_version !== EXPORT_FORMAT_VERSION ||
      finalDocument.completion !== null ||
      finalDocument.legacy_list_marker_ranges.length !== 0
    )
      throw new GoogleDocsStructureError("historical_table_repair_verification_failed", {
        operation_count: finalDocument.operations.length,
        expected_operation_count: rendered.operation_count,
        completion_metadata_matches_expected:
          completed?.appProperties?.mobelaris_export_complete_hash === completionHash,
        body_control_marker_count:
          finalDocument.completion_count + finalDocument.legacy_list_marker_ranges.length,
      });
    logger.info("google_docs.historical_table_repair_succeeded", {
      stage: "docs_historical_table_repair_verify",
      category: "idempotency_recovery",
      reason: "historical_table_index_bug",
      operation_count: finalDocument.operations.length,
      expected_operation_count: rendered.operation_count,
      canonical_operations_match_expected: true,
      body_control_marker_count: 0,
      completion_metadata_matches_expected: true,
    });
    return this.result(documentId, true);
  }
  private async repairHistoricalTableCorruption(input: {
    documentId: string;
    headers: Record<string, string>;
    key: string;
    rendered: ExportRenderResult;
    completeMarker: string;
    firstRaw: z.infer<typeof documentSchema>;
    reservation: ReturnType<RealGoogleDocsAdapter["reservationState"]>;
  }): Promise<GoogleDocsExport> {
    const { documentId, headers, key, rendered, completeMarker } = input;
    const first = planHistoricalTableRepair(input.firstRaw, rendered);
    // Drive metadata must already bind this reservation to the frozen export.
    if (
      !input.reservation.reserved_document_matches_expected ||
      !input.reservation.reserved_content_hash_matches_expected ||
      !input.reservation.reserved_render_hash_matches_expected
    )
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
        ...first.detail,
        ...input.reservation,
        reason: "reserved_metadata_mismatch",
      });
    if (!first.plan)
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", first.detail);
    if (input.firstRaw.revisionId === undefined || input.firstRaw.revisionId === null)
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
        ...first.detail,
        reason: "revision_fence_absent",
        revision_fence_present: false,
      });

    logger.info("google_docs.historical_table_repair_started", {
      stage: "docs_historical_table_repair",
      category: "idempotency_recovery",
      reason: "historical_table_index_bug",
      revision_fence_present: true,
      reserved_document_reused: true,
      ...first.plan.detail,
    });

    // Immediately reread and require the identical malformed state, revision and
    // reservation before any write is attempted.
    const latestRaw = await this.readRawDocument(documentId, headers);
    const latest = planHistoricalTableRepair(latestRaw, rendered);
    const latestReservation = this.reservationState(
      await this.findReservedDocument(key, headers),
      rendered,
      documentId,
    );
    if (
      !latest.plan ||
      latestRaw.revisionId !== input.firstRaw.revisionId ||
      !latestReservation.reserved_document_matches_expected ||
      latest.plan.deleteRange.startIndex !== first.plan.deleteRange.startIndex ||
      latest.plan.deleteRange.endIndex !== first.plan.deleteRange.endIndex ||
      JSON.stringify(latest.plan.styleResetRange) !== JSON.stringify(first.plan.styleResetRange) ||
      latest.plan.insertIndex !== first.plan.insertIndex ||
      latest.plan.operations.length !== first.plan.operations.length ||
      !latestReservation.reserved_content_hash_matches_expected ||
      !latestReservation.reserved_render_hash_matches_expected
    )
      throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
        ...(latest.plan?.detail ?? latest.detail),
        ...latestReservation,
        reason: "reserved_document_changed",
      });

    // One atomic, revision-fenced batch: delete only the proven appended range,
    // restore the final cell's proven paragraph style, then insert operations
    // 60-64 after the table plus exactly one marker.
    const requests = [
      { deleteContentRange: { range: latest.plan.deleteRange } },
      ...(latest.plan.styleResetRange
        ? [
            {
              updateParagraphStyle: {
                range: latest.plan.styleResetRange,
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                fields: "namedStyleType",
              },
            },
          ]
        : []),
      ...this.nativeRequestsForOperations(
        latest.plan.operations,
        completeMarker,
        latest.plan.insertIndex,
      ),
    ];
    const response = await boundedFetch(
      this.fetchImpl,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          requests,
          writeControl: { requiredRevisionId: latestRaw.revisionId },
        }),
      },
      10_000,
    );
    if (!response.ok) {
      // A concurrent identical repair may have won the revision race. Only a
      // reread and exact Drive reservation proving success may report success;
      // never a second write.
      const concurrentRaw = await this.readRawDocument(documentId, headers);
      const concurrent = operationsFromDocument(concurrentRaw);
      const concurrentCellStyleRestored = historicalFinalCellStyleRestored(concurrentRaw);
      const concurrentReservation = this.reservationState(
        await this.findReservedDocument(key, headers),
        rendered,
        documentId,
      );
      const concurrentState = this.recoveryState(concurrent, rendered, completeMarker, true);
      const concurrentReservationMatches =
        concurrentReservation.reserved_document_matches_expected &&
        concurrentReservation.reserved_content_hash_matches_expected &&
        concurrentReservation.reserved_render_hash_matches_expected;
      if (
        concurrentReservationMatches &&
        concurrent.completion === completeMarker &&
        concurrent.completion_count === 1 &&
        (!latest.plan.styleResetRange || concurrentCellStyleRestored) &&
        concurrentState.canonical_operations_match_expected
      )
        return this.result(documentId, true);
      if (!concurrentReservationMatches)
        throw new GoogleDocsStructureError("historical_table_repair_not_proven", {
          ...concurrentState,
          ...concurrentReservation,
          reason: "reserved_document_changed",
        });
      throw await googleBatchError(response, requests);
    }

    // Post-repair verification: same reservation, exactly one marker, exact
    // canonical equality against the frozen render hash.
    const confirmedReservation = this.reservationState(
      await this.findReservedDocument(key, headers),
      rendered,
      documentId,
    );
    const confirmedRaw = await this.readRawDocument(documentId, headers);
    const confirmed = operationsFromDocument(confirmedRaw);
    const confirmedCellStyleRestored = historicalFinalCellStyleRestored(confirmedRaw);
    const confirmedState = this.recoveryState(
      confirmed,
      rendered,
      completeMarker,
      confirmedReservation.reserved_document_matches_expected,
    );
    if (
      !confirmedReservation.reserved_document_matches_expected ||
      !confirmedReservation.reserved_content_hash_matches_expected ||
      !confirmedReservation.reserved_render_hash_matches_expected ||
      confirmed.completion !== completeMarker ||
      confirmed.completion_count !== 1 ||
      (latest.plan.styleResetRange !== undefined && !confirmedCellStyleRestored) ||
      !confirmedState.canonical_operations_match_expected
    )
      throw new GoogleDocsStructureError("historical_table_repair_verification_failed", {
        ...confirmedState,
        final_cell_style_restored: confirmedCellStyleRestored,
        ...confirmedReservation,
        completion_count: confirmed.completion_count,
      });
    logger.info("google_docs.historical_table_repair_succeeded", {
      stage: "docs_historical_table_repair_verify",
      category: "idempotency_recovery",
      reason: "historical_table_index_bug",
      ...confirmedState,
      final_cell_style_restored: confirmedCellStyleRestored,
    });
    return this.result(documentId, true);
  }
  /** Schema-validated document, before canonical reconstruction. */
  private async readRawDocument(documentId: string, headers: Record<string, string>) {
    // Google partial-response masks use slash traversal, not JavaScript-style
    // dotted paths. Request complete body structural elements so unsupported
    // union members remain visible to the fail-closed guard instead of
    // disappearing through a narrow partial-response mask.
    const fields = "documentId,revisionId,body/content,lists";
    const query = new URLSearchParams({ fields });
    const response = await retryingBoundedFetch(
      this.fetchImpl,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?${query}`,
      { method: "GET", headers },
      10_000,
    );
    if (!response.ok) throw new GoogleApiStatusError(response.status);
    const parsed = documentSchema.safeParse(await response.json());
    // Never log Zod messages or values: they can echo document content. Paths,
    // expected/received type names, nullability and bounded counts are safe.
    if (!parsed.success)
      throw new GoogleDocsStructureError(
        "document_schema_invalid",
        safeDocumentSchemaDiagnostics(parsed.error),
      );
    return parsed.data;
  }
  private async readDocument(documentId: string, headers: Record<string, string>) {
    return operationsFromDocument(await this.readRawDocument(documentId, headers));
  }
  private result(documentId: string, replayed: boolean): GoogleDocsExport {
    return GoogleDocsExportSchema.parse({
      external_document_id: documentId,
      external_url: `https://docs.google.com/document/d/${documentId}/edit`,
      replayed,
    });
  }
}

export class MockGoogleDocsAdapter implements GoogleDocsAdapter {
  private readonly records = new Map<string, { hash: string; result: GoogleDocsExport }>();
  async export(key: string, rendered: ExportRenderResult) {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.hash !== `${rendered.content_hash}:${rendered.render_hash}`)
        throw new Error("Export idempotency conflict");
      return GoogleDocsExportSchema.parse({ ...existing.result, replayed: true });
    }
    const id = stableId("google-doc", key),
      result = GoogleDocsExportSchema.parse({
        external_document_id: id,
        external_url: `https://docs.google.local/document/d/${id}`,
        replayed: false,
      });
    this.records.set(key, { hash: `${rendered.content_hash}:${rendered.render_hash}`, result });
    return result;
  }
}

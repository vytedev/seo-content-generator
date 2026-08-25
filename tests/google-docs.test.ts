import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { simulatedGoogle } from "./helpers/simulated-google.js";
import { RealGoogleDocsAdapter } from "../src/server/providers/google-docs.js";
import {
  GOOGLE_DOCS_SCOPES,
  GOOGLE_SCOPES,
  GoogleOAuthClient,
  GoogleTokenStore,
  googleOAuthConfigFromEnv,
} from "../src/server/providers/google-oauth.js";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://127.0.0.1:3100/api/integrations/google/callback",
  encryptionKey: Buffer.alloc(32, 7),
};
const scope = GOOGLE_SCOPES.join(" ");

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

function render(markdown: string) {
  const operations = [
    { type: "paragraph" as const, style: "NORMAL_TEXT" as const, text: markdown, spans: [] },
  ];
  return renderedOperations(operations);
}

function exportCompletionHash(rendered: ReturnType<typeof render>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        content_hash: rendered.content_hash,
        render_hash: rendered.render_hash,
        format_version: "2",
      }),
    )
    .digest("hex");
}

function appProperties(rendered: ReturnType<typeof render>, complete = false) {
  return {
    mobelaris_provider_idempotency_key: "key",
    mobelaris_content_hash: rendered.content_hash,
    mobelaris_render_hash: rendered.render_hash,
    ...(complete
      ? {
          mobelaris_export_complete_hash: exportCompletionHash(rendered),
          mobelaris_export_format_version: "2",
        }
      : {}),
  };
}

function emptyDocument(documentId: string, revisionId = "revision-1") {
  return {
    documentId,
    revisionId,
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
}
function cleanParagraphDocument(
  rendered: ReturnType<typeof render>,
  documentId: string,
  revisionId = "revision-2",
) {
  const text = `${String(rendered.operations[0]!.text).replaceAll("\n", "\u000b")}\n`;
  const endIndex = 1 + text.length;
  return {
    documentId,
    revisionId,
    body: {
      content: [
        {
          startIndex: 1,
          endIndex,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{ textRun: { content: text } }],
          },
        },
        {
          startIndex: endIndex,
          endIndex: endIndex + 1,
          paragraph: { elements: [{ textRun: { content: "\n" } }] },
        },
      ],
    },
  };
}

describe("Google OAuth and Docs providers", () => {
  it("encrypts persisted tokens and orders versions monotonically", async () => {
    let inserted: unknown[] = [];
    let version = 0;
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("insert into")) {
          inserted = values ?? [];
          version += 1;
          return { rows: [] };
        }
        if (sql.includes("select version,event")) {
          return {
            rows: [
              {
                version,
                event: "connected",
                encrypted_tokens: inserted[0],
                iv: inserted[1],
                auth_tag: inserted[2],
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new GoogleTokenStore(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      config.encryptionKey,
    );
    await store.save({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: new Date("2026-08-20T10:00:00.000Z"),
      scope,
    });
    expect(String(inserted[0])).not.toContain("access-secret");
    expect(await store.load()).toMatchObject({ accessToken: "access-secret", scope, version: 1 });
    expect(client.query).toHaveBeenCalledWith("select pg_advisory_lock(hashtextextended($1,0))", [
      "google_oauth:google",
    ]);
  });

  it("uses mock only for wholly absent config and rejects partial config", () => {
    expect(googleOAuthConfigFromEnv({})).toBeUndefined();
    expect(() => googleOAuthConfigFromEnv({ GOOGLE_OAUTH_CLIENT_ID: "id" })).toThrow("incomplete");
    expect(
      googleOAuthConfigFromEnv({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: config.redirectUri,
        GOOGLE_TOKEN_ENCRYPTION_KEY: config.encryptionKey.toString("base64"),
      }),
    ).toEqual({ ...config, clientId: "id", clientSecret: "secret" });
  });

  it("requests all three authorisation scopes", () => {
    const oauth = new GoogleOAuthClient(config, {} as GoogleTokenStore, vi.fn());
    const url = new URL(oauth.authorisationUrl("state", "challenge"));
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.toString()).not.toContain(config.clientSecret);
  });

  it("continues Docs export with legacy Docs+drive.file credentials", async () => {
    const legacyScope = GOOGLE_DOCS_SCOPES.join(" ");
    const store = {
      serialised: async (operation: (stored: unknown, client: unknown) => Promise<string>) =>
        operation(
          {
            accessToken: "legacy-access",
            expiresAt: new Date(Date.now() + 120_000),
            scope: legacyScope,
            version: 1,
          },
          {},
        ),
    } as unknown as GoogleTokenStore;
    await expect(new GoogleOAuthClient(config, store, vi.fn()).accessToken()).resolves.toBe(
      "legacy-access",
    );
    await expect(
      new GoogleOAuthClient(config, store, vi.fn()).accessToken([
        "https://www.googleapis.com/auth/webmasters.readonly",
      ]),
    ).rejects.toThrow("required for this operation");
  });

  it("revokes before tombstoning and retains local credentials on unsafe revoke failure", async () => {
    const tombstoneSerialised = vi.fn().mockResolvedValue(undefined);
    const store = {
      serialised: async (operation: (stored: unknown, client: unknown) => Promise<void>) =>
        operation(
          {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: new Date(Date.now() + 60_000),
            scope,
            version: 1,
          },
          {},
        ),
      tombstoneSerialised,
    } as unknown as GoogleTokenStore;
    const successfulFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    await new GoogleOAuthClient(config, store, successfulFetch).disconnect();
    expect(successfulFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(tombstoneSerialised).toHaveBeenCalledOnce();

    tombstoneSerialised.mockClear();
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    await expect(new GoogleOAuthClient(config, store, failedFetch).disconnect()).rejects.toThrow(
      "local connection was retained",
    );
    expect(tombstoneSerialised).not.toHaveBeenCalled();
  });

  it("searches, reserves with appProperties, verifies empty, then inserts canonical bytes", async () => {
    // Driven against a double that applies the requests, so endpoint and field
    // assertions hold however many phases the writer needs.
    const rendered = render("# Canonical title\n\nCanonical body.\n");
    const google = simulatedGoogle();
    const result = await new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      google.fetchImpl,
    ).export("key", rendered);
    expect(result.external_document_id).toBe("simulated-document");

    const lookup = new URL(google.urls.find((call) => call.url.includes("drive/v3/files?q="))!.url);
    expect(lookup.searchParams.get("fields")).toBe("files(id,appProperties)");

    const read = google.urls.find((call) => call.url.includes("docs.googleapis.com"))!;
    const readUrl = new URL(read.url);
    expect(readUrl.origin + readUrl.pathname).toBe(
      "https://docs.googleapis.com/v1/documents/simulated-document",
    );
    expect(readUrl.searchParams.get("fields")).toBe("documentId,revisionId,body/content,lists");
    expect(read.url).not.toContain("bulle%2574");

    const create = google.urls.find(
      (call) => call.method === "POST" && call.url.includes("drive/v3/files?fields=id"),
    )!;
    expect(JSON.parse(create.body!)).toMatchObject({
      mimeType: "application/vnd.google-apps.document",
      appProperties: {
        mobelaris_provider_idempotency_key: "key",
        mobelaris_content_hash: rendered.content_hash,
      },
    });

    expect(google.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: expect.any(Object) }),
        expect.objectContaining({ updateParagraphStyle: expect.any(Object) }),
      ]),
    );
    expect(JSON.stringify(google.requests)).not.toContain("MOBELARIS_EXPORT_COMPLETE:");
    expect(JSON.stringify(google.requests)).not.toContain("MOBELARIS_LIST:");

    const completion = google.urls.find((call) => call.method === "PATCH")!;
    expect(JSON.parse(completion.body!).appProperties).toMatchObject({
      mobelaris_export_complete_hash: exportCompletionHash(rendered),
      mobelaris_export_format_version: "2",
    });
  });

  it("uses Google's table-cell paragraph offsets and populates cells in reverse order", async () => {
    const rendered = renderedOperations([
      {
        type: "table",
        rows: [
          [
            { text: "A", spans: [] },
            { text: "B", spans: [] },
          ],
          [
            { text: "C", spans: [] },
            { text: "D", spans: [] },
          ],
        ],
      },
    ]);
    const adapter = new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      vi.fn() as unknown as typeof fetch,
    );
    const requests = (adapter as any).nativeRequestsForOperations(
      rendered.operations,
      "",
      1,
    ) as Array<Record<string, any>>;
    const tableRequestIndex = requests.findIndex((request) => request.insertTable);
    const tableStart = requests[tableRequestIndex]!.insertTable.location.index as number;
    const cellRequests = requests
      .slice(tableRequestIndex + 1)
      .filter((request) => request.insertText);
    expect(cellRequests.map((request) => request.insertText.location.index)).toEqual([
      tableStart + 11,
      tableStart + 9,
      tableStart + 6,
      tableStart + 4,
    ]);

    expect(JSON.stringify(requests)).not.toContain("MOBELARIS_EXPORT_COMPLETE:");
    const tableStyles = requests.filter((request) => request.updateTableCellStyle);
    expect(tableStyles).toHaveLength(2);
    expect(
      tableStyles.every(
        (request) =>
          request.updateTableCellStyle.tableRange.tableCellLocation.tableStartLocation.index ===
          tableStart + 1,
      ),
    ).toBe(true);
    const pinned = requests.find((request) => request.pinTableHeaderRows);
    expect(pinned?.pinTableHeaderRows.tableStartLocation.index).toBe(tableStart + 1);
    const textStyles = requests.filter((request) => request.updateTextStyle);
    expect(
      textStyles.every((request) => request.updateTextStyle.textStyle.fontSize.magnitude <= 9.5),
    ).toBe(true);
    expect(JSON.stringify(textStyles)).toContain('"fontFamily":"Arial"');
  });

  it("places every kind of post-table operation after the table, never inside its last cell", async () => {
    // A table followed by a paragraph, a list item, a second table and the
    // marker: each following operation must start at or after the true table end.
    const rendered = renderedOperations([
      {
        type: "table",
        rows: [
          [
            { text: "A", spans: [] },
            { text: "B", spans: [] },
            { text: "C", spans: [] },
          ],
          [
            { text: "D", spans: [] },
            { text: "E", spans: [] },
            { text: "F", spans: [] },
          ],
        ],
      },
      { type: "paragraph", style: "NORMAL_TEXT", text: "After the first table", spans: [] },
      { type: "list_item", ordered: false, text: "A following list item", spans: [] },
      {
        type: "table",
        rows: [
          [
            { text: "G", spans: [] },
            { text: "H", spans: [] },
          ],
        ],
      },
      { type: "paragraph", style: "NORMAL_TEXT", text: "After the second table", spans: [] },
    ]);
    const adapter = new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      vi.fn() as unknown as typeof fetch,
    );
    const requests = (adapter as any).nativeRequestsForOperations(
      rendered.operations,
      "",
      1,
    ) as Array<Record<string, any>>;

    // Independent oracle: derive each table's true end from the documented
    // cell-paragraph formula, then require nothing to be inserted before it.
    for (const table of requests.filter((request) => request.insertTable)) {
      const start = table.insertTable.location.index as number;
      const rows = table.insertTable.rows as number;
      const columns = table.insertTable.columns as number;
      const lastCellParagraph = start + 4 + (rows - 1) * (2 * columns + 1) + 2 * (columns - 1);
      expect(lastCellParagraph).toBe(start + 2 * rows * columns + rows + 1);
      const cellIndexes = new Set(
        Array.from({ length: rows }, (_, r) =>
          Array.from({ length: columns }, (_, c) => start + 4 + r * (2 * columns + 1) + 2 * c),
        ).flat(),
      );
      const inserts = requests.filter((request) => request.insertText);
      const cellInserts = inserts.filter((request) =>
        cellIndexes.has(request.insertText.location.index as number),
      );
      expect(cellInserts).toHaveLength(rows * columns);
      // The table's true end accounts for the text inserted into its cells, which
      // grows the document as well as the empty table skeleton.
      const insertedCellText = cellInserts.reduce(
        (total, request) => total + String(request.insertText.text).length,
        0,
      );
      const tableEnd = lastCellParagraph + 1 + insertedCellText;
      // Every operation emitted after this table's cells must start at or after
      // the table's true end. The historical off-by-one placed the next
      // operation one index earlier — inside the final cell.
      const lastCellPosition = inserts.lastIndexOf(cellInserts.at(-1)!);
      for (const following of inserts.slice(lastCellPosition + 1))
        expect(following.insertText.location.index as number).toBeGreaterThanOrEqual(tableEnd);
    }
  });

  it("recovers create response loss through search and does not duplicate exact content", async () => {
    const rendered = render("canonical bytes\n");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [{ id: "complete", appProperties: appProperties(rendered, true) }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cleanParagraphDocument(rendered, "complete"))),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cleanParagraphDocument(rendered, "complete"))),
      );
    const adapter = new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      fetchMock,
    );
    await expect(adapter.export("key", rendered)).resolves.toMatchObject({
      external_document_id: "complete",
      replayed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rereads ordered and unordered lists from authoritative native list definitions", async () => {
    const operations = [
      { type: "list_item", ordered: true, text: "First", spans: [] },
      { type: "list_item", ordered: false, text: "Second", spans: [] },
    ];
    const rendered = renderedOperations(operations);
    const document = {
      documentId: "opaque-lists",
      revisionId: "revision-1",
      body: {
        content: operations
          .map((operation, index) => ({
            startIndex: index === 0 ? 1 : 7,
            endIndex: index === 0 ? 7 : 14,
            paragraph: {
              bullet: { listId: index === 0 ? "opaque-A" : "opaque-B" },
              elements: [
                {
                  textRun: {
                    content: `${operation.text}\n`,
                  },
                },
              ],
            },
          }))
          .concat([
            {
              startIndex: 14,
              endIndex: 15,
              paragraph: {
                elements: [{ textRun: { content: "\n" } }],
              },
            } as never,
          ]),
      },
      lists: {
        "opaque-A": {
          listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] },
        },
        "opaque-B": {
          listProperties: { nestingLevels: [{ glyphSymbol: "●" }] },
        },
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [{ id: "opaque-lists", appProperties: appProperties(rendered, true) }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(document)))
      .mockResolvedValueOnce(new Response(JSON.stringify(document)));
    await expect(
      new RealGoogleDocsAdapter(
        { accessToken: async () => "access-token" } as GoogleOAuthClient,
        fetchMock,
      ).export("key", rendered),
    ).resolves.toMatchObject({ external_document_id: "opaque-lists", replayed: true });
  });

  it("fails closed when a native list paragraph has no Document.lists metadata", async () => {
    const rendered = renderedOperations([
      { type: "list_item", ordered: false, text: "Expected list item", spans: [] },
    ]);
    const document = {
      documentId: "markerless-list",
      body: {
        content: [
          {
            paragraph: {
              bullet: { listId: "opaque-list" },
              elements: [{ textRun: { content: "Expected list item\n" } }],
            },
          },
          {
            paragraph: {
              elements: [
                { textRun: { content: `MOBELARIS_EXPORT_COMPLETE:${rendered.render_hash}\n` } },
              ],
            },
          },
        ],
      },
    };
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: "markerless-list" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(document)));

    await expect(
      new RealGoogleDocsAdapter(
        { accessToken: async () => "access-token" } as GoogleOAuthClient,
        fetchMock,
      ).export("markerless-list-key", rendered),
    ).rejects.toThrow("Google Docs export structure mismatch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const log = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(log).toContain('"reason":"document_lists_missing"');
  });

  it("classifies a batch request failure without logging Google's response text", async () => {
    const rendered = render("# Title\n\nBody.");
    const google = simulatedGoogle({
      reservedFile: { id: "doc-batch", appProperties: appProperties(rendered) },
      failBatchAt: {
        index: 0,
        status: 400,
        message: "Invalid requests[2].updateTextStyle: The range is invalid. secret detail",
      },
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await expect(
      new RealGoogleDocsAdapter(
        { accessToken: async () => "access-token" } as GoogleOAuthClient,
        google.fetchImpl,
      ).export("key", rendered),
    ).rejects.toThrow("Google Docs export failed");
    const safeLog = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(safeLog).toContain('"stage":"docs_suffix_recovery_update"');
    expect(safeLog).toContain('"request_index":2');
    expect(safeLog).toContain('"request_type":"updateTextStyle"');
    expect(safeLog).toContain('"reported_request_type":"updateTextStyle"');
    expect(safeLog).toContain('"reason":"invalid_range"');
    expect(safeLog).toContain('"request":{"type":"updateTextStyle"');
    expect(safeLog).toContain('"previous_request"');
    expect(safeLog).not.toContain("secret detail");
  });

  it("returns a redacted provider error while logging only the safe stage and status", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream-sensitive-detail" } }), {
        status: 401,
      }),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const adapter = new RealGoogleDocsAdapter(
      { accessToken: async () => "access-token" } as GoogleOAuthClient,
      fetchMock,
    );
    await expect(adapter.export("key", render("text"))).rejects.toThrow(
      "Google Docs export failed",
    );
    await expect(adapter.export("key", render("text"))).rejects.not.toThrow(
      "upstream-sensitive-detail",
    );
    const safeLog = output.find((line) => line.includes("google_docs.provider_failed"));
    expect(safeLog).toContain('"stage":"drive_lookup"');
    expect(safeLog).toContain('"status":401');
    expect(safeLog).not.toContain("upstream-sensitive-detail");
  });
});

import { GoogleDocsSimulator, SimulatedGoogleApiError } from "./google-docs-simulator.js";
import type { TableGeometry } from "./google-docs-simulator.js";

/**
 * A Google Docs and Drive double backed by the structural simulator.
 *
 * The doubles this replaces captured the emitted `batchUpdate` body and returned
 * HTTP 200 unconditionally, so an index that addressed nothing in the document
 * passed every test and failed only in production. This one applies each
 * request to a document model and answers 400 exactly where Google would, and
 * every `documents.get` returns the document as it actually stands.
 */
export interface SimulatedGoogleOptions {
  readonly tableGeometry?: TableGeometry;
  /** Pre-existing reserved file, to exercise reuse and recovery paths. */
  readonly reservedFile?: { id: string; appProperties?: Record<string, string> };
  /** Fail the nth batchUpdate (0-based) with this status, to exercise retries. */
  readonly failBatchAt?: { index: number; status: number; message?: string };
  /** Continue against a document a previous attempt left partly written. */
  readonly simulator?: GoogleDocsSimulator;
}

export interface SimulatedGoogle {
  readonly fetchImpl: typeof fetch;
  readonly simulator: GoogleDocsSimulator;
  /** Every request across every phase, in order. */
  readonly requests: Record<string, any>[];
  /** One entry per batchUpdate call. */
  readonly batches: Record<string, any>[][];
  readonly writeControls: unknown[];
  readonly calls: { reads: number; batchUpdate: number; created: number; metadata: number };
  readonly appProperties: Record<string, string>;
  /** Every HTTP call, so endpoint and field-mask assertions need no call ordering. */
  readonly urls: Array<{ method: string; url: string; body?: string }>;
  /** Every rejection the double issued, for diagnosing a failing export. */
  readonly failures: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function simulatedGoogle(options: SimulatedGoogleOptions = {}): SimulatedGoogle {
  const documentId = options.reservedFile?.id ?? "simulated-document";
  const simulator =
    options.simulator ??
    new GoogleDocsSimulator(documentId, {
      ...(options.tableGeometry ? { tableGeometry: options.tableGeometry } : {}),
    });
  const requests: Record<string, any>[] = [];
  const batches: Record<string, any>[][] = [];
  const writeControls: unknown[] = [];
  const calls = { reads: 0, batchUpdate: 0, created: 0, metadata: 0 };
  const failures: string[] = [];
  const urls: Array<{ method: string; url: string; body?: string }> = [];
  const appProperties: Record<string, string> = { ...(options.reservedFile?.appProperties ?? {}) };
  let reserved = options.reservedFile !== undefined;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    const method = init?.method ?? "GET";
    urls.push({
      method,
      url: target,
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    });

    if (target.includes("drive/v3/files?q=")) {
      return json({ files: reserved ? [{ id: documentId, appProperties }] : [] });
    }
    if (target.includes("drive/v3/files?fields=id") && method === "POST") {
      calls.created += 1;
      reserved = true;
      Object.assign(appProperties, JSON.parse(String(init?.body)).appProperties ?? {});
      return json({ id: documentId });
    }
    if (target.includes("drive/v3/files/") && method === "PATCH") {
      calls.metadata += 1;
      Object.assign(appProperties, JSON.parse(String(init?.body)).appProperties ?? {});
      return json({ id: documentId });
    }
    if (target.includes(":batchUpdate")) {
      const body = JSON.parse(String(init?.body));
      const batch = body.requests as Record<string, any>[];
      if (options.failBatchAt && options.failBatchAt.index === calls.batchUpdate) {
        calls.batchUpdate += 1;
        return json(
          { error: { message: options.failBatchAt.message ?? "Simulated transport failure" } },
          options.failBatchAt.status,
        );
      }
      calls.batchUpdate += 1;
      batches.push(batch);
      writeControls.push(body.writeControl);
      requests.push(...batch);
      try {
        simulator.apply(batch);
      } catch (error) {
        // Google reports the offending request by index in the message.
        const detail =
          error instanceof SimulatedGoogleApiError
            ? error.message
            : String((error as Error).message);
        failures.push(detail);
        return json({ error: { code: 400, status: "INVALID_ARGUMENT", message: detail } }, 400);
      }
      return json({});
    }
    if (target.includes("docs.googleapis.com/v1/documents/")) {
      calls.reads += 1;
      return json(simulator.document());
    }
    throw new Error(`simulated-google: unexpected request ${method} ${target}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    simulator,
    requests,
    batches,
    writeControls,
    calls,
    appProperties,
    urls,
    failures,
  };
}

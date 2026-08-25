import { z } from "zod";
import { IngestResultSchema, type IngestResult } from "../../shared/ingest-contracts.js";

const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      })
      .strict(),
  })
  .strict();

export class IngestApiError extends Error {
  constructor(
    message: string,
    readonly details: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

export function parseIngestResponse(body: unknown, ok: boolean): IngestResult {
  if (ok) return IngestResultSchema.parse(body);
  const parsed = ApiErrorSchema.safeParse(body);
  throw new IngestApiError(
    parsed.success ? parsed.data.error.message : "The handoff could not be ingested.",
    parsed.success ? (parsed.data.error.details ?? []) : [],
  );
}

import { z } from "zod";
import { IngestResultSchema, type IngestResult } from "../../shared/ingest-contracts.js";
import {
  CommandSubmissionWithResultSchema,
  type CommandSubmissionWithResult,
} from "./command-submission-api.js";

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

export type IngestCommandSubmissionResult = CommandSubmissionWithResult & {
  result: IngestResult;
};

export function parseIngestResponse(body: unknown, status: number): IngestCommandSubmissionResult {
  if (status === 202) {
    const submission = CommandSubmissionWithResultSchema.parse(body);
    const result = IngestResultSchema.parse(submission.result);
    if (result.run_id !== submission.run_id)
      throw new IngestApiError("The accepted command did not match the prepared blog post.");
    return { ...submission, result };
  }
  const parsed = ApiErrorSchema.safeParse(body);
  throw new IngestApiError(
    parsed.success ? parsed.data.error.message : "The handoff could not be ingested.",
    parsed.success ? (parsed.data.error.details ?? []) : [],
  );
}

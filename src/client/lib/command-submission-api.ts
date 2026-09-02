import { z } from "zod";

/** Exact public envelope returned when a durable run command is accepted. */
export const CommandSubmissionResultSchema = z
  .object({
    command_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    replayed: z.boolean(),
    queue_accepted: z.boolean(),
    /** Command-specific terminal result; callers may ignore it. */
    result: z.unknown(),
  })
  .strict();

export type CommandSubmissionResult = z.infer<typeof CommandSubmissionResultSchema>;

export const CommandSubmissionWithResultSchema = CommandSubmissionResultSchema;
export type CommandSubmissionWithResult = z.infer<typeof CommandSubmissionWithResultSchema>;

export function parseCommandSubmissionResponse(
  body: unknown,
  status: number,
  fallback: string,
  expectedRunId?: string,
): CommandSubmissionResult {
  if (status !== 202) throw new Error(fallback);
  const submission = CommandSubmissionResultSchema.parse(body);
  if (expectedRunId !== undefined && submission.run_id !== expectedRunId)
    throw new Error("The accepted command did not match this blog post.");
  return submission;
}

export function newActionIdempotencyKey(action: string, runId?: string): string {
  return ["client", action, ...(runId ? [runId] : []), crypto.randomUUID()].join(":");
}

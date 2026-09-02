import type { Express } from "express";
import { z, ZodError } from "zod";
import { RepositoryConflictError, RepositoryUnavailableError } from "../../shared/errors.js";
import type { RunCommandRepository } from "../../shared/command-repository.js";
import { buildRouteCommand, commandAcceptedBody } from "./command-submission.js";
import {
  IdempotencyConflictError,
  canonicalHash,
  ingestHandoff,
  type IngestResult,
  type IngestStore,
} from "../../shared/milestone-two.js";
import { HandoffSchema } from "../../shared/pipeline.js";

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export interface IngestService {
  ingest(input: unknown, key: string): Promise<IngestResult>;
  prepare(
    input: unknown,
  ): Promise<{ handoff: IngestResult["handoff"]; warnings: IngestResult["warnings"] }>;
}

const POSTGRES_UNAVAILABLE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

function isPostgresUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    POSTGRES_UNAVAILABLE_CODES.has(error.code)
  );
}

export function createIngestService(store: IngestStore): IngestService {
  const prepare = async (input: unknown) => {
    const collector: IngestStore = {
      findIngest: async () => null,
      createIngest: async (_key, inputHash, handoff, warnings) => ({
        run_id: "preflight",
        input_hash: inputHash,
        handoff,
        warnings,
      }),
    };
    const prepared = await ingestHandoff(input, "preflight-key", collector);
    return { handoff: prepared.handoff, warnings: prepared.warnings };
  };
  return {
    prepare,
    async ingest(input, key) {
      try {
        return await ingestHandoff(input, key, store);
      } catch (error) {
        if (isPostgresUnavailable(error))
          throw new RepositoryUnavailableError("PostgreSQL is unavailable.");
        throw error;
      }
    },
  };
}

export function registerIngestRoutes(
  app: Express,
  service: IngestService,
  commands: RunCommandRepository,
  testOnlySynchronousContinuation?: (runId: string) => Promise<void>,
): void {
  app.post("/api/runs", async (request, response, next) => {
    try {
      const keyResult = IdempotencyKeySchema.safeParse(request.get("Idempotency-Key"));
      if (!keyResult.success) {
        response.status(400).json({
          error: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message: "Idempotency-Key must be 8–128 safe characters.",
            details: [
              { path: "header.Idempotency-Key", message: "Provide a valid idempotency key." },
            ],
          },
        });
        return;
      }
      const existing = await commands.findCommand?.(keyResult.data);
      if (existing && existing.kind !== "create_run")
        throw new RepositoryConflictError("The idempotency key belongs to another command.");
      if (
        existing &&
        canonicalHash(existing.handoff) !== canonicalHash(HandoffSchema.parse(request.body))
      )
        throw new RepositoryConflictError("The idempotency key is bound to a different handoff.");
      const prepared = existing ? null : await service.prepare(request.body);
      const submission = await commands.submitCommand(
        buildRouteCommand({
          kind: "create_run",
          idempotency_key: keyResult.data,
          body: existing
            ? { handoff: existing.handoff, warnings: existing.warnings }
            : { handoff: prepared!.handoff, warnings: prepared!.warnings },
        }),
      );
      if (testOnlySynchronousContinuation) {
        try {
          await testOnlySynchronousContinuation(submission.run_id);
        } catch {
          // Explicit test-only compatibility adapter; production never invokes it.
        }
        response.location(`/api/runs/${submission.run_id}`).status(201).json(submission.result);
        return;
      }
      response
        .location(`/api/runs/${submission.run_id}`)
        .status(202)
        .json(commandAcceptedBody(submission));
    } catch (error) {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: {
            code: "INVALID_INPUT",
            message: "The handoff is invalid.",
            details: error.issues.flatMap((issue) => {
              if (issue.code === "unrecognized_keys")
                return issue.keys.map((key) => ({ path: key, message: "Unrecognised field." }));
              return [
                {
                  path: issue.path.length ? issue.path.join(".") : "body",
                  message: issue.message,
                },
              ];
            }),
          },
        });
        return;
      }
      if (error instanceof IdempotencyConflictError || error instanceof RepositoryConflictError) {
        response.status(409).json({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "This idempotency key was already used for a different handoff.",
          },
        });
        return;
      }
      if (error instanceof RepositoryUnavailableError) {
        response.status(503).json({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The run store is temporarily unavailable. Try again shortly.",
          },
        });
        return;
      }
      next(error);
    }
  });
}

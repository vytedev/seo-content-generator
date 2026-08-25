import type { Express } from "express";
import { z, ZodError } from "zod";
import { RepositoryConflictError, RepositoryUnavailableError } from "../../shared/errors.js";
import {
  IdempotencyConflictError,
  ingestHandoff,
  type IngestResult,
  type IngestStore,
  type SerpCompositionProbe,
} from "../../shared/milestone-two.js";
import type { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";
import type { MilestoneThreeOrchestrator } from "../pipeline/milestone-three.js";
import type { MilestoneTwoOrchestrator } from "../pipeline/milestone-two.js";

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export interface IngestService {
  ingest(input: unknown, key: string): Promise<IngestResult>;
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

export function createIngestService(
  store: IngestStore,
  probe?: SerpCompositionProbe,
): IngestService {
  return {
    async ingest(input, key) {
      try {
        return await ingestHandoff(input, key, store, probe);
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
  milestoneTwo?: MilestoneTwoOrchestrator,
  milestoneThree?: MilestoneThreeOrchestrator,
  milestoneFour?: MilestoneFourOrchestrator,
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
      const result = await service.ingest(request.body, keyResult.data);
      // HTTP semantics stay ingest-owned: the ingest (fresh or replay) is already
      // durably committed, so an orchestrator failure must never change the 201
      // contract or the IngestResult body. The failure is already persisted by the
      // orchestrator as retryable_failed at the failing step, so the response stays
      // redacted here and POST /api/runs/:runId/milestone-two/resume is the
      // operator's recovery path. Provider and payload details are deliberately
      // never logged or echoed.
      if (milestoneTwo) {
        try {
          await milestoneTwo.run(result.run_id);
          // Step 1.4 runs deterministically after 1.3, so a fresh ingest advances
          // straight to the 1.9 operator wait. The same swallow-on-failure
          // contract applies: the failure is persisted at the failing step and
          // the matching resume route is the recovery path.
          if (milestoneThree) {
            await milestoneThree.run(result.run_id);
            // A zero-finding Step 1.9 completes atomically and continues without
            // manufacturing a human interruption. A non-empty review set makes
            // milestone four reject safely because Step 1.9 is still waiting.
            if (milestoneFour) await milestoneFour.run(result.run_id);
          }
        } catch {
          // Swallowed on purpose; see the contract note above.
        }
      }
      response.location(`/api/runs/${result.run_id}`).status(201).json(result);
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

import type { Express, Response } from "express";
import { z } from "zod";
import { ConflictError, UnprocessableError } from "../../shared/errors.js";
import type { RunDetail, RunSummary, UsageTotals } from "../../shared/contracts/run-detail.js";
import {
  RunListQuerySchema,
  type RunListPage,
  type RunListQuery,
} from "../../shared/contracts/run-list.js";
import { RevisionGuardError, type MilestoneFourRepository } from "../../shared/milestone-four.js";
import type { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";
import type { MilestoneThreeOrchestrator } from "../pipeline/milestone-three.js";
import type { EditorialCorrectionOrchestrator } from "../pipeline/editorial-correction.js";
import type { MilestoneTwoOrchestrator } from "../pipeline/milestone-two.js";
import type { QueueOptions } from "../../shared/queue.js";
import type { RunCommandRepository } from "../../shared/command-repository.js";
import {
  buildRouteCommand,
  routeCommandKey,
  submitQueueRouteCommand,
} from "./command-submission.js";

export interface MilestoneFourRoutes {
  repository: MilestoneFourRepository;
  orchestrator: MilestoneFourOrchestrator;
}

/** Shared run-detail reads; satisfied by every milestone repository. */
export interface RunDetailRepository {
  getRunDetail(runId: string): Promise<RunDetail>;
  getUsageTotals(runId: string): Promise<UsageTotals>;
  listRunPage(query: RunListQuery): Promise<RunListPage>;
}

export interface MilestoneTwoRoutes {
  repository: RunDetailRepository;
  orchestrator: MilestoneTwoOrchestrator;
}

export interface MilestoneThreeRoutes {
  repository: RunDetailRepository;
  orchestrator: MilestoneThreeOrchestrator;
  /** Present only when a controlled editorial correction can be opened locally. */
  editorialCorrection?: EditorialCorrectionOrchestrator | undefined;
}

export interface RunRouteOptions {
  milestoneTwo?: MilestoneTwoRoutes | undefined;
  milestoneThree?: MilestoneThreeRoutes | undefined;
  milestoneFour?: MilestoneFourRoutes | undefined;
  commands: RunCommandRepository;
  testOnlySynchronousContinuation?: ((runId: string) => Promise<void>) | undefined;
}

/** Exact durable state in which the dedicated export retry action is permitted. */
export function isExportRetryEligible(detail: RunDetail): boolean {
  const finalAttempt = [...detail.steps]
    .reverse()
    .find((attempt) => attempt.step === "final_coherence_export");
  return (
    detail.status === "retryable_failed" &&
    detail.current_step === "final_coherence_export" &&
    detail.export.status === "failed" &&
    finalAttempt?.status === "retryable_failed" &&
    finalAttempt.error?.includes("STEP_1_12_FAILED;stage=google_docs_export;") === true
  );
}

export function registerPipelineUnavailableRoutes(app: Express): void {
  app.use(["/api/runs", "/api/runs/{*path}"], (_request, response) => {
    response.status(503).json({
      error: {
        code: "LOCAL_DATABASE_NOT_CONFIGURED",
        message: "Pipeline routes require an explicit local PostgreSQL DATABASE_URL.",
      },
    });
  });
}

export function registerRunRoutes(app: Express, options: RunRouteOptions): void {
  const reader =
    options.milestoneFour?.repository ??
    options.milestoneThree?.repository ??
    options.milestoneTwo?.repository;
  if (!reader) return;
  const detailReader = reader;

  /** Operator cancellation: a stopped run keeps its state and cannot resume. */
  async function assertNotCancelled(runId: string): Promise<void> {
    if ((await detailReader.getRunDetail(runId)).status === "cancelled")
      throw new ConflictError("This blog post was cancelled and cannot continue.");
  }

  /** Controlled model output can fail a revision guard without being a server fault. */
  function classifyPipelineError(error: unknown): unknown {
    if (error instanceof RevisionGuardError) return new UnprocessableError(error.message);
    return error;
  }

  async function enqueue(
    runId: string,
    queueOptions: QueueOptions = {},
    idempotencyKey?: string,
    kind: "resume_run" | "retry_export" = "resume_run",
  ): Promise<void> {
    await submitQueueRouteCommand({
      repository: options.commands,
      kind,
      run_id: runId,
      idempotency_key: routeCommandKey(idempotencyKey),
      options: queueOptions,
    });
    if (options.testOnlySynchronousContinuation)
      await options.testOnlySynchronousContinuation(runId);
  }

  async function respondWithDetail(
    response: Response,
    runId: string,
    status: number,
  ): Promise<void> {
    response.status(status).json(await detailReader.getRunDetail(runId));
  }

  /**
   * Orchestrators persist safe provider/step failures before throwing. In those cases the durable
   * run detail is the authoritative action response; a still-running run means the error was not
   * converted at the workflow boundary and must continue to the API error handler.
   */
  async function respondWithDurableOutcome(response: Response, runId: string): Promise<boolean> {
    const detail = await detailReader.getRunDetail(runId).catch(() => null);
    if (!detail || !["retryable_failed", "cancelled", "blocked", "waiting"].includes(detail.status))
      return false;
    response.status(200).json(detail);
    return true;
  }

  if (options.milestoneFour) {
    const milestoneFour = options.milestoneFour;
    app.post(
      "/api/runs/:runId/exceptional-correction/authorise",
      async (request, response, next) => {
        try {
          await assertNotCancelled(request.params.runId!);
          const body = z
            .object({
              explicit_confirmation: z.literal(true),
              idempotency_key: z.string().trim().min(8).max(200),
            })
            .strict()
            .parse(request.body);
          await options.commands.submitCommand(
            buildRouteCommand({
              kind: "authorise_exceptional_correction",
              run_id: request.params.runId!,
              idempotency_key: body.idempotency_key,
              body: { explicit_confirmation: true },
            }),
          );
          await respondWithDetail(response, request.params.runId!, 200);
        } catch (error) {
          if (await respondWithDurableOutcome(response, request.params.runId!)) return;
          next(error);
        }
      },
    );
    app.post("/api/runs/:runId/cancel", async (request, response, next) => {
      try {
        await options.commands.submitCommand(
          buildRouteCommand({
            kind: "cancel_run",
            run_id: request.params.runId!,
            idempotency_key: routeCommandKey(request.get("Idempotency-Key")),
          }),
        );
        await respondWithDetail(response, request.params.runId!, 200);
      } catch (error) {
        next(error);
      }
    });
  }

  if (options.milestoneTwo) {
    const milestoneTwo = options.milestoneTwo;
    app.post("/api/runs/:runId/milestone-two/resume", async (request, response, next) => {
      try {
        await assertNotCancelled(request.params.runId!);
        const body = z
          .object({
            refresh_link_discovery: z.boolean().optional(),
            authorise_legacy_draft_recovery: z.literal(true).optional(),
          })
          .strict()
          .parse(request.body ?? {});
        await enqueue(
          request.params.runId!,
          {
            refresh_link_discovery: body.refresh_link_discovery ?? false,
            authorise_legacy_draft_recovery: body.authorise_legacy_draft_recovery ?? false,
          },
          request.get("Idempotency-Key"),
        );
        await respondWithDetail(response, request.params.runId!, 200);
      } catch (error) {
        if (await respondWithDurableOutcome(response, request.params.runId!)) return;
        next(error);
      }
    });
  }

  if (options.milestoneThree) {
    const milestoneThree = options.milestoneThree;
    if (milestoneThree.editorialCorrection) {
      const editorialCorrection = milestoneThree.editorialCorrection;
      // Opens the newly applicable editorial findings against the existing
      // frozen version and parks the run at the ordinary Step 1.9 wait. It
      // never mutates the frozen version, never rewrites the frozen manifest,
      // and creates no document version itself: the corrected immutable child
      // is produced by the normal controlled revision that follows review.
      app.post("/api/runs/:runId/editorial-correction/open", async (request, response, next) => {
        try {
          await assertNotCancelled(request.params.runId!);
          z.object({ explicit_confirmation: z.literal(true) })
            .strict()
            .parse(request.body);
          const outcome = await editorialCorrection.open(request.params.runId!);
          response
            .status(200)
            .json({ ...outcome, run: await detailReader.getRunDetail(request.params.runId!) });
        } catch (error) {
          next(error);
        }
      });
    }
    app.post("/api/runs/:runId/milestone-three/resume", async (request, response, next) => {
      try {
        await assertNotCancelled(request.params.runId!);
        const body = z
          .object({ authorise_legacy_review_recovery: z.literal(true).optional() })
          .strict()
          .parse(request.body ?? {});
        await enqueue(request.params.runId!, body, request.get("Idempotency-Key"));
        await respondWithDetail(response, request.params.runId!, 200);
      } catch (error) {
        if (await respondWithDurableOutcome(response, request.params.runId!)) return;
        next(error);
      }
    });
  }

  if (options.milestoneFour) {
    const milestoneFour = options.milestoneFour;
    app.post("/api/runs/:runId/milestone-four/resume", async (request, response, next) => {
      try {
        await assertNotCancelled(request.params.runId!);
        await milestoneFour.repository.getRunDetail(request.params.runId!);
        await enqueue(request.params.runId!, {}, request.get("Idempotency-Key"));
        await respondWithDetail(response, request.params.runId!, 200);
      } catch (error) {
        // Revision guards retain their established 422 contract even though the failed attempt is
        // also durable; unlike provider transport failures, this is an actionable validation error.
        if (error instanceof RevisionGuardError) {
          next(classifyPipelineError(error));
          return;
        }
        if (await respondWithDurableOutcome(response, request.params.runId!)) return;
        next(error);
      }
    });
  }

  app.get("/api/runs", async (request, response, next) => {
    // Malformed page, limit or filter values are refused rather than replaced
    // with a default: an operator paging through history must never be shown a
    // different page from the one they asked for.
    const parsed = RunListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "The run list query is invalid.",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    try {
      response.status(200).json(await reader.listRunPage(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:runId", async (request, response, next) => {
    try {
      response.status(200).json(await detailReader.getRunDetail(request.params.runId!));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/runs/:runId/costs", async (request, response, next) => {
    try {
      response.status(200).json(await reader.getUsageTotals(request.params.runId!));
    } catch (error) {
      next(error);
    }
  });

  if (options.milestoneFour) {
    const milestoneFour = options.milestoneFour;
    app.post("/api/runs/:runId/export/retry", async (request, response, next) => {
      try {
        await assertNotCancelled(request.params.runId!);
        await enqueue(request.params.runId!, {}, request.get("Idempotency-Key"), "retry_export");
        response
          .status(200)
          .json(await milestoneFour.repository.getRunDetail(request.params.runId!));
      } catch (error) {
        next(error);
      }
    });
  }
}

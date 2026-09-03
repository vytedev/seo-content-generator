import type { Express, Response } from "express";
import { z } from "zod";
import { UnprocessableError } from "../../shared/errors.js";
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
  commandAcceptedBody,
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

  async function respondAccepted(
    response: Response,
    submission: Awaited<ReturnType<RunCommandRepository["submitCommand"]>>,
  ): Promise<void> {
    if (options.testOnlySynchronousContinuation) {
      response.status(200).json(await detailReader.getRunDetail(submission.run_id));
      return;
    }
    response.status(202).json(commandAcceptedBody(submission));
  }

  async function recoverTestOnlyOutcome(response: Response, runId: string): Promise<boolean> {
    if (!options.testOnlySynchronousContinuation) return false;
    const detail = await detailReader.getRunDetail(runId).catch(() => null);
    if (!detail || !["retryable_failed", "cancelled", "blocked", "waiting"].includes(detail.status))
      return false;
    response.status(200).json(detail);
    return true;
  }

  async function enqueue(
    runId: string,
    queueOptions: QueueOptions = {},
    idempotencyKey?: string,
    kind: "resume_run" | "retry_export" = "resume_run",
  ) {
    const submission = await submitQueueRouteCommand({
      repository: options.commands,
      kind,
      run_id: runId,
      idempotency_key: routeCommandKey(idempotencyKey),
      options: queueOptions,
    });
    if (options.testOnlySynchronousContinuation && !submission.replayed)
      await options.testOnlySynchronousContinuation(runId);
    return submission;
  }

  if (options.milestoneFour) {
    const milestoneFour = options.milestoneFour;
    app.post(
      "/api/runs/:runId/exceptional-correction/authorise",
      async (request, response, next) => {
        try {
          const body = z
            .object({
              explicit_confirmation: z.literal(true),
              idempotency_key: z.string().trim().min(8).max(200),
            })
            .strict()
            .parse(request.body);
          const submission = await options.commands.submitCommand(
            buildRouteCommand({
              kind: "authorise_exceptional_correction",
              run_id: request.params.runId!,
              idempotency_key: body.idempotency_key,
              body: { explicit_confirmation: true },
            }),
          );
          await respondAccepted(response, submission);
        } catch (error) {
          if (error instanceof RevisionGuardError && options.testOnlySynchronousContinuation) {
            next(new UnprocessableError(error.message));
            return;
          }
          if (await recoverTestOnlyOutcome(response, request.params.runId!)) return;
          next(error);
        }
      },
    );
    app.post("/api/runs/:runId/cancel", async (request, response, next) => {
      try {
        const submission = await options.commands.submitCommand(
          buildRouteCommand({
            kind: "cancel_run",
            run_id: request.params.runId!,
            idempotency_key: routeCommandKey(request.get("Idempotency-Key")),
          }),
        );
        await respondAccepted(response, submission);
      } catch (error) {
        next(error);
      }
    });
  }

  if (options.milestoneTwo) {
    const milestoneTwo = options.milestoneTwo;
    app.post("/api/runs/:runId/milestone-two/resume", async (request, response, next) => {
      try {
        const body = z
          .object({
            refresh_link_discovery: z.boolean().optional(),
            authorise_legacy_draft_recovery: z.literal(true).optional(),
          })
          .strict()
          .parse(request.body ?? {});
        const submission = await enqueue(
          request.params.runId!,
          {
            refresh_link_discovery: body.refresh_link_discovery ?? false,
            authorise_legacy_draft_recovery: body.authorise_legacy_draft_recovery ?? false,
          },
          request.get("Idempotency-Key"),
        );
        await respondAccepted(response, submission);
      } catch (error) {
        if (await recoverTestOnlyOutcome(response, request.params.runId!)) return;
        next(error);
      }
    });
  }

  if (options.milestoneThree) {
    const milestoneThree = options.milestoneThree;
    if (milestoneThree.editorialCorrection)
      app.post("/api/runs/:runId/editorial-correction/open", async (request, response, next) => {
        try {
          const body = z
            .object({
              explicit_confirmation: z.literal(true),
              idempotency_key: z.string().trim().min(8).max(200),
            })
            .strict()
            .parse(request.body);
          const submission = await options.commands.submitCommand(
            buildRouteCommand({
              kind: "open_editorial_correction",
              run_id: request.params.runId!,
              idempotency_key: body.idempotency_key,
              body: { explicit_confirmation: true },
            }),
          );
          await respondAccepted(response, submission);
        } catch (error) {
          next(error);
        }
      });
    app.post("/api/runs/:runId/milestone-three/resume", async (request, response, next) => {
      try {
        const body = z
          .object({ authorise_legacy_review_recovery: z.literal(true).optional() })
          .strict()
          .parse(request.body ?? {});
        const submission = await enqueue(
          request.params.runId!,
          body,
          request.get("Idempotency-Key"),
        );
        await respondAccepted(response, submission);
      } catch (error) {
        if (await recoverTestOnlyOutcome(response, request.params.runId!)) return;
        next(error);
      }
    });
  }

  if (options.milestoneFour) {
    const milestoneFour = options.milestoneFour;
    app.post("/api/runs/:runId/milestone-four/resume", async (request, response, next) => {
      try {
        const submission = await enqueue(request.params.runId!, {}, request.get("Idempotency-Key"));
        await respondAccepted(response, submission);
      } catch (error) {
        if (error instanceof RevisionGuardError && options.testOnlySynchronousContinuation) {
          next(new UnprocessableError(error.message));
          return;
        }
        if (await recoverTestOnlyOutcome(response, request.params.runId!)) return;
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

  app.get("/api/runs/:runId/activity", async (request, response, next) => {
    try {
      response
        .status(200)
        .json({ activity: await options.commands.listCommandActivity(request.params.runId!) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/runs/:runId/warnings/:warningId/acknowledge", async (request, response, next) => {
    try {
      const submission = await options.commands.submitCommand(
        buildRouteCommand({
          kind: "acknowledge_warning",
          run_id: request.params.runId!,
          idempotency_key: routeCommandKey(request.get("Idempotency-Key")),
          body: { warning_id: request.params.warningId! },
        }),
      );
      await respondAccepted(response, submission);
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
        const submission = await enqueue(
          request.params.runId!,
          {},
          request.get("Idempotency-Key"),
          "retry_export",
        );
        await respondAccepted(response, submission);
      } catch (error) {
        next(error);
      }
    });
  }
}

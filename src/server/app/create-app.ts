import express, { type ErrorRequestHandler, type Express } from "express";
import { ZodError } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ConflictError,
  NotFoundError,
  RepositoryConflictError,
  ServiceUnavailableError,
  UnprocessableError,
} from "../../shared/errors.js";
import { classifyError, logger, safeRequestId } from "../logger.js";
import type { MilestoneThreeRepository } from "../../shared/milestone-three.js";
import type { MilestoneFourRepository } from "../../shared/milestone-four.js";
import {
  runDeterministicChecks,
  type CheckerInput,
  type Finding,
} from "../../shared/checker/index.js";
import type { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";
import type { MilestoneThreeOrchestrator } from "../pipeline/milestone-three.js";
import type { MilestoneTwoOrchestrator } from "../pipeline/milestone-two.js";
import type { MilestoneThreeRoutes, RunDetailRepository } from "../routes/run-routes.js";
import { registerCheckerRoutes } from "../routes/checker-routes.js";
import { registerCalibrationRoutes } from "../routes/calibration-routes.js";
import type { CalibrationRepository } from "../repositories/calibration-repository.js";
import type { CalibrationService } from "../services/calibration-service.js";
import { registerFindingsRoutes } from "../routes/findings-routes.js";
import { registerPipelineUnavailableRoutes, registerRunRoutes } from "../routes/run-routes.js";
import { registerIngestRoutes, type IngestService } from "../routes/ingest-routes.js";
import { registerReferenceApprovalRoutes } from "../routes/reference-approval-routes.js";
import type { PostgresReferenceApprovalRepository } from "../repositories/reference-approval-repository.js";
import {
  registerGoogleOAuthRoutes,
  type GoogleOAuthRoutes,
} from "../routes/google-oauth-routes.js";
import { AUTH_ALLOWED_ORIGINS, createAuthService, type AuthServiceOptions } from "../auth/auth.js";
import { registerModelDiagnosticRoutes } from "../routes/model-diagnostic-routes.js";
import type { ModelDiagnosticService } from "../services/model-diagnostic-service.js";
import { runtimeState, type RuntimeMode } from "../../shared/runtime-mode.js";

const JSON_BODY_LIMIT = "100kb";
const AUTH_ALLOWED_ORIGIN_SET = new Set<string>(AUTH_ALLOWED_ORIGINS);

type CheckRunner = (input: CheckerInput) => Finding[];

type FailureClassification = { category: string; reason_code: string; code?: string };

function classifyHttpStatus(status: number): FailureClassification {
  if (status === 401 || status === 403) return { category: "auth", reason_code: "access_denied" };
  if (status === 404) return { category: "not_found", reason_code: "resource_not_found" };
  if (status === 409) return { category: "conflict", reason_code: "state_conflict" };
  if (status === 413) return { category: "validation", reason_code: "payload_too_large" };
  if (status === 422) return { category: "validation", reason_code: "unprocessable" };
  if (status === 429) return { category: "rate_limit", reason_code: "rate_limited" };
  if (status >= 500) return { category: "server", reason_code: "server_error" };
  return { category: "request", reason_code: "request_failed" };
}

export interface CreateAppOptions {
  runChecks?: CheckRunner;
  serveClient?: boolean;
  findingsRepository?: MilestoneThreeRepository;
  milestoneTwo?: { repository: RunDetailRepository; orchestrator: MilestoneTwoOrchestrator };
  milestoneThree?: MilestoneThreeRoutes;
  milestoneFour?: { repository: MilestoneFourRepository; orchestrator: MilestoneFourOrchestrator };
  calibration?: { repository: CalibrationRepository; service: CalibrationService };
  pipelineUnavailable?: boolean;
  ingestService?: IngestService;
  referenceApprovals?: PostgresReferenceApprovalRepository;
  googleOAuth?: GoogleOAuthRoutes;
  modelDiagnostic?: ModelDiagnosticService;
  queue?: import("../../shared/queue.js").PipelineQueueRepository;
  commands?: import("../../shared/command-repository.js").RunCommandRepository;
  workerHealth?: () => { status: "running" | "stopped" | "failed" };
  runtimeMode?: RuntimeMode;
  readiness?: () => Promise<{
    ready: boolean;
    checks: {
      database: boolean;
      migrations: boolean;
      reconciliation: boolean;
      worker: boolean;
      configuration: boolean;
    };
  }>;
  /** Test-only compatibility. Production-like composition must supply the durable queue. */
  testOnlySynchronousPipeline?: boolean;
  /** Explicitly disabled preserves isolated tests; local runtime always supplies enabled auth. */
  auth?: { mode: "disabled" } | ({ mode: "enabled" } & AuthServiceOptions);
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const runChecks = options.runChecks ?? runDeterministicChecks;

  app.disable("x-powered-by");
  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
  app.use((request, response, next) => {
    if (!request.path.startsWith("/api")) return next();
    const startedAt = Date.now();
    const requestId = safeRequestId(request.header("X-Request-ID"));
    // Only known static route vocabulary is logged verbatim; anything else is a
    // client-chosen value and is reduced to ":value" so paths can never echo
    // attacker-controlled input into server logs.
    const KNOWN_SEGMENTS = new Set([
      "api",
      "auth",
      "login",
      "logout",
      "session",
      "calibrations",
      "reference-proposals",
      "versions",
      "report",
      "results",
      "resume",
      "checker",
      "health",
      "live",
      "ready",
      "integrations",
      "google",
      "callback",
      "connect",
      "status",
      "model",
      "diagnostic",
      "reference-versions",
      "approval-attestations",
      "runs",
      "cancel",
      "costs",
      "editorial-correction",
      "open",
      "exceptional-correction",
      "authorise",
      "export",
      "retry",
      "findings",
      "dispositions",
      "activity",
      "warnings",
      "acknowledge",
      "milestone-two",
      "milestone-three",
      "milestone-four",
    ]);
    const safePath = request.path
      .split("/")
      .map((segment) =>
        /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|run_[a-z0-9]{16,64}|(?=[a-z0-9_-]{16,64}$)(?=.*\d)[a-z0-9_-]+)$/i.test(
          segment,
        )
          ? ":id"
          : segment === ""
            ? segment
            : KNOWN_SEGMENTS.has(segment)
              ? segment
              : ":value",
      )
      .join("/");
    response.locals.requestId = requestId;
    response.locals.safePath = safePath;
    response.setHeader("X-Request-ID", requestId);
    logger.info("http.request_started", {
      request_id: requestId,
      method: request.method,
      path: safePath,
    });
    let terminalLogged = false;
    response.once("finish", () => {
      terminalLogged = true;
      const failed = response.statusCode >= 400;
      logger[failed ? "warn" : "info"](failed ? "http.request_failed" : "http.request_completed", {
        request_id: requestId,
        method: request.method,
        path: safePath,
        status: response.statusCode,
        duration_ms: Date.now() - startedAt,
        ...(failed
          ? {
              ...classifyHttpStatus(response.statusCode),
              ...(response.locals.failureClassification ?? {}),
            }
          : {}),
      });
    });
    response.once("close", () => {
      if (terminalLogged) return;
      terminalLogged = true;
      logger.warn("http.request_aborted", {
        request_id: requestId,
        method: request.method,
        path: safePath,
        duration_ms: Date.now() - startedAt,
        category: "request_aborted",
        reason_code: "request_aborted",
      });
    });
    next();
  });

  if (options.auth?.mode === "enabled") {
    app.use("/api", (request, response, next) => {
      const origin = request.header("origin");
      if (origin && AUTH_ALLOWED_ORIGIN_SET.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Vary", "Origin");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-CSRF-Token, Idempotency-Key, X-Request-ID",
        );
        response.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
      }
      if (request.method === "OPTIONS") {
        response.status(origin && AUTH_ALLOWED_ORIGIN_SET.has(origin) ? 204 : 403).end();
        return;
      }
      next();
    });
  }

  app.get("/api/live", (_request, response) => response.status(200).json({ status: "live" }));

  app.get("/api/ready", async (_request, response, next) => {
    try {
      const readiness = options.readiness
        ? await options.readiness()
        : {
            ready: options.workerHealth?.().status !== "failed",
            checks: {
              database: !options.pipelineUnavailable,
              migrations: !options.pipelineUnavailable,
              reconciliation: options.workerHealth?.().status === "running",
              worker: options.workerHealth?.().status !== "failed",
              configuration: true,
            },
          };
      response.status(readiness.ready ? 200 : 503).json({
        status: readiness.ready ? "ready" : "not_ready",
        runtime: runtimeState(options.runtimeMode ?? "test"),
        checks: readiness.checks,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/health", (_request, response) => {
    const worker = options.workerHealth?.();
    if (worker?.status === "failed") {
      response.status(503).json({ status: "degraded", queue_worker: "failed" });
      return;
    }
    response.status(200).json({
      status: "ok",
      ...(options.runtimeMode ? { runtime: runtimeState(options.runtimeMode) } : {}),
      ...(worker ? { queue_worker: worker.status } : {}),
    });
  });

  if (options.auth?.mode === "enabled") {
    const auth = createAuthService(options.auth);
    // Only login needs a public JSON body. Protected bodies are deliberately
    // parsed after authentication so malformed/oversized anonymous requests
    // receive 401 rather than consuming parser work or leaking route behaviour.
    app.use("/api/auth/login", jsonParser);
    auth.publicRoutes(app);
    app.use("/api", (request, response, next) => {
      // Google's callback is public but remains bound to its one-use state cookie.
      if (request.path === "/integrations/google/callback") return next();
      return auth.protect(request, response, next);
    });
    app.use("/api", jsonParser);
  } else {
    // Isolated unit tests explicitly opt out of auth and retain the existing
    // parser semantics. Runtime composition never chooses this path.
    app.use(jsonParser);
  }

  const commandRepository =
    options.commands ??
    (options.milestoneFour?.repository && "submitCommand" in options.milestoneFour.repository
      ? (options.milestoneFour
          .repository as unknown as import("../../shared/command-repository.js").RunCommandRepository)
      : options.milestoneThree?.repository && "submitCommand" in options.milestoneThree.repository
        ? (options.milestoneThree
            .repository as unknown as import("../../shared/command-repository.js").RunCommandRepository)
        : options.milestoneTwo?.repository && "submitCommand" in options.milestoneTwo.repository
          ? (options.milestoneTwo
              .repository as unknown as import("../../shared/command-repository.js").RunCommandRepository)
          : options.findingsRepository && "submitCommand" in options.findingsRepository
            ? (options.findingsRepository as unknown as import("../../shared/command-repository.js").RunCommandRepository)
            : undefined);

  if ((options.ingestService || options.findingsRepository) && !commandRepository)
    throw new Error("Command repository is required for ingest and findings composition.");

  if (options.milestoneThree?.editorialCorrection)
    commandRepository?.configureEditorialCorrection?.((runId) =>
      options.milestoneThree!.editorialCorrection!.open(runId),
    );

  if (options.findingsRepository)
    registerFindingsRoutes(app, options.findingsRepository, {
      commands: commandRepository!,
      ...(options.testOnlySynchronousPipeline && !options.queue && options.milestoneFour
        ? {
            testOnlyLegacyContinuation: (runId: string) =>
              options.milestoneFour!.orchestrator.run(runId),
          }
        : {}),
    });

  if (options.pipelineUnavailable) registerPipelineUnavailableRoutes(app);

  if (options.ingestService && commandRepository)
    registerIngestRoutes(
      app,
      options.ingestService,
      commandRepository,
      options.testOnlySynchronousPipeline && !options.queue
        ? async (runId) => {
            if (options.milestoneTwo) await options.milestoneTwo.orchestrator.run(runId);
            if (options.milestoneThree) {
              await options.milestoneThree.orchestrator.run(runId);
              if (options.milestoneFour) await options.milestoneFour.orchestrator.run(runId);
            }
          }
        : undefined,
    );
  if (options.referenceApprovals) registerReferenceApprovalRoutes(app, options.referenceApprovals);
  registerGoogleOAuthRoutes(app, options.googleOAuth ?? { configured: false });
  registerModelDiagnosticRoutes(app, options.modelDiagnostic);
  if (options.milestoneTwo || options.milestoneThree || options.milestoneFour) {
    const commands = commandRepository;
    if (!commands) {
      app.use(
        [
          "/api/runs/:runId/milestone-two/resume",
          "/api/runs/:runId/milestone-three/resume",
          "/api/runs/:runId/milestone-four/resume",
          "/api/runs/:runId/export/retry",
        ],
        (_request, response) =>
          response.status(503).json({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message:
                "Pipeline continuation is unavailable because the command repository is not configured.",
            },
          }),
      );
    } else
      registerRunRoutes(app, {
        milestoneTwo: options.milestoneTwo,
        milestoneThree: options.milestoneThree,
        milestoneFour: options.milestoneFour,
        commands,
        ...(options.testOnlySynchronousPipeline && !options.queue
          ? {
              testOnlySynchronousContinuation: async (runId: string) => {
                if (options.milestoneTwo) await options.milestoneTwo.orchestrator.run(runId);
                if (options.milestoneThree) await options.milestoneThree.orchestrator.run(runId);
                if (options.milestoneFour) await options.milestoneFour.orchestrator.run(runId);
              },
            }
          : {}),
      });
  }

  if (options.calibration)
    registerCalibrationRoutes(app, options.calibration.service, options.calibration.repository);

  registerCheckerRoutes(app, runChecks);

  app.use("/api", (_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested endpoint was not found." },
    });
  });

  const clientDirectory = path.resolve(process.cwd(), "dist/client");
  if (options.serveClient !== false && existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory));
    app.get("/{*path}", (_request, response) => {
      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  } else {
    app.use((_request, response) => {
      response.status(404).json({
        error: { code: "NOT_FOUND", message: "The requested endpoint was not found." },
      });
    });
  }

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    response.locals.failureClassification = classifyError(error);
    if (error instanceof ZodError) {
      response.locals.failureClassification = classifyHttpStatus(400);
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "The command request is invalid.",
          details: error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      logger.warn("request.invalid_json", {
        method: request.method,
        path: response.locals.safePath,
      });
      response.status(400).json({
        error: { code: "INVALID_JSON", message: "The request body must be valid JSON." },
      });
      return;
    }

    if (typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.too.large") {
        response.locals.failureClassification = {
          category: "validation",
          reason_code: "payload_too_large",
        };
        response.status(413).json({
          error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
        });
        return;
      }
    }

    if (error instanceof NotFoundError) {
      response.locals.failureClassification = classifyHttpStatus(404);
      logger.info("request.not_found", { method: request.method, path: response.locals.safePath });
      response.status(404).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ConflictError || error instanceof RepositoryConflictError) {
      response.locals.failureClassification = classifyHttpStatus(409);
      // Expected races (cancel vs resume, duplicate disposition) — informational.
      logger.info("request.conflict", {
        method: request.method,
        path: response.locals.safePath,
        code: error.code,
      });
      response.status(409).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ServiceUnavailableError) {
      response.locals.failureClassification = classifyHttpStatus(503);
      logger.warn("request.service_unavailable", {
        method: request.method,
        path: response.locals.safePath,
        code: error.code,
      });
      response.status(503).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof UnprocessableError) {
      response.locals.failureClassification = classifyHttpStatus(422);
      logger.warn("request.unprocessable", {
        method: request.method,
        path: response.locals.safePath,
        code: error.code,
        message: error.message.slice(0, 200),
      });
      response.status(422).json({ error: { code: error.code, message: error.message } });
      return;
    }

    logger.error("request.internal_error", {
      request_id: response.locals.requestId,
      method: request.method,
      path: response.locals.safePath,
      ...classifyError(error),
    });

    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message:
          request.path === "/api/checker"
            ? "The checker could not be completed."
            : "The request could not be completed.",
      },
    });
  };
  app.use(errorHandler);

  return app;
}

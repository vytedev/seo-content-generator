import express, { type ErrorRequestHandler, type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConflictError, NotFoundError, UnprocessableError } from "../../shared/errors.js";
import { errorFields, logger } from "../logger.js";
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
import { createAuthService, type AuthServiceOptions } from "../auth/auth.js";
import { registerModelDiagnosticRoutes } from "../routes/model-diagnostic-routes.js";
import type { ModelDiagnosticService } from "../services/model-diagnostic-service.js";

const JSON_BODY_LIMIT = "100kb";
const AUTH_ALLOWED_ORIGINS = new Set(["http://127.0.0.1:5173", "http://127.0.0.1:3100"]);

type CheckRunner = (input: CheckerInput) => Finding[];

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
  /** Explicitly disabled preserves isolated tests; local runtime always supplies enabled auth. */
  auth?: { mode: "disabled" } | ({ mode: "enabled" } & AuthServiceOptions);
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const runChecks = options.runChecks ?? runDeterministicChecks;

  app.disable("x-powered-by");
  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
  if (options.auth?.mode === "enabled") {
    app.use("/api", (request, response, next) => {
      const origin = request.header("origin");
      if (origin && AUTH_ALLOWED_ORIGINS.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Vary", "Origin");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-CSRF-Token, Idempotency-Key",
        );
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
      }
      if (request.method === "OPTIONS") {
        response.status(origin && AUTH_ALLOWED_ORIGINS.has(origin) ? 204 : 403).end();
        return;
      }
      next();
    });
  }

  // Request log: method, path and duration for every API call. Run IDs and
  // step IDs appear in the path; request bodies (handoff JSON, dispositions)
  // are never logged.
  app.use((request, _response, next) => {
    const startedAt = Date.now();
    next();
    request.on("close", () => {
      if (request.path.startsWith("/api"))
        logger.debug("request", {
          method: request.method,
          path: request.path,
          ms: Date.now() - startedAt,
        });
    });
  });

  app.get("/api/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
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

  if (options.findingsRepository)
    registerFindingsRoutes(app, options.findingsRepository, options.milestoneFour?.orchestrator);

  if (options.pipelineUnavailable) registerPipelineUnavailableRoutes(app);

  if (options.ingestService)
    registerIngestRoutes(
      app,
      options.ingestService,
      options.milestoneTwo?.orchestrator,
      options.milestoneThree?.orchestrator,
      options.milestoneFour?.orchestrator,
    );
  if (options.referenceApprovals) registerReferenceApprovalRoutes(app, options.referenceApprovals);
  registerGoogleOAuthRoutes(app, options.googleOAuth ?? { configured: false });
  registerModelDiagnosticRoutes(app, options.modelDiagnostic);
  if (options.milestoneTwo || options.milestoneThree || options.milestoneFour)
    registerRunRoutes(app, {
      milestoneTwo: options.milestoneTwo,
      milestoneThree: options.milestoneThree,
      milestoneFour: options.milestoneFour,
    });

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
    if (error instanceof SyntaxError && "body" in error) {
      logger.warn("request.invalid_json", { method: request.method, path: request.path });
      response.status(400).json({
        error: { code: "INVALID_JSON", message: "The request body must be valid JSON." },
      });
      return;
    }

    if (typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.too.large") {
        response.status(413).json({
          error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
        });
        return;
      }
    }

    if (error instanceof NotFoundError) {
      logger.info("request.not_found", { method: request.method, path: request.path });
      response.status(404).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ConflictError) {
      // Expected races (cancel vs resume, duplicate disposition) — informational.
      logger.info("request.conflict", {
        method: request.method,
        path: request.path,
        code: error.code,
      });
      response.status(409).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof UnprocessableError) {
      logger.warn("request.unprocessable", {
        method: request.method,
        path: request.path,
        code: error.code,
        message: error.message.slice(0, 200),
      });
      response.status(422).json({ error: { code: error.code, message: error.message } });
      return;
    }

    logger.error("request.internal_error", {
      method: request.method,
      path: request.path,
      ...errorFields(error),
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

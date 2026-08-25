import type { Express } from "express";
import { z } from "zod";
import { UnprocessableError } from "../../shared/errors.js";
import type { CalibrationRepository } from "../repositories/calibration-repository.js";
import type { CalibrationService } from "../services/calibration-service.js";

const StartSchema = z.object({ idempotency_key: z.string().trim().min(1).max(200) }).strict();
const UuidSchema = z.string().uuid();

export function registerCalibrationRoutes(
  app: Express,
  service: CalibrationService,
  repository: CalibrationRepository,
): void {
  const id = (value: string | undefined) => {
    const parsed = UuidSchema.safeParse(value);
    if (!parsed.success) throw new UnprocessableError("Calibration run ID must be a UUID.");
    return parsed.data;
  };
  app.post("/api/calibrations", async (request, response, next) => {
    try {
      const parsed = StartSchema.safeParse(request.body);
      if (!parsed.success) throw new UnprocessableError("A valid idempotency_key is required.");
      response.status(200).json(await service.start(parsed.data.idempotency_key));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/calibrations/:id/resume", async (request, response, next) => {
    try {
      response.status(200).json(await service.resume(id(request.params.id)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/calibrations", async (_request, response, next) => {
    try {
      response.status(200).json({ runs: await repository.listRuns() });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/calibrations/:id", async (request, response, next) => {
    try {
      response.status(200).json(await repository.getRun(id(request.params.id)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/calibrations/:id/results", async (request, response, next) => {
    try {
      response.status(200).json({ results: await repository.getResults(id(request.params.id)) });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/calibrations/:id/report", async (request, response, next) => {
    try {
      response.status(200).json(await repository.getCombined(id(request.params.id)));
    } catch (error) {
      next(error);
    }
  });
  app.post(
    "/api/calibrations/:id/reference-proposals/versions",
    async (request, response, next) => {
      try {
        response
          .status(201)
          .json({ versions: await repository.createReferenceVersions(id(request.params.id)) });
      } catch (error) {
        next(error);
      }
    },
  );
}

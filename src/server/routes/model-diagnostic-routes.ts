import type { Express } from "express";
import { z } from "zod";
import { ModelDiagnosticRequestSchema } from "../../shared/contracts/model-diagnostic.js";
import type { ModelDiagnosticService } from "../services/model-diagnostic-service.js";

const idempotencyKeySchema = z.string().uuid();

export function registerModelDiagnosticRoutes(
  app: Express,
  service?: ModelDiagnosticService,
): void {
  app.post("/api/integrations/model/diagnostic", async (request, response, next) => {
    const input = ModelDiagnosticRequestSchema.safeParse(request.body);
    const isJson = request.is("application/json") === "application/json";
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.header("idempotency-key") ?? request.header("x-idempotency-key"),
    );
    if (!isJson || !input.success || !idempotencyKey.success) {
      response.status(400).json({
        error: {
          code: "INVALID_MODEL_DIAGNOSTIC_REQUEST",
          message:
            "Explicit confirmation and a valid client-generated Idempotency-Key UUID are required.",
        },
      });
      return;
    }
    if (!service) {
      response.status(200).json({
        provider: "openrouter",
        model: null,
        status: "failed",
        error_category: "unavailable",
        message: "OpenRouter is not configured locally.",
        input_tokens: 0,
        output_tokens: 0,
        cost_micros: 0,
        latency_ms: 0,
      });
      return;
    }
    try {
      response.status(200).json(await service.run(idempotencyKey.data));
    } catch (error) {
      next(error);
    }
  });
}

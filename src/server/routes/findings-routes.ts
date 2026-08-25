import type { Express } from "express";
import {
  BulkDispositionSchema,
  FindingFiltersSchema,
  type MilestoneThreeRepository,
} from "../../shared/milestone-three.js";
import type { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";

export function registerFindingsRoutes(
  app: Express,
  findingsRepository: MilestoneThreeRepository,
  continuation?: MilestoneFourOrchestrator,
): void {
  app.get("/api/runs/:runId/findings", async (request, response, next) => {
    const parsed = FindingFiltersSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "The finding filters are invalid.",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    try {
      response.status(200).json({
        findings: await findingsRepository.listFindings(request.params.runId!, parsed.data),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:runId/findings/dispositions", async (request, response, next) => {
    const parsed = BulkDispositionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "The dispositions are invalid.",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    try {
      const result = await findingsRepository.submitDispositions(
        request.params.runId!,
        parsed.data,
      );
      if (result.continuation_required && continuation) {
        try {
          await continuation.run(request.params.runId!);
          response.status(200).json({ ...result, continuation: "completed" });
        } catch {
          // Decisions are already committed atomically. The client reconciles from
          // run detail; retry uses the existing milestone-four recovery path.
          response.status(202).json({ ...result, continuation: "retryable_failed" });
        }
        return;
      }
      response.status(200).json({ ...result, continuation: "not_started" });
    } catch (error) {
      next(error);
    }
  });
}

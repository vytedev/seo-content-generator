import type { Express } from "express";
import type { RunCommandRepository } from "../../shared/command-repository.js";
import { buildRouteCommand, commandAcceptedBody } from "./command-submission.js";
import {
  BulkDispositionSchema,
  FindingFiltersSchema,
  type MilestoneThreeRepository,
} from "../../shared/milestone-three.js";

export function registerFindingsRoutes(
  app: Express,
  findingsRepository: MilestoneThreeRepository,
  options: {
    commands: RunCommandRepository;
    testOnlyLegacyContinuation?: (runId: string) => Promise<void>;
  },
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
      const submission = await options.commands.submitCommand(
        buildRouteCommand({
          kind: "submit_findings",
          run_id: request.params.runId!,
          idempotency_key: parsed.data.idempotency_key,
          body: { dispositions: parsed.data },
        }),
      );
      if (options.testOnlyLegacyContinuation) {
        await options.testOnlyLegacyContinuation(request.params.runId!);
        response.status(200).json({
          ...(submission.result as object),
          continuation: "completed",
        });
        return;
      }
      response.status(202).json(commandAcceptedBody(submission));
    } catch (error) {
      next(error);
    }
  });
}

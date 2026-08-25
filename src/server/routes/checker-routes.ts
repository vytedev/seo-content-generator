import type { Express } from "express";
import { CheckerInputSchema, type CheckerInput, type Finding } from "../../shared/checker/index.js";

export type CheckRunner = (input: CheckerInput) => Finding[];

export function registerCheckerRoutes(app: Express, runChecks: CheckRunner): void {
  app.post("/api/checker", (request, response, next) => {
    const parsed = CheckerInputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "The checker input is invalid.",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    try {
      const findings = runChecks(parsed.data);
      const summary = findings.reduce(
        (counts, finding) => {
          counts[finding.severity] += 1;
          return counts;
        },
        { info: 0, warning: 0, blocker: 0 },
      );
      response.status(200).json({ findings, summary });
    } catch (error) {
      next(error);
    }
  });
}

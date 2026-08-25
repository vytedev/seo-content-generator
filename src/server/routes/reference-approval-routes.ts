import type { Express } from "express";
import { z, ZodError } from "zod";
import { ApprovalAttestationInputSchema } from "../../shared/approval.js";
import type { PostgresReferenceApprovalRepository } from "../repositories/reference-approval-repository.js";

const VersionIdSchema = z.string().uuid();

export function registerReferenceApprovalRoutes(
  app: Express,
  repository: PostgresReferenceApprovalRepository,
): void {
  app.get("/api/reference-versions", async (_request, response, next) => {
    try {
      response.status(200).json(await repository.listVersions());
    } catch (error) {
      next(error);
    }
  });
  app.post(
    "/api/reference-versions/:versionId/approval-attestations",
    async (request, response, next) => {
      try {
        const versionId = VersionIdSchema.parse(request.params.versionId);
        const input = ApprovalAttestationInputSchema.parse(request.body);
        response.status(201).json(await repository.recordPendingAttestation(versionId, input));
      } catch (error) {
        if (error instanceof ZodError) {
          response.status(400).json({
            error: {
              code: "INVALID_INPUT",
              message: "The approval attestation is invalid.",
              details: error.issues.map((issue) => ({
                path: issue.path.join(".") || "versionId",
                message: issue.message,
              })),
            },
          });
          return;
        }
        next(error);
      }
    },
  );
}

import { z } from "zod";
import { apiFetch } from "./api.js";
import {
  CalibrationCombinedReportSchema,
  CalibrationPostResultSchema,
  CalibrationRunDetailSchema,
  type CalibrationCombinedReport,
  type CalibrationPostResult,
  type CalibrationRunDetail,
} from "../../shared/contracts/calibration.js";

const RunListSchema = z.object({ runs: z.array(CalibrationRunDetailSchema) }).strict();
const ResultsSchema = z.object({ results: z.array(CalibrationPostResultSchema) }).strict();
const ProposalVersionsSchema = z
  .object({
    versions: z.array(
      z
        .object({
          reference_version_id: z.string().uuid(),
          editorial_status: z.literal("pending_editorial_approval"),
        })
        .strict(),
    ),
  })
  .strict();

export type ProposalVersions = z.infer<typeof ProposalVersionsSchema>["versions"];

export class CalibrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CalibrationApiError(
      "The calibration service returned an unreadable response.",
      response.status,
    );
  }
  if (!response.ok) {
    const apiMessage =
      typeof body === "object" && body && "error" in body
        ? (body as { error?: { message?: unknown } }).error?.message
        : undefined;
    throw new CalibrationApiError(
      typeof apiMessage === "string" ? apiMessage : statusMessage(response.status),
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new CalibrationApiError(
      "The calibration service returned an unexpected response.",
      response.status,
    );
  return parsed.data;
}

function statusMessage(status: number): string {
  if (status === 404) return "The calibration run or report was not found.";
  if (status === 409)
    return "The calibration run changed or is already in progress. Reload it before retrying.";
  if (status === 422) return "Check the calibration run ID or idempotency key and try again.";
  if (status === 503)
    return "Calibration needs the local database service. Check a draft is still available without it.";
  return "The calibration request could not be completed.";
}

export const calibrationApi = {
  list: () => request("/api/calibrations", RunListSchema).then(({ runs }) => runs),
  start: (idempotencyKey: string) =>
    request("/api/calibrations", CalibrationRunDetailSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    }),
  load: (id: string) =>
    request(`/api/calibrations/${encodeURIComponent(id)}`, CalibrationRunDetailSchema),
  resume: (id: string) =>
    request(`/api/calibrations/${encodeURIComponent(id)}/resume`, CalibrationRunDetailSchema, {
      method: "POST",
    }),
  results: (id: string): Promise<CalibrationPostResult[]> =>
    request(`/api/calibrations/${encodeURIComponent(id)}/results`, ResultsSchema).then(
      ({ results }) => results,
    ),
  report: (id: string): Promise<CalibrationCombinedReport> =>
    request(`/api/calibrations/${encodeURIComponent(id)}/report`, CalibrationCombinedReportSchema),
  createProposalVersions: (id: string): Promise<ProposalVersions> =>
    request(
      `/api/calibrations/${encodeURIComponent(id)}/reference-proposals/versions`,
      ProposalVersionsSchema,
      { method: "POST" },
    ).then(({ versions }) => versions),
};

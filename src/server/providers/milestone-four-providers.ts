import {
  CoherenceRequestSchema,
  CoherenceResponseSchema,
  RevisionRequestSchema,
  RevisionResponseSchema,
  type CoherenceRequest,
  type CoherenceResponse,
  type RevisionRequest,
  type RevisionResponse,
} from "../../shared/milestone-four.js";
import type { ReviewFinding } from "../../shared/milestone-three.js";

export interface RevisionProvider {
  readonly provider: string;
  readonly model: string;
  revise(request: RevisionRequest): Promise<RevisionResponse>;
}
export interface CoherenceProvider {
  readonly provider: string;
  readonly model: string;
  review(request: CoherenceRequest): Promise<CoherenceResponse>;
}

/** Strict local provider: deterministic callbacks are injectable, and no network is available. */
export class MockRevisionProvider implements RevisionProvider {
  readonly provider = "mock-local";
  readonly calls: RevisionRequest[] = [];
  constructor(
    readonly model: string,
    private readonly transform: (request: RevisionRequest) => RevisionResponse["document"] = (
      request,
    ) => request.current_document,
  ) {}
  async revise(raw: RevisionRequest): Promise<RevisionResponse> {
    const request = RevisionRequestSchema.parse(raw);
    this.calls.push(structuredClone(request));
    return RevisionResponseSchema.parse({
      document: this.transform(request),
      finding_results: request.accepted_findings.map((finding) => ({
        finding_id: finding.id,
        status: "applied",
        reason: "Applied at the accepted location.",
      })),
      usage: { input_units: 100, output_units: 50, cost_micros: 150 },
    });
  }
}

export class MockCoherenceProvider implements CoherenceProvider {
  readonly provider = "mock-local";
  readonly calls: CoherenceRequest[] = [];
  private index = 0;
  constructor(
    readonly model: string,
    private readonly responses: ReviewFinding[][] = [[]],
  ) {}
  async review(raw: CoherenceRequest): Promise<CoherenceResponse> {
    const request = CoherenceRequestSchema.parse(raw);
    this.calls.push(structuredClone(request));
    const findings = this.responses[Math.min(this.index++, this.responses.length - 1)] ?? [];
    return CoherenceResponseSchema.parse({
      findings,
      usage: { input_units: 80, output_units: 20, cost_micros: 100 },
    });
  }
}

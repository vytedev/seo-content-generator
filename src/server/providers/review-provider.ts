import {
  ReviewRequestSchema,
  ReviewResponseSchema,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewResponse,
  type ReviewStep,
} from "../../shared/milestone-three.js";
import { hashIdempotencyInput } from "../../shared/worker-contracts.js";

export interface ReviewProvider {
  readonly provider: string;
  readonly model: string;
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/** Pinned local provider. It emits findings only; the application verifier owns fact records. */
export class MockReviewProvider implements ReviewProvider {
  readonly provider = "mock";
  readonly calls: ReviewRequest[] = [];

  constructor(
    readonly model: string,
    private readonly outputs: Partial<Record<ReviewStep, ReviewFinding[]>> = {},
  ) {
    if (!model.trim()) throw new Error("A pinned model identifier is required");
  }

  async review(raw: ReviewRequest): Promise<ReviewResponse> {
    const request = ReviewRequestSchema.parse(raw);
    if (request.model !== this.model)
      throw new Error("Review model does not match pinned provider model");
    this.calls.push(structuredClone(request));
    const findings = this.outputs[request.step] ?? [];
    const responseBody = { findings, sources: [], claims: [] };
    return ReviewResponseSchema.parse({
      request_id: `review_${hashIdempotencyInput(request)}`,
      ...responseBody,
      usage: {
        input_units: JSON.stringify(request).length,
        output_units: JSON.stringify(responseBody).length,
        cost_micros: 0,
      },
    });
  }
}

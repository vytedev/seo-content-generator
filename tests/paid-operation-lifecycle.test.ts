import { describe, expect, it, vi } from "vitest";
import {
  executePaidOperation,
  markPreDispatchProviderFailure,
  paidOperationAmbiguity,
  paidOperationReleaseReason,
} from "../src/server/providers/paid-operation-lifecycle.js";

class TypedFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

describe("shared paid-operation lifecycle", () => {
  it.each([
    ["REVIEW_PROVIDER_TOKEN_MISSING", "configuration_before_dispatch"],
    ["REVIEW_PROVIDER_AUTHENTICATION_BEFORE_DISPATCH", "authentication_before_dispatch"],
    ["REVIEW_PROVIDER_BILLING_BEFORE_DISPATCH", "billing_before_dispatch"],
    ["REVISION_PROVIDER_MODEL_MISMATCH", "configuration_before_dispatch"],
  ] as const)("narrowly releases proven undispatched %s", (code, reason) => {
    const kind = code.startsWith("REVISION_") ? "revision" : "review";
    expect(
      paidOperationReleaseReason(kind, markPreDispatchProviderFailure(new TypedFailure(code))),
    ).toBe(reason);
  });

  it("rejects an unbranded error even when its code mimics a pre-dispatch failure", () => {
    expect(
      paidOperationReleaseReason(
        "review",
        new TypedFailure("REVIEW_PROVIDER_AUTHENTICATION_BEFORE_DISPATCH"),
      ),
    ).toBeNull();
  });

  it("does not release malformed provider success and checkpoints valid success", async () => {
    const adapter = {
      markInFlight: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    await expect(
      executePaidOperation({
        kind: "review",
        command: { operation_id: "operation-1" },
        adapter,
        dispatch: async () => ({ malformed: true }),
        validate: () => {
          throw new Error("malformed success");
        },
      }),
    ).rejects.toThrow("malformed success");
    expect(adapter.markInFlight).toHaveBeenCalledOnce();
    expect(adapter.release).not.toHaveBeenCalled();
    expect(adapter.checkpoint).not.toHaveBeenCalled();
  });

  it("releases before-dispatch failure but preserves an ambiguous in-flight projection", async () => {
    const adapter = {
      markInFlight: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    await expect(
      executePaidOperation({
        kind: "review",
        command: { operation_id: "operation-2" },
        adapter,
        dispatch: async () => {
          throw markPreDispatchProviderFailure(
            new TypedFailure("REVIEW_PROVIDER_AUTHENTICATION_BEFORE_DISPATCH"),
          );
        },
        validate: (value) => value,
      }),
    ).rejects.toThrow();
    expect(adapter.release).toHaveBeenCalledWith(
      { operation_id: "operation-2" },
      "authentication_before_dispatch",
    );
    expect(
      paidOperationAmbiguity({
        operation_id: "operation-3",
        kind: "review",
        owner: "step_execution:execution-1",
      }),
    ).toEqual({
      operation_id: "operation-3",
      kind: "review",
      stage: "provider_in_flight",
      exposure: "possible_provider_spend",
      owner: "step_execution:execution-1",
      ambiguity_reason: "provider_in_flight_without_checkpoint",
    });
  });
});

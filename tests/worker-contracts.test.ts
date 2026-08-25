import { describe, expect, it } from "vitest";
import {
  decideIdempotency,
  decideLease,
  hashIdempotencyInput,
  holdsLease,
  IdempotencyContractError,
  LeaseContractError,
} from "../src/shared/index.js";

const emptyLease = { token: null, owner: null, expires_at: null } as const;
const now = new Date("2025-01-01T00:00:00.000Z");

describe("worker lease contract", () => {
  it("grants an empty lease with a fencing token", () => {
    const decision = decideLease(emptyLease, "worker-a", now, 30_000, "token-a");
    expect(decision).toEqual({
      kind: "granted",
      lease: {
        token: "token-a",
        owner: "worker-a",
        expires_at: new Date("2025-01-01T00:00:30.000Z"),
      },
    });
    expect(decision.kind === "granted" && holdsLease(decision.lease, "token-a", now)).toBe(true);
  });

  it("keeps an unexpired lease exclusive and permits takeover only at expiry", () => {
    const active = {
      token: "token-a",
      owner: "worker-a",
      expires_at: new Date("2025-01-01T00:00:30.000Z"),
    };
    expect(decideLease(active, "worker-b", now, 30_000, "token-b")).toEqual({
      kind: "busy",
      lease: active,
    });
    expect(holdsLease(active, "token-b", now)).toBe(false);
    expect(decideLease(active, "worker-b", active.expires_at, 10_000, "token-b")).toMatchObject({
      kind: "granted",
      lease: { token: "token-b", owner: "worker-b" },
    });
    expect(holdsLease(active, "token-a", active.expires_at)).toBe(false);
  });

  it("rejects invalid dates, durations and partially populated lease state", () => {
    expect(() => decideLease(emptyLease, "worker", now, 0)).toThrow(LeaseContractError);
    expect(() => decideLease(emptyLease, "worker", new Date(Number.NaN), 1)).toThrow(
      "must be valid",
    );
    expect(() =>
      decideLease({ token: "token", owner: null, expires_at: null }, "worker", now, 1),
    ).toThrow("all null or all populated");
  });
});

describe("idempotency contract", () => {
  it("hashes equivalent object inputs canonically with standard SHA-256", () => {
    expect(hashIdempotencyInput({ b: 2, a: { y: true, x: [1, null] } })).toBe(
      hashIdempotencyInput({ a: { x: [1, null], y: true }, b: 2 }),
    );
    expect(hashIdempotencyInput("abc")).toBe(
      "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25",
    );
  });

  it("executes once then replays the stored result for the same input", () => {
    const first = decideIdempotency("export:run-1:v2", { document_id: "doc-2" }, null);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") throw new Error("Expected execute decision");
    expect(
      decideIdempotency(
        "export:run-1:v2",
        { document_id: "doc-2" },
        {
          key: first.key,
          input_hash: first.input_hash,
          result: { external_document_id: "google-123" },
        },
      ),
    ).toEqual({ kind: "replay", result: { external_document_id: "google-123" } });
  });

  it("reports conflict when a key is reused for different input", () => {
    const inputHash = hashIdempotencyInput({ document_id: "doc-1" });
    expect(
      decideIdempotency(
        "export",
        { document_id: "doc-2" },
        {
          key: "export",
          input_hash: inputHash,
          result: "done",
        },
      ),
    ).toMatchObject({ kind: "conflict", expected_input_hash: inputHash });
  });

  it("rejects empty keys, sparse arrays and non-plain or unsupported input", () => {
    expect(() => decideIdempotency(" ", {}, null)).toThrow(IdempotencyContractError);
    expect(() => hashIdempotencyInput({ value: undefined })).toThrow(
      "Unsupported idempotency input type",
    );
    expect(() => hashIdempotencyInput(new Array(1))).toThrow("Sparse arrays");
    expect(() => hashIdempotencyInput(new Date())).toThrow("plain objects");
  });
});

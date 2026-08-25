import { describe, expect, it } from "vitest";
import { assertImmutableSourceMatches } from "../src/server/repositories/postgres-repository.js";
import { canonicalHash } from "../src/shared/milestone-two.js";

const snapshot = { content_hash: "a".repeat(64), selection: { strategy: "exact" } };
const incoming = {
  source_type: "public_storefront",
  title: "Alpha Chair",
  retrieved_at: "2025-01-02T03:04:05.000Z",
  snapshot,
  evidence: "Price: £1,200",
};
const stored = {
  source_type: incoming.source_type,
  title: incoming.title,
  retrieved_at: new Date(incoming.retrieved_at),
  content_hash: canonicalHash(snapshot),
  snapshot,
  evidence: [incoming.evidence],
};

describe("PostgreSQL source conflict guard", () => {
  it("accepts a mocked DO NOTHING/select row only when every immutable field matches", () => {
    expect(() => assertImmutableSourceMatches(stored, incoming, stored.content_hash)).not.toThrow();
  });

  it.each([
    ["title", { title: "Other chair" }],
    ["source_type", { source_type: "unresolved" }],
    ["retrieved_at", { retrieved_at: new Date("2025-01-03T03:04:05.000Z") }],
    ["content_hash", { content_hash: "b".repeat(64) }],
    ["snapshot", { snapshot: { ...snapshot, conflict: true } }],
    ["evidence", { evidence: ["Different evidence"] }],
  ])("rejects conflicting %s returned by the select", (_field, changed) => {
    expect(() =>
      assertImmutableSourceMatches({ ...stored, ...changed }, incoming, stored.content_hash),
    ).toThrow("Immutable source conflict");
  });
});

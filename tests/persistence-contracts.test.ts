import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  artifacts,
  claims,
  exports as exportRecords,
  findings,
  referenceDocuments,
  referenceVersions,
  runs,
  stepExecutions,
  stepReferenceSnapshots,
  substepReferenceMap,
} from "../src/db/index.js";

const invariantSql = readFileSync(
  new URL("../drizzle/0001_invariants.sql", import.meta.url),
  "utf8",
);
const recoverySql = readFileSync(
  new URL("../drizzle/0002_milestone_two_recovery.sql", import.meta.url),
  "utf8",
);

describe("persistence contracts", () => {
  it("exports the core durable tables", () => {
    expect([
      runs,
      stepExecutions,
      artifacts,
      findings,
      claims,
      referenceDocuments,
      referenceVersions,
      substepReferenceMap,
      stepReferenceSnapshots,
      exportRecords,
    ]).toHaveLength(10);
  });

  it("defines append-only triggers for immutable records", () => {
    for (const table of [
      "artifacts",
      "document_versions",
      "findings",
      "finding_dispositions",
      "sources",
      "claims",
      "claim_sources",
      "reference_versions",
      "step_reference_snapshots",
      "provider_usage",
      "exports",
    ]) {
      expect(invariantSql).toContain(`CREATE TRIGGER ${table}_immutable`);
    }
  });

  it("defines exact reference snapshot validation", () => {
    expect(invariantSql).toContain("snapshot hash does not match reference version");
    expect(invariantSql).toContain("reference is not mapped to execution step");
    expect(invariantSql).toContain("execution must snapshot every mapped reference");
    expect(invariantSql).toContain("step_reference_snapshots_complete");
  });

  it("requires aligned claim evidence and immutable export input", () => {
    expect(invariantSql).toContain("claim source status must match claim status");
    expect(invariantSql).toContain("verified claim requires a verified source");
    expect(invariantSql).toContain("provenance claims require source evidence");
    expect(invariantSql).toContain("provenance claim requires a source record");
    expect(invariantSql).toContain("export input hash does not match immutable inputs");
    expect(invariantSql).toContain("exports_run_document_destination_unique");
  });

  it("defines fenced atomic worker operations", () => {
    expect(invariantSql).toContain("FUNCTION claim_step_execution");
    expect(invariantSql).toContain("FUNCTION start_step_execution");
    expect(invariantSql).toContain("FUNCTION heartbeat_step_execution");
    expect(recoverySql).toContain("FUNCTION complete_step_execution");
    expect(recoverySql).toContain("FUNCTION fail_step_execution");
    expect(`${invariantSql}\n${recoverySql}`).toMatch(/lease_token\s*=\s*fencing_token/);
  });
});

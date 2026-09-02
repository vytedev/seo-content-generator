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
const coherenceMigrationSql = readFileSync(
  new URL("../drizzle/0038_perfect_prodigy.sql", import.meta.url),
  "utf8",
);
const exportServiceSource = readFileSync(
  new URL("../src/server/services/export-service.ts", import.meta.url),
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

  it("backfills both legacy coherence checkpoint shapes before enforcing status", () => {
    const addStatus = coherenceMigrationSql.indexOf('ADD COLUMN "status" text;');
    const backfill = coherenceMigrationSql.indexOf('UPDATE "coherence_checkpoints"');
    const defaultStatus = coherenceMigrationSql.indexOf("SET DEFAULT 'started'");
    const notNull = coherenceMigrationSql.indexOf("SET NOT NULL");
    const statusCheck = coherenceMigrationSql.indexOf("coherence_checkpoints_status_check");
    expect(addStatus).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(addStatus);
    expect(defaultStatus).toBeGreaterThan(backfill);
    expect(notNull).toBeGreaterThan(defaultStatus);
    expect(statusCheck).toBeGreaterThan(notNull);
    expect(coherenceMigrationSql).toMatch(
      /SET "status" = CASE WHEN "response" IS NOT NULL THEN 'checkpointed' ELSE 'provider_in_flight' END/,
    );
    expect(coherenceMigrationSql).toContain('WHERE "status" IS NULL');
    expect(coherenceMigrationSql).toContain(
      `CHECK ("coherence_checkpoints"."status" in ('started','provider_in_flight','checkpointed'))`,
    );
  });

  it("independently proves recovered coherence export from authoritative live lineage", () => {
    expect(exportServiceSource).toContain("recovery.operation_id=c.operation_id");
    expect(exportServiceSource).toContain("recovery.run_id=c.run_id");
    expect(exportServiceSource).toContain("recovery.document_version_id=c.document_version_id");
    expect(exportServiceSource).toContain(
      "recovery.producing_step_execution_id=c.producing_step_execution_id",
    );
    expect(exportServiceSource).toContain(
      "recovery.recovery_step_execution_id=current_execution.id",
    );
    expect(exportServiceSource).toContain("recovery.outcome='export'");
    expect(exportServiceSource).toContain("current_run.current_step='final_coherence_export'");
    expect(exportServiceSource).toContain("current_run.status='running'");
    expect(exportServiceSource).toContain("newer.attempt>current_execution.attempt");
    expect(exportServiceSource).toContain("current_execution.status='running'");
    expect(exportServiceSource).toContain("current_execution.lease_token=$4");
    expect(exportServiceSource).toContain("current_execution.lease_expires_at>clock_timestamp()");
    expect(exportServiceSource).toContain("finding->>'severity'='blocker'");
    expect(exportServiceSource).toContain(
      "finalGate.coherence_response_hash === canonicalHash(parsedCoherenceResponse.data)",
    );
    expect(exportServiceSource).toContain(
      'parsedCoherenceResponse.data.findings.every((finding) => finding.severity !== "blocker")',
    );
  });

  it("enforces coherence response pairing and rejects invalid transitions", () => {
    expect(coherenceMigrationSql).toContain("coherence_checkpoints_response_pair");
    expect(coherenceMigrationSql).toContain(
      "OLD.status = 'started' AND NEW.status = 'provider_in_flight'",
    );
    expect(coherenceMigrationSql).toContain(
      "OLD.status = 'provider_in_flight' AND NEW.status IN ('started','checkpointed')",
    );
    expect(coherenceMigrationSql).toContain(
      "RAISE EXCEPTION 'invalid coherence checkpoint transition",
    );
    expect(coherenceMigrationSql).not.toContain(
      "OLD.status = 'started' AND NEW.status = 'checkpointed'",
    );
  });
});

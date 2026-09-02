import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "drizzle/0050_lyrical_the_professor.sql";
const migration = readFileSync(migrationPath, "utf8");

describe("production-readiness persistence migration", () => {
  it("is the next append-only migration and creates command, activity, and SERP stores", () => {
    expect(migration).toContain('CREATE TABLE "run_command_outbox"');
    expect(migration).toContain('CREATE TABLE "run_activity_events"');
    expect(migration).toContain('CREATE TABLE "serp_evidence"');
    expect(migration).toContain("run_command_outbox_terminal_result");
    expect(migration).toContain("run_command_outbox_guard");
    expect(migration).toContain("run_activity_events_immutable");
    expect(migration).toContain("serp_evidence_immutable");
  });

  it("adds and conservatively backfills typed hard-flag reasons", () => {
    expect(migration).toContain('ALTER TABLE "claims" ADD COLUMN "hard_flag_reason" text');
    expect(migration).toContain('ALTER TABLE "findings" ADD COLUMN "hard_flag_reason" text');
    expect(migration).toContain("ELSE 'unknown_legacy'");
    expect(migration).toContain("WHEN \"type\"='provenance' THEN 'provenance'");
    expect(migration).toContain("claims_hard_flag_reason");
    expect(migration).toContain("findings_hard_flag_reason");
  });

  it("normalises revision checkpoints and marks ambiguous in-flight operations", () => {
    expect(migration).toContain(
      'UPDATE "revision_operation_states" SET "status"=\'checkpointed\' WHERE "status"=\'response_validated\'',
    );
    for (const table of [
      "draft_operation_states",
      "review_operation_states",
      "revision_operation_states",
      "coherence_checkpoints",
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ADD COLUMN "release_reason" text`);
      expect(migration).toContain(`ALTER TABLE "${table}" ADD COLUMN "ambiguity_reason" text`);
      expect(migration).toContain(
        `UPDATE "${table}" SET "ambiguity_reason"='provider_in_flight_without_checkpoint'`,
      );
      expect(migration).toContain(`${table}_safety_reason`);
    }
    expect(migration).toContain(
      "revision_operation_states\".\"status\" in ('started','provider_in_flight','checkpointed')",
    );
  });

  it("enforces terminal results for commands and export records", () => {
    expect(migration).toMatch(/"terminal_result" is not null/i);
    expect(migration).toContain("terminal run command is immutable");
    expect(migration).toContain("export_operations_terminal_result");
    expect(migration).toContain("exports_terminal_result");
    expect(migration).toContain(
      '"status"=\'succeeded\' AND "external_document_id" IS NOT NULL AND "external_url" IS NOT NULL',
    );
  });

  it("does not alter any earlier migration through generated references", () => {
    expect(migration).not.toMatch(/(?:UPDATE|ALTER TABLE)\s+"?__drizzle_migrations"?/i);
    expect(migration).not.toContain("DROP TABLE");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";

/**
 * Shared PostgreSQL fixture reset for every integration suite.
 *
 * Previously each suite kept its own truncate list. They diverged, several
 * tables were omitted entirely and `content_templates` was in none of them, so
 * a suite inserting a template polluted every later suite sharing the database.
 * This is the single FK-safe reset used everywhere instead.
 *
 * TRUNCATE ... CASCADE resolves foreign-key ordering itself, so the list only
 * needs to be complete rather than topologically sorted.
 */
const RESET_TABLES = [
  "artifacts",
  "calibration_posts",
  "calibration_reference_proposals",
  "calibration_reports",
  "calibration_results",
  "calibration_run_snapshots",
  "calibration_runs",
  "calibration_snapshots",
  "claim_sources",
  "claims",
  "coherence_checkpoints",
  "coherence_recoveries",
  "content_templates",
  "deterministic_manifests",
  "deterministic_reruns",
  "document_versions",
  "draft_operation_states",
  "exceptional_correction_authorisations",
  "export_manifests",
  "export_operations",
  "exports",
  "finding_dispositions",
  "finding_review_set_members",
  "finding_review_sets",
  "finding_review_submissions",
  "findings",
  "google_oauth_token_versions",
  "link_candidates",
  "link_discovery_attempts",
  "link_discovery_cache",
  "model_diagnostic_operations",
  "operator_sessions",
  "pipeline_queue_jobs",
  "provider_operations",
  "provider_usage",
  "reference_activations",
  "reference_approval_attestations",
  "reference_attestation_verifications",
  "reference_documents",
  "reference_versions",
  "review_operation_adoptions",
  "review_operation_states",
  "revision_finding_audits",
  "revision_noop_completions",
  "revision_operation_states",
  "revision_provider_failures",
  "runs",
  "sources",
  "step_executions",
  "step_outputs",
  "step_reference_snapshots",
  "substep_reference_map",
] as const;

/**
 * Migration 0028 seeds two immutable content templates the pipeline resolves by
 * template_id/version. A BEFORE DELETE trigger enforces that immutability in
 * production, and TRUNCATE deliberately does not fire row-level triggers — so
 * the reset truncates and re-seeds rather than deleting, leaving the production
 * guarantee untouched.
 */
export const SEEDED_CONTENT_TEMPLATE_IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
] as const;

const SEED_MIGRATION = "drizzle/0028_step_1_12_exact_export.sql";

/** The seed statement is taken from the migration itself, so it cannot drift. */
function contentTemplateSeedSql(): string {
  const sql = readFileSync(resolve(process.cwd(), SEED_MIGRATION), "utf8");
  const start = sql.search(/INSERT INTO content_templates/i);
  if (start < 0) throw new Error(`No content_templates seed found in ${SEED_MIGRATION}`);
  // Quote-aware scan: the seeded JSON itself contains semicolons, so a plain
  // indexOf(";") would truncate the statement mid-string.
  let quoted = false;
  for (let index = start; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      // Doubled '' is an escaped quote inside a string, not a terminator.
      if (quoted && sql[index + 1] === "'") index += 1;
      else quoted = !quoted;
      continue;
    }
    if (character === ";" && !quoted) return sql.slice(start, index + 1);
  }
  throw new Error(`Unterminated content_templates seed in ${SEED_MIGRATION}`);
}

export async function resetPostgresFixtures(pool: pg.Pool): Promise<void> {
  await pool.query(`truncate ${RESET_TABLES.join(",")} cascade`);
  await pool.query(contentTemplateSeedSql());
  const seeded = await pool.query<{ count: string }>(
    "select count(*)::int count from content_templates where id = any($1::uuid[])",
    [[...SEEDED_CONTENT_TEMPLATE_IDS]],
  );
  if (Number(seeded.rows[0]?.count) !== SEEDED_CONTENT_TEMPLATE_IDS.length)
    throw new Error("Content template seed did not restore both immutable rows");
}

/**
 * Row counts for every persistent table. Used to prove that an operation which
 * must fail closed wrote nothing at all, rather than only checking the table a
 * test happens to think of.
 */
export async function tableRowCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of RESET_TABLES) {
    const result = await pool.query<{ count: number }>(`select count(*)::int count from ${table}`);
    counts[table] = result.rows[0]!.count;
  }
  return counts;
}

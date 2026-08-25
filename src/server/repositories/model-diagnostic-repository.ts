import type pg from "pg";
import { ModelDiagnosticResultSchema } from "../../shared/contracts/model-diagnostic.js";
import type { ModelDiagnosticStore } from "../services/model-diagnostic-service.js";

export class PostgresModelDiagnosticRepository implements ModelDiagnosticStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(idempotencyKey: string, model: string): ReturnType<ModelDiagnosticStore["claim"]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext($1)) as acquired",
        ["openrouter-model-diagnostic"],
      );
      if (!locked.rows[0]?.acquired) {
        await client.query("commit");
        return { kind: "in_progress" };
      }
      const existing = await client.query<{
        status: "pending" | "in_flight" | "succeeded" | "failed";
        safe_result: unknown;
      }>(
        `select status, safe_result
           from model_diagnostic_operations
          where idempotency_key = $1
          for update`,
        [idempotencyKey],
      );
      const row = existing.rows[0];
      if (row) {
        await client.query("commit");
        if (row.status === "succeeded" || row.status === "failed") {
          return { kind: "replay", result: ModelDiagnosticResultSchema.parse(row.safe_result) };
        }
        return { kind: "ambiguous" };
      }
      const active = await client.query(
        `select 1 from model_diagnostic_operations where status in ('pending','in_flight') limit 1`,
      );
      if (active.rowCount) {
        await client.query("commit");
        return { kind: "in_progress" };
      }
      await client.query(
        `insert into model_diagnostic_operations(idempotency_key, provider, model, status)
         values($1, 'openrouter', $2, 'in_flight')`,
        [idempotencyKey, model],
      );
      await client.query("commit");
      return { kind: "claimed" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    idempotencyKey: string,
    result: Parameters<ModelDiagnosticStore["complete"]>[1],
  ): Promise<void> {
    const parsed = ModelDiagnosticResultSchema.parse(result);
    const updated = await this.pool.query(
      `update model_diagnostic_operations
          set status = $2,
              safe_result = $3::jsonb,
              completed_at = clock_timestamp()
        where idempotency_key = $1 and status = 'in_flight'`,
      [idempotencyKey, parsed.status === "success" ? "succeeded" : "failed", parsed],
    );
    if (updated.rowCount !== 1)
      throw new Error("Model diagnostic completion state could not be recorded");
  }
}

/** Deterministic store for route/provider tests; runtime composition uses PostgreSQL. */
export class MemoryModelDiagnosticStore implements ModelDiagnosticStore {
  readonly operations = new Map<
    string,
    { status: "in_flight" | "succeeded" | "failed"; model: string; result?: unknown }
  >();

  async claim(idempotencyKey: string, model: string): ReturnType<ModelDiagnosticStore["claim"]> {
    const existing = this.operations.get(idempotencyKey);
    if (existing) {
      if (existing.status === "in_flight") return { kind: "ambiguous" };
      return { kind: "replay", result: ModelDiagnosticResultSchema.parse(existing.result) };
    }
    if ([...this.operations.values()].some((operation) => operation.status === "in_flight"))
      return { kind: "in_progress" };
    this.operations.set(idempotencyKey, { status: "in_flight", model });
    return { kind: "claimed" };
  }

  async complete(
    idempotencyKey: string,
    result: Parameters<ModelDiagnosticStore["complete"]>[1],
  ): Promise<void> {
    const operation = this.operations.get(idempotencyKey);
    if (!operation || operation.status !== "in_flight")
      throw new Error("Diagnostic is not in flight");
    const parsed = ModelDiagnosticResultSchema.parse(result);
    this.operations.set(idempotencyKey, {
      ...operation,
      status: parsed.status === "success" ? "succeeded" : "failed",
      result: parsed,
    });
  }
}

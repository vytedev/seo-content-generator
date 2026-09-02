import fs from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresMilestoneRepository } from "../src/server/repositories/postgres-repository.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { RepositoryConflictError } from "../src/shared/errors.js";
import { RunCommandSchema, type RunCommand } from "../src/shared/commands.js";
import { commandPayloadHash } from "../src/shared/command-repository.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new pg.Pool({ connectionString: url }) : null;
const databaseName = `command_repository_${process.pid}_${Date.now()}`;
const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
let pool: pg.Pool | null = null;
let repository: PostgresMilestoneRepository;

async function applyMigration(target: pg.Pool, path: string) {
  for (const statement of fs
    .readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim()))
    if (statement) await target.query(statement);
}

const handoff = {
  plane_ticket: "MOB-123",
  primary_keyword: "designer chairs",
  related_keywords: ["modern chairs"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};

function command(
  kind: RunCommand["kind"],
  key: string,
  body: Record<string, unknown>,
  commandId = `command-${kind}`,
): RunCommand {
  const draft = RunCommandSchema.parse({
    command_id: commandId,
    idempotency_key: key,
    payload_hash: "0".repeat(64),
    requested_at: "2026-09-03T10:00:00Z",
    kind,
    ...body,
  });
  return RunCommandSchema.parse({ ...draft, payload_hash: commandPayloadHash(draft) });
}

async function seed(key: string) {
  const run = await ingestHandoff(handoff, key, repository);
  await pool!.query("delete from pipeline_queue_jobs where run_id=$1", [run.run_id]);
  return run.run_id;
}

async function counts(runId: string, key: string) {
  return (
    await pool!.query(
      `select
       (select count(*)::int from run_command_outbox where idempotency_key=$2) commands,
       (select count(*)::int from run_activity_events where run_id=$1 and command_id in
         (select command_id from run_command_outbox where idempotency_key=$2)) activity,
       (select count(*)::int from pipeline_queue_jobs where run_id=$1) queue`,
      [runId, key],
    )
  ).rows[0] as { commands: number; activity: number; queue: number };
}

const commandKinds = [
  "create_run",
  "resume_run",
  "submit_findings",
  "cancel_run",
  "authorise_exceptional_correction",
  "retry_export",
] as const;

integration("PostgreSQL command repository command-kind parity", () => {
  beforeAll(async () => {
    await admin!.query(`create database ${quotedDatabase}`);
    const target = new URL(url!);
    target.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: target.toString() });
    for (const migration of fs
      .readdirSync("drizzle")
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort())
      await applyMigration(pool, `drizzle/${migration}`);
    repository = new PostgresMilestoneRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${quotedDatabase} with (force)`);
      await admin.end();
    }
  });

  it.each(commandKinds)(
    "executes, replays and conflicts %s with one activity and no duplicate queue",
    async (kind) => {
      let runId = "";
      let body: Record<string, unknown>;
      let expectedQueue = 0;
      const spies: Array<{ mockRestore(): void }> = [];

      if (kind === "create_run") {
        body = { handoff, warnings: [] };
        expectedQueue = 1;
      } else {
        runId = await seed(`pg-seed-${kind}`);
        body = { run_id: runId };
        if (kind === "resume_run") {
          body.options = {};
          expectedQueue = 1;
        } else if (kind === "submit_findings") {
          spies.push(
            vi.spyOn(repository, "submitDispositions").mockImplementation(async () => {
              await repository.enqueueRun(runId);
              return { completed: true, submitted: 1, continuation_required: true };
            }),
          );
          body.dispositions = {
            document_version_id: "document-1",
            idempotency_key: `domain-${kind}`,
            dispositions: [
              { finding_id: "00000000-0000-4000-8000-000000000001", decision: "accepted" },
            ],
          };
          expectedQueue = 1;
        } else if (kind === "authorise_exceptional_correction") {
          spies.push(
            vi.spyOn(repository, "authoriseExceptionalCorrection").mockImplementation(async () => {
              await repository.enqueueRun(runId);
              return "authorised";
            }),
          );
          body.explicit_confirmation = true;
          expectedQueue = 1;
        } else if (kind === "retry_export") {
          await pool!.query(
            `update runs set status='retryable_failed',current_step='final_coherence_export' where id=$1`,
            [runId],
          );
          await pool!.query(
            `insert into step_executions(run_id,step,attempt,status,error)
             values($1,'final_coherence_export',1,'retryable_failed','{"message":"STEP_1_12_FAILED;stage=google_docs_export;reason=test"}')`,
            [runId],
          );
          const artifact = await pool!.query<{ id: string }>(
            `insert into artifacts(run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
             select $1,id,'draft','application/json','{}','hash',2 from step_executions where run_id=$1 limit 1 returning id`,
            [runId],
          );
          const document = await pool!.query<{ id: string }>(
            `insert into document_versions(run_id,artifact_id,revision,content_hash) values($1,$2,1,'hash') returning id`,
            [runId, artifact.rows[0]!.id],
          );
          await pool!.query(
            `insert into export_operations(run_id,document_version_id,destination,idempotency_key,provider_idempotency_key,input_hash,status,last_error)
             values($1,$2,'google_docs',$3,$3,'hash','failed','safe failure')`,
            [runId, document.rows[0]!.id, `failed-${runId}`],
          );
          expectedQueue = 1;
        }
      }

      const key = `pg-command-${kind}-key`;
      const firstCommand = command(kind, key, body!);
      const first = await repository.submitCommand(firstCommand);
      runId = first.run_id;
      const replayDraft = {
        ...firstCommand,
        command_id: `${firstCommand.command_id}-replay`,
        requested_at: "2026-09-03T10:00:01Z",
      };
      const replay = await repository.submitCommand({
        ...replayDraft,
        payload_hash: commandPayloadHash(replayDraft as RunCommand),
      } as RunCommand);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(replay.result).toEqual(first.result);
      expect(await counts(runId, key)).toEqual({
        commands: 1,
        activity: 1,
        queue: expectedQueue,
      });

      const changed =
        kind === "create_run"
          ? command(
              kind,
              key,
              { handoff: { ...handoff, word_count_target: 901 }, warnings: [] },
              "changed",
            )
          : command(
              kind,
              key,
              { ...body!, run_id: "00000000-0000-4000-8000-000000000099" },
              "changed",
            );
      await expect(repository.submitCommand(changed)).rejects.toBeInstanceOf(
        RepositoryConflictError,
      );
      expect(await counts(runId, key)).toEqual({
        commands: 1,
        activity: 1,
        queue: expectedQueue,
      });
      spies.forEach((spy) => spy.mockRestore());
    },
    30_000,
  );

  it.each(commandKinds)("rolls back %s when domain mutation fails", async (kind) => {
    const invalid =
      kind === "create_run"
        ? command(kind, `pg-rollback-${kind}`, { handoff, warnings: [] })
        : command(kind, `pg-rollback-${kind}`, {
            run_id: "00000000-0000-4000-8000-000000000099",
            ...(kind === "resume_run" ? { options: {} } : {}),
            ...(kind === "submit_findings"
              ? {
                  dispositions: {
                    document_version_id: "missing",
                    idempotency_key: "missing-domain-key",
                    dispositions: [
                      { finding_id: "00000000-0000-4000-8000-000000000001", decision: "accepted" },
                    ],
                  },
                }
              : {}),
            ...(kind === "authorise_exceptional_correction" ? { explicit_confirmation: true } : {}),
          });
    const failure =
      kind === "create_run"
        ? vi.spyOn(repository, "createIngest").mockRejectedValue(new Error("fail"))
        : null;
    await expect(repository.submitCommand(invalid)).rejects.toThrow();
    expect(
      (
        await pool!.query(
          "select count(*)::int count from run_command_outbox where idempotency_key=$1",
          [invalid.idempotency_key],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool!.query(
          `select count(*)::int count from run_activity_events where command_id in
           (select command_id from run_command_outbox where idempotency_key=$1)`,
          [invalid.idempotency_key],
        )
      ).rows[0].count,
    ).toBe(0);
    failure?.mockRestore();
  });
});

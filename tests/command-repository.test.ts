import { describe, expect, it, vi } from "vitest";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import { RepositoryConflictError } from "../src/shared/errors.js";
import { RunCommandSchema, type RunCommand } from "../src/shared/commands.js";
import { commandPayloadHash } from "../src/shared/command-repository.js";

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

async function run(repository: InMemoryMilestoneRepository, key: string) {
  const created = await ingestHandoff(handoff, key, repository);
  repository.queueJobs.splice(0);
  return created.run_id;
}

async function assertReplayConflict(input: {
  repository: InMemoryMilestoneRepository;
  first: RunCommand;
  changed: RunCommand;
  expectedQueue: number;
}) {
  const first = await input.repository.submitCommand(input.first);
  const activityCount = input.repository.commandActivity.length;
  const queueCount = input.repository.queueJobs.length;
  const replayDraft = RunCommandSchema.parse({
    ...input.first,
    command_id: `${input.first.command_id}-replay`,
    requested_at: "2026-09-03T10:00:01Z",
  });
  const replay = await input.repository.submitCommand({
    ...replayDraft,
    payload_hash: commandPayloadHash(replayDraft),
  });
  expect(replay).toEqual({ ...first, replayed: true });
  expect(replay.result).toEqual(first.result);
  expect(input.repository.commandActivity).toHaveLength(activityCount);
  expect(input.repository.queueJobs).toHaveLength(queueCount);
  expect(queueCount).toBe(input.expectedQueue);
  await expect(input.repository.submitCommand(input.changed)).rejects.toBeInstanceOf(
    RepositoryConflictError,
  );
  expect(input.repository.commandActivity).toHaveLength(activityCount);
  expect(input.repository.queueJobs).toHaveLength(queueCount);
}

const cases = [
  "create_run",
  "resume_run",
  "submit_findings",
  "cancel_run",
  "authorise_exceptional_correction",
  "retry_export",
] as const;

describe("memory command repository command-kind parity", () => {
  it.each(cases)("executes, replays and conflicts %s without duplicate effects", async (kind) => {
    const repository = new InMemoryMilestoneRepository();
    let runId = "";
    let body: Record<string, unknown>;
    let expectedQueue = 0;

    if (kind === "create_run") {
      body = { handoff, warnings: [] };
      expectedQueue = 1;
    } else {
      runId = await run(repository, `seed-${kind}`);
      body = { run_id: runId };
      if (kind === "resume_run") {
        body.options = {};
        expectedQueue = 1;
      } else if (kind === "submit_findings") {
        vi.spyOn(repository, "submitDispositions").mockImplementation(async () => {
          await repository.enqueueRun(runId);
          return { completed: true, submitted: 1, continuation_required: true };
        });
        body.dispositions = {
          document_version_id: "document-1",
          idempotency_key: `domain-${kind}`,
          dispositions: [{ finding_id: "finding-1", decision: "accepted" }],
        };
        expectedQueue = 1;
      } else if (kind === "authorise_exceptional_correction") {
        vi.spyOn(repository, "authoriseExceptionalCorrection").mockResolvedValue("authorised");
        body.explicit_confirmation = true;
        expectedQueue = 1;
      } else if (kind === "retry_export") {
        const state = (repository as any).runs.get(runId);
        state.status = "retryable_failed";
        state.currentStep = "final_coherence_export";
        state.steps.push({
          id: "final-attempt",
          step: "final_coherence_export",
          status: "retryable_failed",
          attempt: 1,
          token: null,
          expiresAt: null,
          error: "STEP_1_12_FAILED;stage=google_docs_export;reason=test",
        });
        repository.exports.push({
          run_id: runId,
          document_version_id: state.draft?.version.id,
          external_url: "https://docs.google.local/failed",
          status: "failed",
        });
        expectedQueue = 1;
      }
    }

    const key = `command-${kind}-key`;
    const first = command(kind, key, body!);
    const changed =
      kind === "create_run"
        ? command(
            kind,
            key,
            { handoff: { ...handoff, word_count_target: 901 }, warnings: [] },
            "changed",
          )
        : command(kind, key, { ...body!, run_id: "run-changed" }, "changed");
    await assertReplayConflict({ repository, first, changed, expectedQueue });
    expect(repository.commands).toHaveLength(kind === "create_run" ? 2 : 1);
    expect(
      repository.commandActivity.filter((activity) => activity.type === "command_accepted"),
    ).toHaveLength(1);
  });

  it("does not enqueue or report acceptance for a domain-level exceptional replay", async () => {
    const repository = new InMemoryMilestoneRepository();
    const run = await repository.createIngest(
      "exceptional-replay-seed",
      "a".repeat(64),
      handoff,
      [],
    );
    repository.queueJobs.splice(0);
    vi.spyOn(repository, "authoriseExceptionalCorrection").mockResolvedValue("replay");
    const submitted = await repository.submitCommand(
      command("authorise_exceptional_correction", "exceptional-domain-replay", {
        run_id: run.run_id,
        explicit_confirmation: true,
      }),
    );
    expect(submitted).toMatchObject({
      queue_accepted: false,
      result: { outcome: "replay" },
    });
    expect(repository.queueJobs).toHaveLength(0);
  });

  it.each(cases)("rolls back %s when its domain mutation fails", async (kind) => {
    const repository = new InMemoryMilestoneRepository();
    const before = {
      commands: repository.commands.length,
      activity: repository.commandActivity.length,
      queue: repository.queueJobs.length,
    };
    const invalid =
      kind === "create_run"
        ? command(kind, `rollback-${kind}`, { handoff, warnings: [] })
        : command(kind, `rollback-${kind}`, {
            run_id: "missing-run",
            ...(kind === "resume_run" ? { options: {} } : {}),
            ...(kind === "submit_findings"
              ? {
                  dispositions: {
                    document_version_id: "missing",
                    idempotency_key: "missing-domain-key",
                    dispositions: [{ finding_id: "missing", decision: "accepted" }],
                  },
                }
              : {}),
            ...(kind === "authorise_exceptional_correction" ? { explicit_confirmation: true } : {}),
          });
    if (kind === "create_run")
      vi.spyOn(repository, "createIngest").mockRejectedValue(new Error("fail"));
    await expect(repository.submitCommand(invalid)).rejects.toThrow();
    expect(repository.commands).toHaveLength(before.commands);
    expect(repository.commandActivity).toHaveLength(before.activity);
    expect(repository.queueJobs).toHaveLength(before.queue);
  });
});

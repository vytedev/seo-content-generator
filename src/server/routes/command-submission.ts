import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandPayloadHash, type RunCommandRepository } from "../../shared/command-repository.js";
import { RunCommandSchema, type RunCommand } from "../../shared/commands.js";
import type { QueueOptions } from "../../shared/queue.js";

export const COMMAND_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function routeCommandKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key || !COMMAND_IDEMPOTENCY_KEY.test(key))
    throw new z.ZodError([
      {
        code: "custom",
        path: ["header", "Idempotency-Key"],
        message: "Idempotency-Key must be 8–128 safe characters.",
      },
    ]);
  return key;
}

export function buildRouteCommand(input: {
  kind: RunCommand["kind"];
  run_id?: string;
  idempotency_key: string;
  body?: Record<string, unknown>;
}): RunCommand {
  const identity = {
    kind: input.kind,
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.body ?? {}),
  };
  const draft = RunCommandSchema.parse({
    ...identity,
    command_id: randomUUID(),
    idempotency_key: input.idempotency_key,
    payload_hash: "0".repeat(64),
    requested_at: new Date().toISOString(),
  });
  return RunCommandSchema.parse({ ...draft, payload_hash: commandPayloadHash(draft) });
}

export function commandAcceptedBody(
  submission: Awaited<ReturnType<RunCommandRepository["submitCommand"]>>,
) {
  return {
    command_id: submission.command_id,
    run_id: submission.run_id,
    replayed: submission.replayed,
    queue_accepted: submission.queue_accepted,
    result: submission.result,
  };
}

export async function submitQueueRouteCommand(input: {
  repository: RunCommandRepository;
  kind: "resume_run" | "retry_export";
  run_id: string;
  idempotency_key: string;
  options?: QueueOptions;
}) {
  const queueOptions = input.options ?? {};
  const commandOptions = {
    ...(queueOptions.refresh_link_discovery ? { refresh_link_discovery: true } : {}),
    ...(queueOptions.authorise_legacy_draft_recovery
      ? { authorise_legacy_draft_recovery: true as const }
      : {}),
    ...(queueOptions.authorise_legacy_review_recovery
      ? { authorise_legacy_review_recovery: true as const }
      : {}),
  };
  const command = buildRouteCommand({
    kind: input.kind,
    run_id: input.run_id,
    idempotency_key: input.idempotency_key,
    ...(input.kind === "resume_run" ? { body: { options: commandOptions } } : {}),
  });
  return input.repository.submitCommand(command);
}

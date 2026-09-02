import { z } from "zod";
import {
  RunActivitySchema,
  RunCommandSchema,
  type RunActivity,
  type RunCommand,
} from "./commands.js";
import { canonicalHash } from "./milestone-two.js";

export const CommandSubmissionResultSchema = z
  .object({
    command_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    replayed: z.boolean(),
    queue_accepted: z.boolean(),
    result: z.unknown(),
  })
  .strict();
export type CommandSubmissionResult = z.infer<typeof CommandSubmissionResultSchema>;

export function commandPayloadIdentity(value: RunCommand) {
  const {
    command_id: _command,
    requested_at: _requested,
    payload_hash: _hash,
    ...identity
  } = value;
  return identity;
}

export function commandPayloadHash(value: RunCommand): string {
  return canonicalHash(commandPayloadIdentity(value));
}

export interface RunCommandRepository {
  /** Atomically applies domain state, one existing queue action where applicable, command and activity. */
  submitCommand(command: RunCommand): Promise<CommandSubmissionResult>;
  findCommand?(idempotencyKey: string): Promise<RunCommand | null>;
  configureEditorialCorrection?(handler: (runId: string) => Promise<unknown>): void;
  listCommandActivity(runId: string): Promise<RunActivity[]>;
}

export function parseRunCommand(command: unknown): RunCommand {
  return RunCommandSchema.parse(command);
}

export function parseCommandActivity(activity: unknown): RunActivity {
  return RunActivitySchema.parse(activity);
}

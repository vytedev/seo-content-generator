import { z } from "zod";

/** Explicit composition boundary. Production must never fall back to test doubles. */
export const RuntimeModeSchema = z.enum(["local", "test", "production"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export function permitsTestDoubles(mode: RuntimeMode): boolean {
  return mode === "local" || mode === "test";
}

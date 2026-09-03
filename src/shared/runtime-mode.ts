import { z } from "zod";

/** Explicit composition boundary. Production must never fall back to test doubles. */
export const RuntimeModeSchema = z.enum(["local", "test", "production"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export function permitsTestDoubles(mode: RuntimeMode): boolean {
  return mode === "local" || mode === "test";
}

export const RuntimeStateSchema = z
  .object({
    mode: RuntimeModeSchema,
    test_doubles: z.boolean(),
    label: z.string().min(1),
  })
  .strict();
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export function runtimeState(mode: RuntimeMode): RuntimeState {
  return RuntimeStateSchema.parse({
    mode,
    test_doubles: permitsTestDoubles(mode),
    label:
      mode === "production"
        ? "Production"
        : mode === "test"
          ? "Test · simulated services"
          : "Local · simulated services permitted",
  });
}

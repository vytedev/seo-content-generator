import { z } from "zod";

const passwordHashSchema = z
  .string()
  .regex(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);

const authEnvironmentSchema = z.object({
  OPERATOR_EMAIL: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  OPERATOR_PASSWORD_HASH: passwordHashSchema,
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30),
});

export type AuthConfig = z.infer<typeof authEnvironmentSchema>;

export function authConfigFromEnv(environment: NodeJS.ProcessEnv): AuthConfig | undefined {
  const names = [
    "OPERATOR_EMAIL",
    "OPERATOR_PASSWORD_HASH",
    "SESSION_SECRET",
    "SESSION_TTL_HOURS",
  ] as const;
  const values = Object.fromEntries(names.map((name) => [name, environment[name]]));
  if (names.every((name) => environment[name] === undefined || environment[name] === "")) {
    return undefined;
  }
  const result = authEnvironmentSchema.safeParse(values);
  if (!result.success) {
    throw new Error("Operator authentication configuration is incomplete or invalid");
  }
  return result.data;
}

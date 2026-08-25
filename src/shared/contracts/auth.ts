import { z } from "zod";

export const OperatorSchema = z
  .object({
    id: z.literal("local-operator"),
    display_name: z.string().trim().min(1),
    email: z.string().email(),
    account_type: z.literal("Local operator"),
  })
  .strict();

export const AuthSessionSchema = z
  .object({
    authenticated: z.literal(true),
    operator: OperatorSchema,
    csrf_token: z.string().min(32),
    expires_at: z.string().datetime(),
  })
  .strict();

export type Operator = z.infer<typeof OperatorSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;

import { z } from "zod";
import { apiFetch } from "./api.js";

export const GoogleConnectionStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  docs_connected: z.boolean(),
  gsc_connected: z.boolean(),
  connected_at: z.string().datetime().nullable(),
});
export type GoogleConnectionStatus = z.infer<typeof GoogleConnectionStatusSchema>;

export async function fetchGoogleConnectionStatus(): Promise<GoogleConnectionStatus> {
  const response = await apiFetch("/api/integrations/google/status");
  const body: unknown = await response.json();
  if (!response.ok) throw new Error("Google connection status could not be loaded.");
  return GoogleConnectionStatusSchema.parse(body);
}

export async function disconnectGoogle(): Promise<void> {
  const response = await apiFetch("/api/integrations/google", { method: "DELETE" });
  if (!response.ok) throw new Error("Google could not be disconnected.");
}

import { z } from "zod";
import { SerpCompositionSchema, type SerpComposition } from "../../shared/ingest-contracts.js";
import type { Handoff } from "../../shared/pipeline.js";
import { readBoundedResponseBody } from "./http-response.js";

const configSchema = z
  .object({
    enabled: z.literal("true"),
    endpoint: z.string().url(),
    token: z.string().trim().min(1),
    provider: z.string().trim().min(1).max(80).default("configured-serp"),
    timeout_ms: z.coerce.number().int().min(100).max(10_000).default(3_000),
    max_response_bytes: z.coerce.number().int().min(1_024).max(262_144).default(32_768),
  })
  .strict();

export type SerpProbeConfig = z.infer<typeof configSchema>;

export function serpProbeConfigFromEnv(env: NodeJS.ProcessEnv): SerpProbeConfig | null {
  const enabled = env.SERP_PROBE_ENABLED?.trim().toLowerCase();
  if (enabled === undefined || enabled === "" || enabled === "false") return null;
  if (enabled !== "true")
    throw new Error("SERP_PROBE_ENABLED must be exactly 'true' or 'false' when set.");
  return configSchema.parse({
    enabled: env.SERP_PROBE_ENABLED,
    endpoint: env.SERP_PROBE_ENDPOINT,
    token: env.SERP_PROBE_TOKEN,
    provider: env.SERP_PROBE_PROVIDER || undefined,
    timeout_ms: env.SERP_PROBE_TIMEOUT_MS || undefined,
    max_response_bytes: env.SERP_PROBE_MAX_RESPONSE_BYTES || undefined,
  });
}

export interface SerpProbe {
  readonly provider: string;
  inspect(handoff: Handoff): Promise<SerpComposition | null>;
}

/** Bounded server-only adapter. It performs one request and never retries. */
export class ConfiguredSerpProbe implements SerpProbe {
  readonly provider: string;
  constructor(
    private readonly config: SerpProbeConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.provider = config.provider;
  }

  async inspect(handoff: Handoff): Promise<SerpComposition | null> {
    const response = await this.fetcher(this.config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: handoff.primary_keyword }),
      signal: AbortSignal.timeout(this.config.timeout_ms),
    });
    if (!response.ok) throw new Error("SERP provider request failed");
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      throw new Error("SERP provider returned an unsupported content type");
    const text = await readBoundedResponseBody(response, this.config.max_response_bytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error("SERP provider returned malformed JSON");
    }
    const body = z
      .object({ composition: SerpCompositionSchema.nullable() })
      .strict()
      .parse(decoded);
    return body.composition;
  }
}

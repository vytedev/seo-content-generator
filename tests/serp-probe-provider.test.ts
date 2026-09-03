import { describe, expect, it, vi } from "vitest";
import {
  ConfiguredSerpProbe,
  serpProbeConfigFromEnv,
  type SerpProbeConfig,
} from "../src/server/providers/serp-probe.js";

const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "modern chairs",
  related_keywords: [],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};

const config: SerpProbeConfig = {
  enabled: "true",
  endpoint: "https://serp.test/probe",
  token: "test-token",
  provider: "test-serp",
  timeout_ms: 1000,
  max_response_bytes: 1024,
};

describe("configured SERP probe", () => {
  it("is optional unless explicitly enabled, then fails closed on malformed config", () => {
    expect(serpProbeConfigFromEnv({})).toBeNull();
    expect(serpProbeConfigFromEnv({ SERP_PROBE_ENABLED: "false" })).toBeNull();
    expect(() => serpProbeConfigFromEnv({ SERP_PROBE_ENABLED: "sometimes" })).toThrow(
      "must be exactly 'true' or 'false'",
    );
    expect(() => serpProbeConfigFromEnv({ SERP_PROBE_ENABLED: "true" })).toThrow();
  });

  it("rejects a streamed response exceeding the strict byte cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(700)));
        controller.enqueue(new TextEncoder().encode("x".repeat(700)));
        controller.close();
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      new ConfiguredSerpProbe(config, fetcher as typeof fetch).inspect(handoff),
    ).rejects.toThrow(/exceeded the configured limit/);
  });

  it.each([
    ["malformed JSON", "application/json", "{"],
    ["unsupported content", "text/html", "{}"],
  ])("rejects %s before schema parsing", async (_label, contentType, body) => {
    const fetcher = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );
    await expect(
      new ConfiguredSerpProbe(config, fetcher as typeof fetch).inspect(handoff),
    ).rejects.toThrow();
  });
});

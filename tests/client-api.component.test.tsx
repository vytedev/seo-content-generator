import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/client/lib/api.js";
import { reportClientFailure } from "../src/client/lib/diagnostics.js";
import { parseIngestResponse } from "../src/client/lib/ingest-api.js";
import { parseRunCommandResponse, resumeRequest } from "../src/client/lib/run-detail-api.js";

describe("durable command response parsing", () => {
  const envelope = {
    command_id: "command-1",
    run_id: "run-1",
    replayed: false,
    queue_accepted: true,
  };
  const ingestEnvelope = {
    ...envelope,
    result: {
      run_id: "run-1",
      input_hash: "a".repeat(64),
      handoff: {
        plane_ticket: "MOB-123",
        primary_keyword: "chairs",
        related_keywords: ["seating"],
        page_type: "blog" as const,
        word_count_target: 900,
        locales_for_translation: [],
      },
      warnings: [{ code: "serp_probe_failed" as const, message: "Probe failed safely." }],
    },
  };

  it("accepts only the exact 202 ingest envelope and parses its prepared result", () => {
    expect(parseIngestResponse(ingestEnvelope, 202)).toEqual(ingestEnvelope);
    expect(() => parseIngestResponse({ ...ingestEnvelope, unexpected: true }, 202)).toThrow();
    expect(() => parseIngestResponse(ingestEnvelope, 200)).toThrow();
    expect(() =>
      parseIngestResponse(
        { ...ingestEnvelope, result: { ...ingestEnvelope.result, run_id: "another-run" } },
        202,
      ),
    ).toThrow("did not match the prepared blog post");
  });

  it("checks run command identity and carries the retry key on resume", () => {
    expect(parseRunCommandResponse(envelope, 202, "run-1", "Failed")).toEqual(envelope);
    expect(() => parseRunCommandResponse(envelope, 202, "another-run", "Failed")).toThrow(
      "did not match this blog post",
    );
    expect(resumeRequest("draft", "legacy_confirmation_required", "stable-key")).toEqual({
      method: "POST",
      headers: { "Idempotency-Key": "stable-key", "Content-Type": "application/json" },
      body: JSON.stringify({ authorise_legacy_draft_recovery: true }),
    });
  });
});

describe("development API diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is quiet when production mode disables client diagnostics", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportClientFailure(
      "pipeline.request.failed",
      { category: "server", reason_code: "server_error", http_status: 500 },
      false,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("reports one deduplicated safe diagnostic without response content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("private response", {
          status: 503,
          headers: { "X-Request-ID": "request_12345678" },
        }),
      ),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = "/api/runs/123e4567-e89b-12d3-a456-426614174000/resume?private=yes";
    await apiFetch(path);
    await apiFetch(path);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]).toEqual([
      "pipeline.request.failed",
      {
        request_id: "request_12345678",
        run_id: "123e4567-e89b-12d3-a456-426614174000",
        category: "server",
        reason_code: "server_error",
        http_status: 503,
      },
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/private response|private=yes|path|event/);
  });
});

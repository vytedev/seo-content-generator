import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/client/lib/api.js";
import { reportClientFailure } from "../src/client/lib/diagnostics.js";

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

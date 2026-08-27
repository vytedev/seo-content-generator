import { describe, expect, it, vi } from "vitest";
import { classifyError, logger, normalizeLogEvent, safeLogFields } from "../src/server/logger.js";

describe("safe structured logger", () => {
  it("normalises events and drops unsafe, nested and unbounded fields", () => {
    expect(normalizeLogEvent(" Provider Dispatch! Started ")).toBe("provider_dispatch_started");
    expect(
      safeLogFields({
        run_id: "run-12345678",
        status: 500,
        connected: false,
        message: "secret provider prose",
        stack: "secret stack",
        headers: { authorization: "Bearer secret" },
        arbitrary: "not allowlisted",
        model: "x".repeat(200),
      }),
    ).toEqual({
      run_id: "run-12345678",
      status: 500,
      connected: false,
      model: "x".repeat(160),
    });
  });

  it("emits one bounded JSON line without raw error details", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.error("Unsafe Event\nInjected", {
      operation_id: "operation-12345678",
      message: "token=secret",
      stack: "at private/path",
      response_body: "private content",
      ...classifyError(Object.assign(new Error("private failure"), { code: "ECONNRESET" })),
    });
    expect(write).toHaveBeenCalledOnce();
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      event: "unsafe_event_injected",
      operation_id: "operation-12345678",
      category: "connection_failure",
      code: "ECONNRESET",
    });
    expect(line).not.toMatch(/private|secret|stack|message|response_body/);
    write.mockRestore();
  });

  it("uses the fail-closed unknown classification and no wildcard field allowance", () => {
    expect(classifyError("private prose")).toEqual({
      category: "internal",
      reason_code: "internal_error",
    });
    expect(
      safeLogFields({
        invented_id: "must-not-survive",
        error: "raw secret",
        run_id: "run-12345678",
        reason_code: "internal_error",
      }),
    ).toEqual({ run_id: "run-12345678", reason_code: "internal_error" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { closeHttpServerWithin, closePoolWithin, shutdownWithin } from "../src/server/shutdown.js";

describe("bounded HTTP shutdown", () => {
  it("reports a normal close before the deadline", async () => {
    const server = { close: vi.fn((callback: () => void) => callback()) };
    await expect(closeHttpServerWithin(server as never, 100)).resolves.toBe("closed");
  });

  it("forces lingering connections at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const server = {
        close: vi.fn(),
        closeAllConnections: vi.fn(),
      };
      const closing = closeHttpServerWithin(server as never, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(closing).resolves.toBe("forced");
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-resolving pool end without leaking its deadline timer", async () => {
    vi.useFakeTimers();
    try {
      const stream = { unref: vi.fn() };
      const pool = {
        end: vi.fn(() => new Promise<void>(() => undefined)),
        _clients: [{ connection: { stream } }],
      };
      const closing = closePoolWithin(pool, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(closing).resolves.toBe("deadline_exceeded");
      expect(stream.unref).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one overall deadline across HTTP, worker, and pool closure", async () => {
    vi.useFakeTimers();
    try {
      const server = { close: vi.fn((callback: () => void) => callback()) };
      const closeServices = vi.fn(() => new Promise<void>(() => undefined));
      const closing = shutdownWithin(server as never, closeServices, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toBe("deadline_exceeded");
      expect(closeServices).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

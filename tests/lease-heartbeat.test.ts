import { describe, expect, it, vi } from "vitest";
import { LeaseHeartbeat, withHeartbeat } from "../src/server/pipeline/lease-heartbeat.js";

type Timer = ReturnType<typeof setInterval>;

function manualSchedule(onSet: (t: Timer) => void) {
  return (callback: () => void, _ms: number): Timer => {
    const timer = { fire: callback } as unknown as Timer;
    onSet(timer);
    return timer;
  };
}

function heartbeatStep(behaviour: () => boolean | Promise<boolean>) {
  return vi.fn(behaviour) as unknown as {
    (executionId: string, token: string): Promise<boolean>;
    mock: { calls: unknown[][] };
  };
}

describe("LeaseHeartbeat", () => {
  it("renews the lease on each interval tick and stops cleanly", async () => {
    let tick: (() => void) | undefined;
    const renew = heartbeatStep(() => true);
    const lease = { execution_id: "exec-1", token: "tok-1" };
    const heartbeat = new LeaseHeartbeat(
      { heartbeatStep: renew },
      lease,
      1_000,
      manualSchedule((t) => {
        tick = (t as unknown as { fire: () => void }).fire;
      }),
    );
    heartbeat.start();
    tick!();
    await Promise.resolve();
    tick!();
    await Promise.resolve();
    heartbeat.stop();
    tick!();
    await Promise.resolve();
    expect(renew.mock.calls.length).toBe(2);
    expect(renew.mock.calls[0]).toEqual(["exec-1", "tok-1"]);
  });

  it("stops renewing when the fencing token is rejected", async () => {
    let tick: (() => void) | undefined;
    const renew = heartbeatStep(() => false);
    const heartbeat = new LeaseHeartbeat(
      { heartbeatStep: renew },
      { execution_id: "e", token: "t" },
      1_000,
      manualSchedule((t) => {
        tick = (t as unknown as { fire: () => void }).fire;
      }),
    );
    heartbeat.start();
    tick!();
    await Promise.resolve();
    tick!();
    await Promise.resolve();
    expect(renew.mock.calls.length).toBe(1);
  });

  it("stops after three consecutive renewal errors", async () => {
    let tick: (() => void) | undefined;
    const renew = heartbeatStep(() => {
      throw new Error("db down");
    });
    const heartbeat = new LeaseHeartbeat(
      { heartbeatStep: renew },
      { execution_id: "e", token: "t" },
      1_000,
      manualSchedule((t) => {
        tick = (t as unknown as { fire: () => void }).fire;
      }),
    );
    heartbeat.start();
    for (let i = 0; i < 5; i++) {
      tick!();
      await Promise.resolve();
    }
    expect(renew.mock.calls.length).toBe(3);
  });

  it("withHeartbeat clears the interval even when the operation throws", async () => {
    const renew = heartbeatStep(() => true);
    const stopSpy = vi.spyOn(LeaseHeartbeat.prototype, "stop");
    await expect(
      withHeartbeat(
        { heartbeatStep: renew },
        { execution_id: "e", token: "t" },
        () => Promise.reject(new Error("model failed")),
        1_000,
      ),
    ).rejects.toThrow("model failed");
    expect(stopSpy).toHaveBeenCalled();
    expect(renew.mock.calls.length).toBe(0);
  });
});

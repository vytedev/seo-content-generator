/**
 * Renewed fencing for long model operations.
 *
 * Model provider calls (1.3 draft, 1.5–1.8 reviews, 1.10 revision, 1.12
 * coherence) can legitimately run for minutes: up to three 60-second HTTP
 * attempts plus backoff plus one corrective re-request. Step leases must be
 * renewed while such work is genuinely in flight, or the lease expires under a
 * live call and the step becomes a zombie (documented blocker: "durable
 * worker/heartbeat semantics before broad real-model testing").
 *
 * Safety properties:
 * - Renewal is fenced: the repository only extends the lease when the fencing
 *   token still matches and the lease has not already expired.
 * - If any renewal fails, the heartbeat stops. The lease then expires on its
 *   own and later fenced writes are rejected — the step fails safely instead
 *   of zombie-running.
 * - The interval timer never keeps the process alive (unref) and is always
 *   cleared by the orchestrator's finally block.
 */

export interface HeartbeatRepository {
  heartbeatStep(executionId: string, token: string): Promise<boolean>;
}

export interface Lease {
  readonly execution_id: string;
  readonly token: string;
}

/** Default: renew every 90s against a 5-minute lease — three chances per lease. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 90_000;

export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;

  constructor(
    private readonly repository: HeartbeatRepository,
    private readonly lease: Lease,
    private readonly intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
    /** Injectable for tests. */
    private readonly schedule: (
      callback: () => void,
      ms: number,
    ) => ReturnType<typeof setInterval> = (callback, ms) => {
      const timer = setInterval(callback, ms);
      timer.unref?.();
      return timer;
    },
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
      throw new Error("Heartbeat interval must be a positive integer");
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Renewal attempts tolerated to fail silently a bounded number of times. */
  private async tick(): Promise<void> {
    // A cleared interval never fires; honour the same semantics for safety.
    if (!this.timer) return;
    try {
      const renewed = await this.repository.heartbeatStep(
        this.lease.execution_id,
        this.lease.token,
      );
      if (!renewed) {
        // Fencing token rejected: the step is no longer ours. Stop renewing;
        // the orchestrator's fenced persistence will fail safely.
        this.stop();
        return;
      }
      this.failures = 0;
    } catch {
      this.failures += 1;
      // A couple of transient DB errors are tolerated; after that stop
      // renewing so the lease expires rather than pretending liveness.
      if (this.failures >= 3) this.stop();
    }
  }
}

/** Runs an operation under a renewed lease: heartbeat wraps long model calls. */
export async function withHeartbeat<T>(
  repository: HeartbeatRepository,
  lease: Lease,
  operation: () => Promise<T>,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  const heartbeat = new LeaseHeartbeat(repository, lease, intervalMs);
  heartbeat.start();
  try {
    return await operation();
  } finally {
    heartbeat.stop();
  }
}

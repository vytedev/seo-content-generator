import type { Server } from "node:http";

export type ShutdownResult = "closed" | "deadline_exceeded";

function validDeadline(deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0)
    throw new Error("Shutdown deadline must be a non-negative integer");
}

export async function settleWithin(
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<ShutdownResult> {
  validDeadline(deadlineMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => "closed" as const),
      new Promise<"deadline_exceeded">((resolve) => {
        timer = setTimeout(() => resolve("deadline_exceeded"), deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeHttpServerWithin(
  server: Pick<Server, "close"> & Partial<Pick<Server, "closeAllConnections">>,
  deadlineMs: number,
): Promise<"closed" | "forced"> {
  validDeadline(deadlineMs);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "closed" | "forced") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish("forced");
    }, deadlineMs);
    timer.unref?.();
    server.close(() => finish("closed"));
  });
}

export async function closePoolWithin(
  pool: {
    end(): Promise<unknown>;
    _clients?: Array<{ connection?: { stream?: { unref?: () => void } } }>;
  },
  deadlineMs: number,
): Promise<ShutdownResult> {
  const result = await settleWithin(pool.end(), deadlineMs);
  if (result === "deadline_exceeded") {
    // Do not destroy checked-out DB work. Removing socket ownership lets shutdown finish while
    // the durable lease remains intact and expires for a later supervised recovery.
    for (const client of pool._clients ?? []) client.connection?.stream?.unref?.();
  }
  return result;
}

export async function shutdownWithin(
  server: Parameters<typeof closeHttpServerWithin>[0],
  closeServices: (remainingMs: number) => Promise<unknown>,
  deadlineMs: number,
): Promise<ShutdownResult> {
  validDeadline(deadlineMs);
  const expiresAt = Date.now() + deadlineMs;
  await closeHttpServerWithin(server, Math.max(0, expiresAt - Date.now()));
  if (Date.now() >= expiresAt) return "deadline_exceeded";
  return settleWithin(
    closeServices(Math.max(0, expiresAt - Date.now())),
    Math.max(0, expiresAt - Date.now()),
  );
}

import { writeFile, unlink } from "node:fs/promises";
import pg from "pg";
import { z } from "zod";
import { createLocalServices } from "./app/local-services.js";
import { classifyError, logger } from "./logger.js";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    ALLOW_NON_LOCAL_DATABASE: z.enum(["true", "false"]).default("false"),
    RUNTIME_MODE: z.enum(["local", "test", "production"]).default("production"),
    MIGRATION_POLICY: z.literal("verify-only").default("verify-only"),
    WORKER_PID_FILE: z.string().min(1).default("/tmp/mm03-worker.pid"),
  })
  .parse(process.env);

let stopping = false;
let services: ReturnType<typeof createLocalServices>;
await writeFile(config.WORKER_PID_FILE, `${process.pid}\n`, { mode: 0o600 });
const removePidFile = () => unlink(config.WORKER_PID_FILE).catch(() => undefined);
const terminateForWorkerFailure = (error: unknown) => {
  if (stopping) return;
  stopping = true;
  logger.error("worker.process_failed", classifyError(error));
  // The queue lease must expire naturally; do not report a live process after its loop dies.
  void services
    .close(10_000)
    .catch((closeError) =>
      logger.error("worker.process_failure_shutdown_failed", classifyError(closeError)),
    )
    .finally(async () => {
      await removePidFile();
      process.exit(1);
    });
};

services = createLocalServices({
  databaseUrl: config.DATABASE_URL,
  allowNonLocalDatabase: config.ALLOW_NON_LOCAL_DATABASE === "true",
  runtimeMode: config.RUNTIME_MODE,
  migrationPolicy: config.MIGRATION_POLICY,
  processRole: "worker",
  onWorkerFailure: terminateForWorkerFailure,
});
await services.ready;
const heartbeatPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
const heartbeat = async () => {
  await heartbeatPool.query(
    `insert into worker_heartbeats(worker_name,heartbeat_at) values('pipeline',clock_timestamp())
     on conflict(worker_name) do update set heartbeat_at=excluded.heartbeat_at`,
  );
};
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch(terminateForWorkerFailure), 5_000);
logger.info("worker.process_started", { runtime_mode: config.RUNTIME_MODE });

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    void heartbeatPool
      .end()
      .then(() => services.close(10_000))
      .then(async (result) => {
        await removePidFile();
        process.exit(result === "closed" ? 0 : 1);
      })
      .catch((error) => {
        logger.error("worker.process_shutdown_failed", classifyError(error));
        void removePidFile().finally(() => process.exit(1));
      });
  });

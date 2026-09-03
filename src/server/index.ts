import { z } from "zod";
import { LOCAL_API_PORT } from "../shared/local-runtime.js";
import { createLocalApp } from "./app/local-services.js";
import { shutdownWithin } from "./shutdown.js";
import { classifyError, logger } from "./logger.js";

const runtimeConfig = z
  .object({
    HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(LOCAL_API_PORT),
    ALLOW_NON_LOCAL_DATABASE: z.enum(["true", "false"]).default("false"),
    RUNTIME_MODE: z.enum(["local", "test", "production"]).default("local"),
    MIGRATION_POLICY: z.enum(["verify-only", "on-startup"]).default("verify-only"),
    PROCESS_ROLE: z.enum(["combined", "api"]).default("combined"),
  })
  .parse(process.env);

if (runtimeConfig.RUNTIME_MODE === "production" && runtimeConfig.HOST !== "0.0.0.0")
  throw new Error("Production must bind the service interface, not a loopback host.");
if (runtimeConfig.RUNTIME_MODE !== "production" && runtimeConfig.HOST === "0.0.0.0")
  throw new Error("Local/test runtime must bind loopback only.");

const port = runtimeConfig.PORT;
const databaseUrl = process.env.DATABASE_URL;
const { app, ready, close } = createLocalApp(
  databaseUrl
    ? {
        databaseUrl,
        allowNonLocalDatabase: runtimeConfig.ALLOW_NON_LOCAL_DATABASE === "true",
        runtimeMode: runtimeConfig.RUNTIME_MODE,
        migrationPolicy: runtimeConfig.MIGRATION_POLICY,
        processRole: runtimeConfig.PROCESS_ROLE,
      }
    : {
        runtimeMode: runtimeConfig.RUNTIME_MODE,
        migrationPolicy: runtimeConfig.MIGRATION_POLICY,
        processRole: runtimeConfig.PROCESS_ROLE,
      },
);

await ready;
const server = app.listen(port, runtimeConfig.HOST, () => {
  logger.info("server.started", {
    host: runtimeConfig.HOST,
    port,
    pipeline_configured: Boolean(databaseUrl),
    database_configured: Boolean(databaseUrl),
    runtime_mode: runtimeConfig.RUNTIME_MODE,
    process_role: runtimeConfig.PROCESS_ROLE,
  });
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown_started", { reason: signal });
    void shutdownWithin(server, close, 10_000)
      .then((result) => {
        if (result === "closed") logger.info("server.shutdown_completed", { outcome: result });
        else logger.warn("server.shutdown_deadline_exceeded", { outcome: result });
        process.exitCode = result === "closed" ? 0 : 1;
      })
      .catch((error: unknown) => {
        logger.error("server.shutdown_failed", classifyError(error));
        process.exitCode = 1;
      });
  });
}

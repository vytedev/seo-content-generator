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
  })
  .parse(process.env);

const port = runtimeConfig.PORT;
const databaseUrl = process.env.DATABASE_URL;
const { app, ready, close } = createLocalApp(
  databaseUrl
    ? {
        databaseUrl,
        allowNonLocalDatabase: runtimeConfig.ALLOW_NON_LOCAL_DATABASE === "true",
      }
    : {},
);

await ready;
const server = app.listen(port, runtimeConfig.HOST, () => {
  logger.info("server.started", {
    host: runtimeConfig.HOST,
    port,
    pipeline_configured: Boolean(databaseUrl),
    database_configured: Boolean(databaseUrl),
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

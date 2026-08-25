import { createLocalApp } from "./app/local-services.js";
import { z } from "zod";

const runtimeConfig = z
  .object({
    HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    ALLOW_NON_LOCAL_DATABASE: z.enum(["true", "false"]).default("false"),
  })
  .parse(process.env);

const port = runtimeConfig.PORT;
const databaseUrl = process.env.DATABASE_URL;
const { app, close } = createLocalApp(
  databaseUrl
    ? {
        databaseUrl,
        allowNonLocalDatabase: runtimeConfig.ALLOW_NON_LOCAL_DATABASE === "true",
      }
    : {},
);
const server = app.listen(port, runtimeConfig.HOST, () => {
  const pipeline = databaseUrl
    ? "PostgreSQL pipeline enabled"
    : "checker-only; pipeline not configured";
  console.log(`Backend/API: http://${runtimeConfig.HOST}:${port}`);
  console.log(`Health:      http://${runtimeConfig.HOST}:${port}/api/health`);
  console.log(`Database:    ${databaseUrl ? "PostgreSQL connected" : "not configured"}`);
  console.log(`Pipeline:    ${pipeline}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => void close().finally(() => process.exit(0)));
  });
}

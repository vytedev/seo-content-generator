import { createLocalApp } from "./app/local-services.js";

const port = 3100;
const databaseUrl = process.env.DATABASE_URL;
const { app, close } = createLocalApp(databaseUrl ? { databaseUrl } : {});
const server = app.listen(port, "127.0.0.1", () => {
  const pipeline = databaseUrl
    ? "PostgreSQL pipeline enabled"
    : "checker-only; pipeline not configured";
  console.log(`Backend/API: http://127.0.0.1:${port}`);
  console.log(`Health:      http://127.0.0.1:${port}/api/health`);
  console.log(`Database:    ${databaseUrl ? "PostgreSQL connected" : "not configured"}`);
  console.log(`Pipeline:    ${pipeline}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => void close().finally(() => process.exit(0)));
  });
}

import { defineConfig } from "drizzle-kit";

const studioUrl = process.env.DATABASE_URL;
if (!studioUrl) {
  throw new Error(
    "Drizzle Studio requires DATABASE_URL. Run via `npm run db:studio` so the local .env is loaded without printing its value.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // db:generate is offline and never uses dbCredentials; Studio (db:studio) injects
  // DATABASE_URL at runtime via --env-file-if-exists so the secret is never stored here.
  dbCredentials: { url: studioUrl },
  strict: true,
  verbose: true,
});

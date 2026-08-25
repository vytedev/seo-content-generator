import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [["tests/**/*.component.test.tsx", "jsdom"]],
    setupFiles: ["./tests/setup.ts"],
    // PostgreSQL integration files share the disposable database and truncate tables.
    fileParallelism: false,
    coverage: { enabled: false },
  },
});

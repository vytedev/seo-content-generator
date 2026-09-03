import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createLocalServices } from "../src/server/local-services.js";

const source = (path: string) => readFile(path, "utf8");

describe("production process topology", () => {
  it("defines migration-gated independent API and worker services", async () => {
    const compose = await source("docker-compose.yml");
    expect(compose).toContain("migrate:");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("PROCESS_ROLE: api");
    expect(compose).toContain('["npm", "run", "start:worker"]');
    expect(compose).toContain("/api/ready");
    expect(compose).toContain("app_network");
    expect(compose).toContain("name: caddy");
    expect(compose).toContain("healthcheck:worker");
    expect(compose).not.toContain("PROCESS_ROLE: combined");
  });

  it("defines a two-process fake-provider topology test with migration gating", async () => {
    const compose = await source("tests/compose/docker-compose.topology-test.yml");
    expect(compose).toContain("migrate-test:");
    expect(compose).toContain("service_completed_successfully");
    expect(compose).toContain("PROCESS_ROLE: api");
    expect(compose).toContain('"npm", "run", "start:worker"');
    expect(compose).toContain("RUNTIME_MODE: test");
    expect(compose).toContain("RUNTIME_MODE: local");
    expect(compose).toContain("/api/ready");
    expect(compose).toContain("healthcheck:worker");
  });

  it("keeps the production image non-root and ships migrations", async () => {
    const dockerfile = await source("Dockerfile");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("/app/drizzle ./drizzle");
  });

  it("forbids a combined production process before opening PostgreSQL", () => {
    expect(() =>
      createLocalServices({
        runtimeMode: "production",
        processRole: "combined",
        databaseUrl: "postgresql://user@postgres/database",
        allowNonLocalDatabase: true,
      }),
    ).toThrow("separate API and worker process roles");
  });
});

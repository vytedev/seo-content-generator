import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { permitsTestDoubles, runtimeState } from "../src/shared/runtime-mode.js";
import { databaseSchemaIsCurrent } from "../src/server/local-services.js";

describe("explicit runtime mode", () => {
  it("marks local and test compositions as simulated, never production", () => {
    expect(permitsTestDoubles("local")).toBe(true);
    expect(permitsTestDoubles("test")).toBe(true);
    expect(permitsTestDoubles("production")).toBe(false);
    expect(runtimeState("local").label).toContain("simulated services");
    expect(runtimeState("production")).toEqual({
      mode: "production",
      test_doubles: false,
      label: "Production",
    });
  });

  it("separates liveness from fail-closed readiness while preserving health", async () => {
    const app = createApp({
      serveClient: false,
      runtimeMode: "production",
      workerHealth: () => ({ status: "running" }),
      readiness: async () => ({
        ready: false,
        checks: {
          database: true,
          migrations: false,
          reconciliation: true,
          worker: true,
          configuration: true,
        },
      }),
    });
    await request(app).get("/api/live").expect(200, { status: "live" });
    await request(app)
      .get("/api/ready")
      .expect(503, {
        status: "not_ready",
        runtime: { mode: "production", test_doubles: false, label: "Production" },
        checks: {
          database: true,
          migrations: false,
          reconciliation: true,
          worker: true,
          configuration: true,
        },
      });
  });

  it("fails migration readiness closed for missing and stale schema markers", async () => {
    await expect(
      databaseSchemaIsCurrent({ query: async () => ({ rows: [{ version: 53 }] }) } as never),
    ).resolves.toBe(false);
    await expect(
      databaseSchemaIsCurrent({
        query: async () => Promise.reject(new Error("missing table")),
      } as never),
    ).resolves.toBe(false);
    await expect(
      databaseSchemaIsCurrent({ query: async () => ({ rows: [{ version: 55 }] }) } as never),
    ).resolves.toBe(true);
  });

  it("projects runtime state through health", async () => {
    const app = createApp({ serveClient: false, runtimeMode: "local" });
    await request(app)
      .get("/api/health")
      .expect(200, {
        status: "ok",
        runtime: {
          mode: "local",
          test_doubles: true,
          label: "Local · simulated services permitted",
        },
      });
  });
});

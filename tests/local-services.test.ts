import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLocalApp, createLocalServices } from "../src/server/local-services.js";

describe("local server composition", () => {
  it("keeps the checker available and safely reports unconfigured pipeline routes", async () => {
    const { app, close } = createLocalApp({ authMode: "disabled-test" });
    expect((await request(app).get("/api/health")).body).toMatchObject({
      status: "ok",
      runtime: { mode: "local", test_doubles: true },
    });
    expect((await request(app).get("/api/runs/example")).body).toMatchObject({
      error: { code: "LOCAL_DATABASE_NOT_CONFIGURED" },
    });
    expect((await request(app).get("/api/runs/example")).status).toBe(503);
    await close();
  });

  it("reports unconfigured local composition as live but not ready", async () => {
    const { app, close } = createLocalApp({ authMode: "disabled-test" });
    await request(app).get("/api/live").expect(200, { status: "live" });
    const readiness = await request(app).get("/api/ready").expect(503);
    expect(readiness.body.checks).toMatchObject({
      database: false,
      migrations: false,
      reconciliation: false,
      worker: false,
      configuration: true,
    });
    await close();
  });

  it("forbids migration-on-startup before composing dependencies", () => {
    expect(() =>
      createLocalServices({
        authMode: "disabled-test",
        runtimeMode: "test",
        migrationPolicy: "on-startup",
      }),
    ).toThrow("Migration-on-startup is forbidden");
  });

  it("fails closed without PostgreSQL in normal runtime composition", () => {
    expect(() => createLocalApp({})).toThrow("PostgreSQL is required for operator authentication");
  });

  it("fails closed when a database is configured without operator auth", () => {
    expect(() =>
      createLocalServices({ databaseUrl: "postgresql://localhost:5432/mm0301_test" }),
    ).toThrow("Operator authentication configuration is required");
  });

  it("rejects non-local PostgreSQL configuration before creating a pool", () => {
    expect(() =>
      createLocalServices({
        databaseUrl: "postgresql://user@example.com/database",
        authMode: "disabled-test",
      }),
    ).toThrow("requires loopback PostgreSQL");
  });

  it("rejects production loopback databases and missing non-local approval", () => {
    expect(() =>
      createLocalServices({
        databaseUrl: "postgresql://localhost:5432/mm0301",
        runtimeMode: "production",
        processRole: "worker",
      }),
    ).toThrow("Production forbids a loopback PostgreSQL database.");
    expect(() =>
      createLocalServices({
        databaseUrl: "postgresql://user@postgres/database",
        runtimeMode: "production",
        processRole: "worker",
      }),
    ).toThrow("Production requires explicit non-local database approval.");
    expect(() =>
      createLocalServices({
        databaseUrl: "postgresql://user@postgres/database",
        runtimeMode: "production",
        processRole: "api",
        allowNonLocalDatabase: true,
      }),
    ).toThrow("Operator authentication configuration is required");
  });

  it("ignores shared operator auth variables in worker composition", async () => {
    const prior = {
      email: process.env.OPERATOR_EMAIL,
      hash: process.env.OPERATOR_PASSWORD_HASH,
      secret: process.env.SESSION_SECRET,
      ttl: process.env.SESSION_TTL_HOURS,
    };
    process.env.OPERATOR_EMAIL = "invalid-shared-value";
    process.env.OPERATOR_PASSWORD_HASH = "invalid-shared-value";
    process.env.SESSION_SECRET = "invalid";
    process.env.SESSION_TTL_HOURS = "invalid";
    try {
      const services = createLocalServices({
        databaseUrl: "postgresql://127.0.0.1:1/unreachable",
        runtimeMode: "test",
        processRole: "worker",
      });
      await expect(services.ready).rejects.toBeDefined();
      await services.close();
    } finally {
      for (const [name, value] of Object.entries({
        OPERATOR_EMAIL: prior.email,
        OPERATOR_PASSWORD_HASH: prior.hash,
        SESSION_SECRET: prior.secret,
        SESSION_TTL_HOURS: prior.ttl,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("allows an explicitly configured non-loopback local/test database", async () => {
    const { close } = createLocalServices({
      databaseUrl: "postgresql://user@postgres/database",
      authMode: "disabled-test",
      allowNonLocalDatabase: true,
    });

    await close();
  });
});

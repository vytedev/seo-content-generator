import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLocalApp, createLocalServices } from "../src/server/local-services.js";

describe("local server composition", () => {
  it("keeps the checker available and safely reports unconfigured pipeline routes", async () => {
    const { app, close } = createLocalApp({ authMode: "disabled-test" });
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/runs/example")).body).toMatchObject({
      error: { code: "LOCAL_DATABASE_NOT_CONFIGURED" },
    });
    expect((await request(app).get("/api/runs/example")).status).toBe(503);
    await close();
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
    ).toThrow("must target local PostgreSQL");
  });
});

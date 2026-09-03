import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app/create-app.js";
import { permitsTestDoubles, runtimeState } from "../src/shared/runtime-mode.js";

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

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app/create-app.js";

describe("calibration API validation", () => {
  it("returns typed 422 for malformed identifiers and requests", async () => {
    const repository = {
      getRun: async () => {
        throw new Error("unused");
      },
      listRuns: async () => [],
      getResults: async () => [],
      getCombined: async () => {
        throw new Error("unused");
      },
      createReferenceVersions: async () => [],
    } as any;
    const service = { start: async () => ({}), resume: async () => ({}) } as any;
    const app = createApp({ serveClient: false, calibration: { repository, service } });
    expect((await request(app).get("/api/calibrations/not-a-uuid")).status).toBe(422);
    expect((await request(app).post("/api/calibrations").send({})).status).toBe(422);
  });
});

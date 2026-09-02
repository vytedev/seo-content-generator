import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  LOCAL_API_ORIGIN,
  LOCAL_API_PORT,
  LOCAL_AUTH_ALLOWED_ORIGINS,
  LOCAL_FRONTEND_ORIGIN,
  LOCAL_FRONTEND_PORT,
} from "../src/shared/local-runtime.js";

const root = new URL("../", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, root), "utf8");
}

describe("local runtime ports", () => {
  it("uses the conflict-free local API port and intended auth origins", () => {
    expect(LOCAL_API_PORT).toBe(3110);
    expect(LOCAL_FRONTEND_PORT).toBe(5173);
    expect(LOCAL_API_ORIGIN).toBe("http://127.0.0.1:3110");
    expect(LOCAL_FRONTEND_ORIGIN).toBe("http://127.0.0.1:5173");
    expect([...LOCAL_AUTH_ALLOWED_ORIGINS]).toEqual([
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3110",
    ]);
  });

  it("makes Vite use the shared local API origin", async () => {
    const config = await source("vite.config.ts");
    expect(config).toContain('proxy: { "/api": LOCAL_API_ORIGIN }');
    expect(config).not.toContain("127.0.0.1:3100");
  });

  it("keeps active local runtime configuration off port 3100", async () => {
    const files = await Promise.all(
      [
        "src/shared/local-runtime.ts",
        "src/server/index.ts",
        "src/server/auth/auth.ts",
        "src/server/app/create-app.ts",
        "src/server/app/local-services.ts",
        "vite.config.ts",
        ".env.example",
      ].map(async (path) => [path, await source(path)] as const),
    );
    for (const [path, content] of files) {
      expect(content, path).not.toContain("127.0.0.1:3100");
      expect(content, path).not.toMatch(/\b3100\b/);
    }
  });
});

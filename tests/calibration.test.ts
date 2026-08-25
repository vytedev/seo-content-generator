import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CALIBRATION_POSTS } from "../src/shared/contracts/calibration.js";
import {
  assertAllowedCalibrationUrl,
  nodeHttpsPinnedFetcher,
  parseCalibrationPage,
  SafePublicPageRetriever,
} from "../src/server/providers/public-page-retriever.js";

const html = fs.readFileSync("tests/fixtures/calibration/barcelona.html", "utf8");
describe("safe calibration retrieval", () => {
  it("requires exact allowlist and canonical", () => {
    expect(() =>
      assertAllowedCalibrationUrl("https://www.mobelaris.com/en/mobelarisblog/other"),
    ).toThrow("NOT_ALLOWED");
    expect(() =>
      parseCalibrationPage(
        CALIBRATION_POSTS[0].url,
        html.replace(CALIBRATION_POSTS[0].url, CALIBRATION_POSTS[1].url),
        new Date(),
      ),
    ).toThrow("CANONICAL_MISMATCH");
  });
  it("pins the default Node transport while preserving TLS and HTTP host identity", async () => {
    const request = vi.fn((options: any, callback: (response: any) => void) => {
      const req = new EventEmitter() as any;
      req.setTimeout = vi.fn();
      req.end = () => {
        const incoming = new PassThrough() as any;
        incoming.statusCode = 200;
        incoming.statusMessage = "OK";
        incoming.headers = { "content-type": "text/html" };
        callback(incoming);
        incoming.end("transport body");
      };
      return req;
    });
    const url = new URL(CALIBRATION_POSTS[0].url);
    const response = await nodeHttpsPinnedFetcher(
      { url, addresses: ["93.184.216.34"], signal: new AbortController().signal },
      request as any,
    );
    const options = request.mock.calls[0]![0] as any;
    expect(options.hostname).toBe("www.mobelaris.com");
    expect(options.servername).toBe("www.mobelaris.com");
    expect(options.headers.Host).toBe("www.mobelaris.com");
    const lookup = vi.fn();
    options.lookup("ignored", {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(response.url).toBe(url.href);
    expect(await response.text()).toBe("transport body");
  });
  it("rejects IPv4-mapped private IPv6 addresses before the connector", async () => {
    const fetcher = vi.fn();
    await expect(
      new SafePublicPageRetriever(fetcher, async () => [
        { address: "::ffff:127.0.0.1", family: 6 },
      ]).retrieve(CALIBRATION_POSTS[0].url),
    ).rejects.toThrow("ADDRESS_FORBIDDEN");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      new SafePublicPageRetriever(fetcher, async () => [
        { address: "::ffff:7f00:1", family: 6 },
      ]).retrieve(CALIBRATION_POSTS[0].url),
    ).rejects.toThrow("ADDRESS_FORBIDDEN");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes resolved addresses to the pinned connector and rejects redirects", async () => {
    const fetcher = vi.fn(async ({ addresses }: any) => {
      expect(addresses).toEqual(["93.184.216.34"]);
      return new Response(null, { status: 302, headers: { location: CALIBRATION_POSTS[0].url } });
    });
    await expect(
      new SafePublicPageRetriever(fetcher, async () => [
        { address: "93.184.216.34", family: 4 },
      ]).retrieve(CALIBRATION_POSTS[0].url),
    ).rejects.toThrow("REDIRECT_FORBIDDEN");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("supports Node all-address lookup requests in the pinned transport", async () => {
    const { nodeHttpsPinnedFetcher } =
      await import("../src/server/providers/public-page-retriever.js");
    const request = vi.fn((options: any) => {
      options.lookup("www.mobelaris.com", { all: true }, (error: unknown, records: unknown) => {
        expect(error).toBeNull();
        expect(records).toEqual([{ address: "93.184.216.34", family: 4 }]);
      });
      return {
        setTimeout: vi.fn(),
        once: vi.fn(),
        end: vi.fn(),
      };
    });
    const pending = nodeHttpsPinnedFetcher(
      {
        url: new URL(CALIBRATION_POSTS[0].url),
        addresses: ["93.184.216.34"],
        signal: new AbortController().signal,
      },
      request as never,
    );
    expect(request).toHaveBeenCalledOnce();
    void pending;
  });

  it("aborts a streamed body over the hard cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.enqueue(new Uint8Array(1));
      },
    });
    const response = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: CALIBRATION_POSTS[0].url });
    await expect(
      new SafePublicPageRetriever(
        async () => response,
        async () => [{ address: "93.184.216.34", family: 4 }],
      ).retrieve(CALIBRATION_POSTS[0].url),
    ).rejects.toThrow("BODY_TOO_LARGE");
  });
});

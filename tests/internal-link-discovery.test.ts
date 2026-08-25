import { describe, expect, it, vi } from "vitest";
import {
  GscSearchAnalyticsClient,
  LiveInternalLinkDiscoverer,
  NoNetworkLinkDiscoverer,
  PostgresLinkDiscoveryCache,
  SafeUrlVerifier,
  SitemapClient,
  isPrivateAddress,
  linkDiscoveryConfigFromEnv,
  linkDiscoveryConfigIdentity,
  mergeAndVerify,
  mergeAndVerifyDetailed,
  type LinkDiscoveryConfig,
} from "../src/server/providers/internal-link-discovery.js";
import type { GoogleOAuthClient } from "../src/server/providers/google-oauth.js";

const config: LinkDiscoveryConfig = {
  sitemapUrl: "https://www.example.com/sitemap.xml",
  siteOrigin: "https://www.example.com",
  gscSiteUrl: "https://www.example.com/",
  allowedOrigins: ["https://www.example.com", "https://searchconsole.googleapis.com"],
  cacheTtlMs: 86_400_000,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  maxSitemapUrls: 10_000,
};
const publicDns = async () => undefined;
const sitemapNamespace = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;
const now = () => new Date("2026-01-01T00:00:00.000Z");
const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/xml" } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function verifier() {
  return {
    verifyOutcome: vi.fn(async (url: string) => ({
      outcome: "direct_200" as const,
      method: "head" as const,
      verified_at: now().toISOString(),
      hierarchy: url.includes("/collections/") ? ("collection" as const) : ("product" as const),
    })),
  } as unknown as SafeUrlVerifier;
}

describe("sitemap internal-link discovery", () => {
  it("validates credential-free configuration and operational bounds", async () => {
    expect(linkDiscoveryConfigFromEnv({})).toBeUndefined();
    const env = {
      INTERNAL_LINK_SITEMAP_URL: config.sitemapUrl,
      INTERNAL_LINK_SITE_ORIGIN: config.siteOrigin,
      INTERNAL_LINK_ALLOWED_ORIGINS: config.allowedOrigins.join(","),
      INTERNAL_LINK_MAX_SITEMAP_URLS: "25",
    };
    expect(linkDiscoveryConfigFromEnv(env)).toMatchObject({
      maxSitemapUrls: 25,
      cacheTtlMs: 86_400_000,
    });
    expect(() =>
      linkDiscoveryConfigFromEnv({ ...env, INTERNAL_LINK_MAX_SITEMAP_URLS: "0" }),
    ).toThrow("INTERNAL_LINK_MAX_SITEMAP_URLS");
    expect(() =>
      linkDiscoveryConfigFromEnv({
        ...env,
        INTERNAL_LINK_SITEMAP_URL: "https://other.example/sitemap.xml",
      }),
    ).toThrow("exact origin");
    await expect(new NoNetworkLinkDiscoverer().discover()).resolves.toMatchObject({
      eligibility: "blocked",
      providerStatus: { sitemap: "not_configured" },
    });
  });

  it("changes cache identity for sitemap URL and bounds", () => {
    expect(
      linkDiscoveryConfigIdentity({ ...config, sitemapUrl: "https://www.example.com/other.xml" }),
    ).not.toBe(linkDiscoveryConfigIdentity(config));
    expect(linkDiscoveryConfigIdentity({ ...config, maxSitemapUrls: 9 })).not.toBe(
      linkDiscoveryConfigIdentity(config),
    );
  });

  it("reads a sitemap index and nested urlset, canonicalises and detects cycles", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sitemap.xml")
        return xml(
          `<sitemapindex ${sitemapNamespace}><sitemap><loc>https://www.example.com/products.xml</loc></sitemap><sitemap><loc>https://www.example.com/sitemap.xml</loc></sitemap></sitemapindex>`,
        );
      return xml(
        `<urlset ${sitemapNamespace}><url><loc>https://www.example.com/products/chair/</loc><lastmod>2025-12-01</lastmod></url><url><loc>https://www.example.com/products/chair</loc></url></urlset>`,
      );
    });
    await expect(new SitemapClient(config, fetchMock, publicDns).listUrls()).resolves.toEqual([
      {
        url: "https://www.example.com/products/chair",
        sitemapUrl: "https://www.example.com/products.xml",
        lastModified: "2025-12-01T00:00:00.000Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe, malformed, wrapped, multi-root and structurally invalid XML", async () => {
    for (const response of [
      xml(`<!DOCTYPE x [<!ENTITY y "boom">]><urlset/>`),
      xml(`<urlset><url><loc>https://evil.example/products/a</loc></url></urlset>`),
      xml("x".repeat(1025)),
      xml(`<urlset><url></urlset>`),
      xml(`<wrapper><urlset/></wrapper>`),
      xml(`<urlset/><urlset/>`),
      xml(`<urlset bad><url><loc>https://www.example.com/products/a</loc></url></urlset>`),
      xml(`<x:urlset><x:url><x:loc>https://www.example.com/products/a</x:loc></x:url></x:urlset>`),
      xml(
        `<urlset><wrapper><url><loc>https://www.example.com/products/a</loc></url></wrapper></urlset>`,
      ),
      xml(
        `<urlset><url><wrapper><loc>https://www.example.com/products/a</loc></wrapper></url></urlset>`,
      ),
      xml(`<urlset><url><loc>https://www.example.com/products/a&bogus;</loc></url></urlset>`),
      xml(`<urlset/>`, 302),
    ]) {
      const bounded = { ...config, maxResponseBytes: 1024 };
      await expect(
        new SitemapClient(
          bounded,
          vi.fn<typeof fetch>().mockResolvedValue(response),
          publicDns,
        ).listUrls(),
      ).rejects.toThrow();
    }
  });

  it("requires the standard namespace on root and every structural element", async () => {
    for (const body of [
      `<urlset><url><loc>https://www.example.com/products/chair</loc></url></urlset>`,
      `<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.example.com/products/chair</loc></url></urlset>`,
      `<urlset ${sitemapNamespace}><url xmlns="urn:wrong"><loc>https://www.example.com/products/chair</loc></url></urlset>`,
      `<urlset ${sitemapNamespace}><url><loc xmlns="urn:wrong">https://www.example.com/products/chair</loc></url></urlset>`,
    ]) {
      await expect(
        new SitemapClient(
          config,
          vi.fn<typeof fetch>().mockResolvedValue(xml(body)),
          publicDns,
        ).listUrls(),
        // A wrong-namespace loc is not a sitemap loc at all, so it surfaces as a
        // missing/ambiguous loc error; both rejections are fail-closed.
      ).rejects.toThrow(/namespace|requires exactly one direct loc/);
    }
  });

  it("allows standard sitemap namespaces and escaped direct locations", async () => {
    await expect(
      new SitemapClient(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            xml(
              `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.example.com/products/chair?x=1&amp;y=2</loc></url></urlset>`,
            ),
          ),
        publicDns,
      ).listUrls(),
    ).resolves.toEqual([
      expect.objectContaining({ url: "https://www.example.com/products/chair?x=1&y=2" }),
    ]);
  });

  it("tolerates standard hreflang and image sitemap extensions inside url entries", async () => {
    await expect(
      new SitemapClient(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            xml(
              `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://www.example.com/products/chair</loc><lastmod>2026-01-01</lastmod><xhtml:link rel="alternate" hreflang="en" href="https://www.example.com/products/chair"/><image:image><image:loc>https://www.example.com/img/chair.jpg</image:loc><image:title>Chair</image:title></image:image></url></urlset>`,
            ),
          ),
        publicDns,
      ).listUrls(),
    ).resolves.toEqual([
      {
        url: "https://www.example.com/products/chair",
        sitemapUrl: "https://www.example.com/sitemap.xml",
        lastModified: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("blocks URL, depth and document bound violations rather than truncating", async () => {
    const urlset = (count: number) =>
      `<urlset ${sitemapNamespace}>${Array.from({ length: count }, (_, index) => `<url><loc>https://www.example.com/products/${index}</loc></url>`).join("")}</urlset>`;
    await expect(
      new SitemapClient(
        { ...config, maxSitemapUrls: 1 },
        vi.fn<typeof fetch>().mockResolvedValue(xml(urlset(2))),
        publicDns,
      ).listUrls(),
    ).rejects.toThrow("URL bound");

    const depthFetch = vi.fn<typeof fetch>(async (input) => {
      const level = Number(new URL(String(input)).pathname.match(/(\d+)/)?.[1] ?? 0);
      return xml(
        `<sitemapindex ${sitemapNamespace}><sitemap><loc>https://www.example.com/index-${level + 1}.xml</loc></sitemap></sitemapindex>`,
      );
    });
    await expect(
      new SitemapClient(
        { ...config, sitemapUrl: "https://www.example.com/index-0.xml" },
        depthFetch,
        publicDns,
      ).listUrls(),
    ).rejects.toThrow("depth bound");

    const children = Array.from(
      { length: 100 },
      (_, index) => `<sitemap><loc>https://www.example.com/${index}.xml</loc></sitemap>`,
    ).join("");
    await expect(
      new SitemapClient(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(xml(`<sitemapindex ${sitemapNamespace}>${children}</sitemapindex>`)),
        publicDns,
      ).listUrls(),
    ).rejects.toThrow("document bound");
  });

  it("pins sitemap transport to the validated public DNS answer", async () => {
    const ordinaryFetch = vi.fn<typeof fetch>();
    const pinned = vi.fn(async (context: { addresses: readonly string[] }) => {
      expect(context.addresses).toEqual(["93.184.216.34"]);
      return xml(`<urlset ${sitemapNamespace}/>`);
    });
    await new SitemapClient(
      config,
      ordinaryFetch,
      vi.fn().mockResolvedValue([{ address: "93.184.216.34" }]),
      pinned as never,
    ).listUrls();
    expect(ordinaryFetch).not.toHaveBeenCalled();
  });

  it("uses optional GSC query/page enrichment", async () => {
    const oauth = {
      accessToken: vi.fn().mockResolvedValue("token"),
    } as unknown as GoogleOAuthClient;
    const pages = await new GscSearchAnalyticsClient(
      oauth,
      config.gscSiteUrl!,
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        json({
          rows: [
            {
              keys: ["designer chair", "https://www.example.com/products/chair"],
              clicks: 2,
              impressions: 20,
            },
          ],
        }),
      ),
      publicDns,
      now,
    ).pages("designer chair");
    expect(pages).toEqual([expect.objectContaining({ clicks: 2, queries: ["designer chair"] })]);
  });

  it("ranks deterministically, persists sitemap provenance and caps at 25", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      url: `https://www.example.com/products/designer-chair-${String(index).padStart(2, "0")}`,
      sitemapUrl: config.sitemapUrl,
    }));
    const links = await mergeAndVerify(
      "designer chair",
      config,
      candidates,
      [],
      verifier(),
      now().toISOString(),
    );
    expect(links).toHaveLength(25);
    expect(links[0]).toMatchObject({
      source: "sitemap",
      status: 200,
      sitemap_url: config.sitemapUrl,
    });
    expect(links.map((link) => link.url)).toEqual([...links.map((link) => link.url)].sort());
  });

  it("bounds verification hierarchy-first so a collection survives 100 stronger-scored products", async () => {
    const candidates = [
      { url: "https://www.example.com/collections/chairs", sitemapUrl: config.sitemapUrl },
      ...Array.from({ length: 100 }, (_, index) => ({
        url: `https://www.example.com/products/designer-chair-${index}`,
        sitemapUrl: config.sitemapUrl,
      })),
    ];
    const result = await mergeAndVerifyDetailed(
      "designer chair",
      config,
      candidates,
      [],
      verifier(),
      now().toISOString(),
    );

    expect(result.links[0]).toMatchObject({
      url: "https://www.example.com/collections/chairs",
      hierarchy: "collection",
    });
    expect(result.counts).toMatchObject({
      commercial: 101,
      verification_attempted: 100,
      verification_omitted_bound: 1,
      verification_omitted_deadline: 0,
      direct_200: 100,
      unresolved: 0,
      shortlisted: 25,
    });
  });

  it("recognises locale-prefixed flat product routes and reserves verification capacity for them", async () => {
    const staleCollections = Array.from({ length: 100 }, (_, index) => ({
      url: `https://www.example.com/collections/chairs-${index}`,
      sitemapUrl: config.sitemapUrl,
    }));
    const flatProducts = Array.from({ length: 30 }, (_, index) => ({
      url: `https://www.example.com/en/designer-chair-${index}`,
      sitemapUrl: config.sitemapUrl,
    }));
    const verifier = {
      verifyOutcome: vi.fn(async (url: string) =>
        url.includes("/collections/")
          ? { outcome: "redirect" as const, method: "head" as const, status: 308 }
          : {
              outcome: "direct_200" as const,
              method: "head" as const,
              verified_at: now().toISOString(),
              hierarchy: "product" as const,
            },
      ),
    } as unknown as SafeUrlVerifier;

    const result = await mergeAndVerifyDetailed(
      "designer chair",
      config,
      [...staleCollections, ...flatProducts],
      [],
      verifier,
      now().toISOString(),
    );

    expect(result.links).toHaveLength(25);
    expect(result.links.every((link) => link.url.includes("/en/designer-chair-"))).toBe(true);
    expect(result.counts).toMatchObject({
      commercial: 130,
      verification_attempted: 100,
      verification_omitted_bound: 30,
      direct_200: 25,
      rejected_non_200: 75,
      shortlisted: 25,
    });
  });

  it("reports deadline-skipped candidates as unresolved without claiming attempts", async () => {
    const result = await mergeAndVerifyDetailed(
      "chair",
      config,
      [{ url: "https://www.example.com/collections/chairs", sitemapUrl: config.sitemapUrl }],
      [],
      verifier(),
      now().toISOString(),
      { verificationDeadlineMs: 0 },
    );

    expect(result.counts).toMatchObject({
      commercial: 1,
      verification_attempted: 0,
      verification_omitted_bound: 0,
      verification_omitted_deadline: 1,
      direct_200: 0,
      unresolved: 1,
      shortlisted: 0,
    });
  });

  it("uses fresh cache, forces refresh, and blocks stale historical evidence with zero current counts", async () => {
    const cachedOutcome = {
      availability: "available" as const,
      eligibility: "eligible" as const,
      reason: "verified_commercial_candidates" as const,
      links: [
        {
          ...(
            await mergeAndVerify(
              "chair",
              config,
              [{ url: "https://www.example.com/products/chair", sitemapUrl: config.sitemapUrl }],
              [],
              verifier(),
              now().toISOString(),
            )
          )[0]!,
        },
      ],
      providerStatus: { sitemap: "available" as const, gsc: "not_configured" as const },
      counts: {
        ghost_collected: 0,
        sitemap_collected: 1,
        gsc_collected: 0,
        deduplicated: 1,
        commercial: 1,
        editorial: 0,
        verification_attempted: 1,
        direct_200: 1,
        rejected_non_200: 0,
        unresolved: 0,
        shortlisted: 1,
      },
      retrievedAt: now().toISOString(),
    };
    const sitemap = { listUrls: vi.fn().mockResolvedValue([]) };
    const freshCache = {
      read: vi.fn().mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        fresh: true,
        outcome: cachedOutcome,
        retrievedAt: now(),
      }),
    };
    const sitemapOnlyConfig: LinkDiscoveryConfig = {
      sitemapUrl: config.sitemapUrl,
      siteOrigin: config.siteOrigin,
      allowedOrigins: config.allowedOrigins,
      cacheTtlMs: config.cacheTtlMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxSitemapUrls: config.maxSitemapUrls,
    };
    const discoverer = new LiveInternalLinkDiscoverer(
      sitemapOnlyConfig,
      sitemap as never,
      verifier(),
      freshCache,
      undefined,
      now,
    );
    await expect(discoverer.discover("chair")).resolves.toMatchObject({
      cache: { state: "fresh" },
      links: [{ url: "https://www.example.com/products/chair" }],
    });
    expect(sitemap.listUrls).not.toHaveBeenCalled();
    await expect(discoverer.discover("chair", { refresh: true })).resolves.toMatchObject({
      cache: { state: "refreshed" },
    });
    expect(sitemap.listUrls).toHaveBeenCalledOnce();

    const stale = new LiveInternalLinkDiscoverer(
      sitemapOnlyConfig,
      { listUrls: vi.fn().mockRejectedValue(new Error("down")) } as never,
      verifier(),
      {
        read: vi.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          fresh: false,
          outcome: cachedOutcome,
          retrievedAt: now(),
        }),
      },
      undefined,
      now,
    );
    await expect(stale.discover("chair")).resolves.toMatchObject({
      availability: "stale",
      eligibility: "blocked",
      links: [],
      counts: { sitemap_collected: 0, direct_200: 0, shortlisted: 0 },
      cache: { state: "stale", retrieved_at: now().toISOString() },
    });
  });

  it("computes cache freshness from stored expiry and preserves request identity isolation", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          payload: {
            availability: "unavailable",
            eligibility: "blocked",
            reason: "no_candidates",
            links: [],
            providerStatus: { sitemap: "unavailable", gsc: "not_configured" },
            counts: {
              ghost_collected: 0,
              sitemap_collected: 0,
              gsc_collected: 0,
              deduplicated: 0,
              commercial: 0,
              editorial: 0,
              verification_attempted: 0,
              direct_200: 0,
              rejected_non_200: 0,
              unresolved: 0,
              shortlisted: 0,
            },
          },
          expires_at: new Date("2026-01-01T00:00:01.000Z"),
          retrieved_at: new Date("2025-12-31T00:00:01.000Z"),
        },
      ],
    });
    const cache = new PostgresLinkDiscoveryCache({ query } as never, 1, now);
    await expect(cache.read("internal-links:v2", "request-a")).resolves.toMatchObject({
      fresh: true,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("request_hash=$2"), [
      "internal-links:v2",
      "request-a",
    ]);
    query.mock.results[0];
    const expired = new PostgresLinkDiscoveryCache(
      { query } as never,
      1,
      () => new Date("2026-01-01T00:00:01.000Z"),
    );
    await expect(expired.read("internal-links:v2", "request-b")).resolves.toMatchObject({
      fresh: false,
    });
  });

  it("keeps valid sitemap links when GSC fails and falls back to valid GSC when sitemap fails", async () => {
    const cache = { read: vi.fn().mockResolvedValue(null) };
    const sitemapValid = new LiveInternalLinkDiscoverer(
      config,
      {
        listUrls: vi
          .fn()
          .mockResolvedValue([
            { url: "https://www.example.com/products/chair", sitemapUrl: config.sitemapUrl },
          ]),
      } as never,
      verifier(),
      cache,
      { pages: vi.fn().mockRejectedValue(new Error("down")) } as never,
      now,
    );
    await expect(sitemapValid.discover("chair")).resolves.toMatchObject({
      eligibility: "eligible",
      providerStatus: { sitemap: "available", gsc: "unavailable" },
    });

    const gscFallback = new LiveInternalLinkDiscoverer(
      config,
      { listUrls: vi.fn().mockRejectedValue(new Error("down")) } as never,
      verifier(),
      cache,
      {
        pages: vi.fn().mockResolvedValue([
          {
            url: "https://www.example.com/products/chair",
            clicks: 1,
            impressions: 2,
            queries: ["chair"],
          },
        ]),
      } as never,
      now,
    );
    await expect(gscFallback.discover("chair")).resolves.toMatchObject({
      eligibility: "eligible",
      links: [{ source: "gsc" }],
    });
  });

  it("classifies and ranks hierarchy, topic, GSC, ties, editorial and homepage candidates", async () => {
    const candidates = [
      "/collections/chairs",
      "/designers/eames",
      "/collections/chairs/dining",
      "/products/designer-chair",
      "/editorial/designer-chair",
      "/",
    ].map((path) => ({ url: `https://www.example.com${path}`, sitemapUrl: config.sitemapUrl }));
    const ranked = await mergeAndVerify(
      "designer chair",
      config,
      candidates,
      [
        {
          url: "https://www.example.com/products/designer-chair",
          clicks: 100,
          impressions: 10_000,
          queries: ["designer chair"],
        },
      ],
      {
        verifyOutcome: vi.fn(async (url: string) => ({
          outcome: "direct_200" as const,
          method: "head" as const,
          verified_at: now().toISOString(),
          hierarchy:
            url === "https://www.example.com/"
              ? "homepage"
              : url.includes("/editorial/")
                ? "broad_category"
                : url.includes("/designers/")
                  ? "designer_hub"
                  : url.split("/").length > 5
                    ? "sub_collection"
                    : url.includes("/collections/")
                      ? "collection"
                      : "product",
        })),
      } as unknown as SafeUrlVerifier,
      now().toISOString(),
    );
    expect(ranked.map((link) => link.hierarchy)).toEqual([
      "collection",
      "designer_hub",
      "sub_collection",
      "product",
    ]);
    expect(ranked.at(-1)).toMatchObject({ source: "sitemap+gsc", gsc_clicks: 100 });
    expect(
      ranked.every(
        (link) => !link.url.includes("editorial") && link.url !== config.siteOrigin + "/",
      ),
    ).toBe(true);
    expect(ranked.map((link) => link.url)).toEqual(
      [...ranked]
        .sort(
          (a, b) =>
            a.hierarchy_rank! - b.hierarchy_rank! ||
            b.relevance - a.relevance ||
            a.url.localeCompare(b.url, "en-GB"),
        )
        .map((link) => link.url),
    );
  });

  it.each([405, 501])("falls back from HEAD %s to bounded GET", async (status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await expect(
      new SafeUrlVerifier(config, fetchMock, now, publicDns).verifyOutcome(
        "https://www.example.com/products/a",
      ),
    ).resolves.toMatchObject({ outcome: "direct_200", method: "get" });
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      "HEAD",
      "GET",
    ]);
  });

  it("rejects fallback redirects, oversized bodies, timeout and mixed/private DNS", async () => {
    const redirectFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/other" } }));
    await expect(
      new SafeUrlVerifier(config, redirectFetch, now, publicDns).verifyOutcome(
        "https://www.example.com/products/a",
      ),
    ).resolves.toMatchObject({ outcome: "redirect", method: "get" });

    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(
        new Response("x", { status: 200, headers: { "content-length": String(1024 * 1024 + 1) } }),
      );
    await expect(
      new SafeUrlVerifier(config, oversized, now, publicDns).verifyOutcome(
        "https://www.example.com/products/a",
      ),
    ).resolves.toMatchObject({ outcome: "unresolved_transport" });

    const mixedDns = vi
      .fn()
      .mockResolvedValue([{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    await expect(
      new SafeUrlVerifier(config, vi.fn(), now, mixedDns).verifyOutcome(
        "https://www.example.com/products/a",
      ),
    ).resolves.toMatchObject({ outcome: "unresolved_transport" });

    const timeoutFetch = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
      throw new Error("unreachable");
    });
    await expect(
      new SafeUrlVerifier(
        { ...config, requestTimeoutMs: 1 },
        timeoutFetch,
        now,
        publicDns,
      ).verifyOutcome("https://www.example.com/products/a"),
    ).resolves.toMatchObject({ outcome: "unresolved_transport", reason: "timeout" });
  });

  it("pins direct-200 verification and recognises private mapped addresses", async () => {
    expect(isPrivateAddress("::ffff:169.254.1.2")).toBe(true);
    const ordinaryFetch = vi.fn<typeof fetch>();
    const pinned = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      new SafeUrlVerifier(
        config,
        ordinaryFetch,
        now,
        vi.fn().mockResolvedValue([{ address: "93.184.216.34" }]),
        pinned,
      ).verify("https://www.example.com/products/a"),
    ).resolves.toMatchObject({ status: 200 });
    expect(ordinaryFetch).not.toHaveBeenCalled();
    expect(pinned).toHaveBeenCalledWith(expect.objectContaining({ addresses: ["93.184.216.34"] }));
  });
});

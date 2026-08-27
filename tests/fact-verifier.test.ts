import { describe, expect, it, vi } from "vitest";
import {
  NoNetworkFactVerifier,
  PublicStorefrontFactVerifier,
  factVerifierConfigFromEnv,
} from "../src/server/providers/fact-verifier.js";
import {
  ReviewResponseSchema,
  type FactInventoryItem,
  type ReviewRequest,
} from "../src/shared/milestone-three.js";
import type { PinnedFetcher } from "../src/server/providers/public-page-retriever.js";

const items: FactInventoryItem[] = [
  {
    stable_key: "dimension",
    text: "The Eames chair measures 80 cm high.",
    classification: "factual_figure",
    claim_type: "dimension",
    location: { field: "claims", line_start: 1 },
    product_identifier: "eames-chair",
  },
  {
    stable_key: "stat",
    text: "Sales rose by 20%.",
    classification: "factual_figure",
    claim_type: "statistic",
    location: { field: "claims", line_start: 2 },
  },
  {
    stable_key: "provenance",
    text: "Designed by Charles Eames.",
    classification: "attribution_provenance",
    claim_type: "provenance",
    location: { field: "claims", line_start: 3 },
    product_identifier: "eames-chair",
  },
];
const request = {
  run_id: "run-1",
  step: "review_fact_checking",
  document_version_id: "version-1",
  handoff: {
    plane_ticket: "MOB-1",
    primary_keyword: "chair",
    related_keywords: ["designer chair"],
    page_type: "blog",
    word_count_target: 900,
    locales_for_translation: [],
  },
  draft: {
    title: "Chair",
    slug: "chair",
    meta_description: "Chair.",
    og_title: "Chair",
    og_description: "Chair.",
    images: [],
    faqs: [],
    markdown: "# Chair",
    claims: [],
  },
  internal_links: [],
  reference_snapshots: [],
  fact_inventory: items,
  prompt: { template_id: "test", template_version: "1" },
  temperature: 0,
  model: "test",
} satisfies ReviewRequest;
const review = ReviewResponseSchema.parse({
  request_id: "review-1",
  findings: [],
  sources: [],
  claims: [],
  usage: { input_units: 0, output_units: 0, cost_micros: 0 },
});
const candidates = (...urls: string[]) => ({
  listUrls: vi.fn(async () =>
    urls.map((url) => ({ url, sitemapUrl: "https://www.mobelaris.com/products-sitemap.xml" })),
  ),
});
const product = (name = "Eames Chair", sku = "eames-chair", height = "80 cm") =>
  `<!doctype html><html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Product", name, sku, height, brand: "Charles Eames", description: `The ${name} has a height of ${height}. Delivery: 5 days.` }] })}</script></head><body><h1>${name}</h1><dl><dt>Height</dt><dd>${height}</dd><dt>Designer</dt><dd>Charles Eames</dd></dl></body></html>`;
const pinned = (pages: Record<string, string>, status = 200): PinnedFetcher =>
  vi.fn(async ({ url, init }) => {
    expect(init?.method).toBe("GET");
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(init?.headers).not.toHaveProperty("cookie");
    return new Response(pages[url.pathname] ?? "", {
      status,
      headers: { "content-type": "text/html" },
    });
  });
const verifier = (sitemap: ReturnType<typeof candidates>, fetcher: PinnedFetcher, overrides = {}) =>
  new PublicStorefrontFactVerifier({
    allowedOrigins: ["https://www.mobelaris.com"],
    sitemap,
    pinnedFetcher: fetcher,
    resolver: async () => [{ address: "93.184.216.34" }],
    retries: 0,
    now: () => new Date("2025-01-02T03:04:05Z"),
    ...overrides,
  });

describe("credential-free Step 1.7 storefront verifier", () => {
  it("keeps no-network claims unresolved and provenance hard flagged", async () => {
    const result = await new NoNetworkFactVerifier(() => new Date("2025-01-01Z")).verify(
      request,
      review,
    );
    expect(result.claims.every((claim) => claim.status === "unverified")).toBe(true);
    expect(result.claims[2]?.hard_flag).toBe(true);
  });

  it("discovers candidates independently from the sitemap and exact-matches slug/identifier", async () => {
    const sitemap = candidates(
      "https://www.mobelaris.com/products/eames-chair",
      "https://www.mobelaris.com/blog/unrelated",
    );
    const fetcher = pinned({
      "/products/eames-chair": product(),
      "/blog/unrelated": "<html><title>Article</title></html>",
    });
    const result = await verifier(sitemap, fetcher).verify(request, review);
    expect(sitemap.listUrls).toHaveBeenCalledOnce();
    expect(result.claims.map((claim) => claim.status)).toEqual([
      "verified",
      "unverified",
      "verified",
    ]);
    expect(result.claims[2]?.hard_flag).toBe(true);
    expect(
      result.sources.find((source) => source.source_type === "public_storefront")?.snapshot,
    ).toMatchObject({
      extraction_method: "product_json_ld+visible_labelled",
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      selection_evidence: { strategy: "exact_identifier_title_or_slug" },
    });
  });

  it("fetches locale-prefixed flat products and verifies matching storefront evidence", async () => {
    const candidate = "https://www.mobelaris.com/en/style-charles-eames-dining-chair";
    const fetcher = pinned({
      "/en/style-charles-eames-dining-chair": product(),
    });
    const result = await verifier(candidates(candidate), fetcher).verify(
      { ...request, fact_inventory: [items[0]!] },
      review,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.claims[0]?.status).toBe("verified");
    expect(result.sources[0]?.uri).toBe(candidate);
  });

  it("fetches only canonical, same-origin, query-free product candidates", async () => {
    const valid = "https://www.mobelaris.com/products/eames-chair";
    const fetcher = pinned({ "/products/eames-chair": product() });
    const result = await verifier(
      candidates(
        valid,
        "https://evil.example/products/eames-chair",
        "https://www.mobelaris.com/products/eames-chair?colour=red",
        "https://www.mobelaris.com/en/style-eames-chair#details",
        "https://www.mobelaris.com/en",
        "https://www.mobelaris.com/en/about",
        "https://www.mobelaris.com/products/eames-chair/details",
        "https://www.mobelaris.com/collections/eames-chair",
        "https://www.mobelaris.com/designers/eames",
        "https://www.mobelaris.com/categories/chairs",
        "https://www.mobelaris.com/editorial/eames-chair",
        "https://www.mobelaris.com/blog/eames-chair",
        "https://www.mobelaris.com/products/%E0%A4%A",
        "https://www.mobelaris.com/products/eames%2Fchair",
      ),
      fetcher,
    ).verify({ ...request, fact_inventory: [items[0]!] }, review);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.claims[0]?.status).toBe("verified");
  });

  it("extracts Product JSON-LD object, array and @graph plus visible labelled values", async () => {
    const variants = [
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Alpha Chair", sku: "alpha", material: "Oak" })}</script>`,
      `<script type="application/ld+json">${JSON.stringify([{ "@type": "Product", name: "Alpha Chair", sku: "alpha", material: "Oak" }])}</script>`,
      `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Product", name: "Alpha Chair", sku: "alpha" }] })}</script><table><tr><th>Material</th><td>Oak</td></tr></table><p>Material: Oak.</p>`,
    ];
    for (const body of variants) {
      const item = {
        ...items[0]!,
        stable_key: `material-${body.length}`,
        text: "The Alpha Chair uses oak.",
        claim_type: "material" as const,
        product_identifier: "alpha",
      };
      const result = await verifier(
        candidates("https://www.mobelaris.com/products/alpha"),
        pinned({ "/products/alpha": `<html><h1>Alpha Chair</h1>${body}</html>` }),
      ).verify({ ...request, fact_inventory: [item] }, review);
      expect(result.claims[0]?.status).toBe("verified");
    }
  });

  it("uses only offers owned by the identity-matched Product node", async () => {
    const item = {
      ...items[0]!,
      stable_key: "offer-price",
      text: "The Alpha Chair costs £120.",
      claim_type: "price" as const,
      product_identifier: "alpha",
    };
    const html = `<html><h1>Alpha Chair</h1><script type="application/ld+json">${JSON.stringify({
      "@graph": [
        {
          "@type": "Product",
          name: "Alpha Chair",
          sku: "alpha",
          offers: { "@id": "#alpha-offer" },
        },
        { "@type": "Product", name: "Beta Chair", sku: "beta", offers: { "@id": "#beta-offer" } },
        { "@type": "Offer", "@id": "#alpha-offer", price: "120", priceCurrency: "GBP" },
        { "@type": "Offer", "@id": "#beta-offer", price: "999", priceCurrency: "GBP" },
        { "@type": "Offer", price: "888", priceCurrency: "GBP" },
      ],
    })}</script></html>`;
    const result = await verifier(
      candidates("https://www.mobelaris.com/products/alpha"),
      pinned({ "/products/alpha": html }),
    ).verify({ ...request, fact_inventory: [item] }, review);
    expect(result.claims[0]?.status).toBe("verified");
    expect(result.sources[0]?.evidence).not.toContain("999");
    expect(result.sources[0]?.evidence).not.toContain("888");
  });

  it("keeps equally matching conflicting Product nodes unverified", async () => {
    const item = {
      ...items[0]!,
      stable_key: "duplicate-product-price",
      text: "The Alpha Chair costs £120.",
      claim_type: "price" as const,
      product_identifier: "alpha",
    };
    const html = `<html><h1>Alpha Chair</h1><script type="application/ld+json">${JSON.stringify({
      "@graph": [
        {
          "@type": "Product",
          name: "Alpha Chair",
          sku: "alpha",
          offers: { price: "120", priceCurrency: "GBP" },
        },
        {
          "@type": "Product",
          name: "Alpha Chair",
          sku: "alpha",
          offers: { price: "140", priceCurrency: "GBP" },
        },
      ],
    })}</script></html>`;
    const result = await verifier(
      candidates("https://www.mobelaris.com/products/alpha"),
      pinned({ "/products/alpha": html }),
    ).verify({ ...request, fact_inventory: [item] }, review);
    expect(result.claims[0]?.status).toBe("unverified");
    expect(result.sources[0]?.snapshot).toMatchObject({
      conflict: true,
      selection_evidence: { json_ld_product_selection: { matching_node_count: 2 } },
    });
  });

  it("uses a unique bounded fuzzy match but treats tied candidates as unverified", async () => {
    const item = {
      ...items[0]!,
      product_identifier: "alpha lounge chair",
      text: "The Alpha Lounge Chair measures 80 cm high.",
    };
    const unique = await verifier(
      candidates(
        "https://www.mobelaris.com/products/alpha-lounge-chair-deluxe",
        "https://www.mobelaris.com/products/table",
      ),
      pinned({
        "/products/alpha-lounge-chair-deluxe": product("Alpha Lounge Chair Deluxe", "other"),
        "/products/table": product("Dining Table", "table"),
      }),
    ).verify({ ...request, fact_inventory: [item] }, review);
    expect(unique.claims[0]?.status).toBe("verified");
    expect(unique.sources[0]?.snapshot.selection_evidence).toMatchObject({
      strategy: "bounded_fuzzy",
    });
    const ambiguous = await verifier(
      candidates(
        "https://www.mobelaris.com/products/alpha-lounge-one",
        "https://www.mobelaris.com/products/alpha-lounge-two",
      ),
      pinned({
        "/products/alpha-lounge-one": product("Alpha Lounge Chair One", "one"),
        "/products/alpha-lounge-two": product("Alpha Lounge Chair Two", "two"),
      }),
    ).verify({ ...request, fact_inventory: [item] }, review);
    expect(ambiguous.claims[0]?.status).toBe("unverified");
  });

  it("rejects category routes, hidden evidence, cross-field dimensions and conflicting sources", async () => {
    const adversarial = [
      { ...items[0]!, stable_key: "width", text: "The Eames chair is 80 cm wide." },
      { ...items[0]!, stable_key: "height", text: "The Eames chair is 80 cm high." },
    ];
    const html = `${product()}<div hidden>Width: 80 cm.</div><template>Width: 80 cm.</template><div aria-hidden="true">Width: 80 cm.</div><div class="hidden">Width: 80 cm.</div><p>Height: 70 cm.</p>`;
    const fetcher = pinned({
      "/products/eames-chair": html,
      "/collections/eames-chair": product(),
      "/category/eames-chair": product(),
    });
    const result = await verifier(
      candidates(
        "https://www.mobelaris.com/collections/eames-chair",
        "https://www.mobelaris.com/category/eames-chair",
        "https://www.mobelaris.com/products/eames-chair",
      ),
      fetcher,
    ).verify({ ...request, fact_inventory: adversarial }, review);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.claims.map((claim) => claim.status)).toEqual(["unverified", "unverified"]);
    expect(result.findings[1]?.evidence).toContain("Conflicting source values");
  });

  it("uses exact owned conversions, material tokens, price currencies and distinct availability evidence", async () => {
    const claims: FactInventoryItem[] = [
      { ...items[0]!, stable_key: "converted", text: "The Eames chair is 800 mm high." },
      {
        ...items[0]!,
        stable_key: "material-exact",
        text: "The chair uses oak veneer.",
        claim_type: "material",
      },
      { ...items[0]!, stable_key: "price-ok", text: "The chair costs £120.", claim_type: "price" },
      {
        ...items[0]!,
        stable_key: "price-bad",
        text: "The chair costs $120 USD.",
        claim_type: "price",
      },
      {
        ...items[0]!,
        stable_key: "price-internal-mismatch",
        text: "The chair costs $120 GBP.",
        claim_type: "price",
      },
      {
        ...items[0]!,
        stable_key: "available",
        text: "The chair is in stock.",
        claim_type: "delivery",
      },
    ];
    const html = `<html><h1>Eames Chair</h1><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Eames Chair",
      sku: "eames-chair",
      height: "80 cm",
      material: "Oak veneer",
      offers: {
        "@type": "Offer",
        price: "120",
        priceCurrency: "GBP",
        availability: "https://schema.org/InStock",
      },
    })}</script></html>`;
    const result = await verifier(
      candidates("https://www.mobelaris.com/products/eames-chair"),
      pinned({ "/products/eames-chair": html }),
    ).verify({ ...request, fact_inventory: claims }, review);
    expect(result.claims.map((claim) => claim.status)).toEqual([
      "verified",
      "verified",
      "verified",
      "contradicted",
      "contradicted",
      "verified",
    ]);
    expect(result.sources.at(-1)?.evidence).toContain("availability:");
  });

  it("parses locale-aware prices without collapsing separators and rejects ambiguity", async () => {
    const priceClaims = [
      ["gbp-1200", "The chair costs £1,200.", "1,200", "GBP", "verified"],
      ["gbp-1299", "The chair costs £1,299.", "1,299", "GBP", "verified"],
      ["decimal", "The chair costs £1,200.50.", "1200.50", "GBP", "verified"],
      ["euro", "The chair costs €1.200,50.", "1.200,50", "EUR", "verified"],
      ["ambiguous", "The chair costs 1,200.", "1200", "GBP", "unverified"],
    ] as const;
    for (const [key, text, amount, currency, expected] of priceClaims) {
      const item = { ...items[0]!, stable_key: key, text, claim_type: "price" as const };
      const html = `<html><h1>Eames Chair</h1><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Eames Chair",
        sku: "eames-chair",
        offers: { price: amount, priceCurrency: currency },
      })}</script></html>`;
      const result = await verifier(
        candidates("https://www.mobelaris.com/products/eames-chair"),
        pinned({ "/products/eames-chair": html }),
      ).verify({ ...request, fact_inventory: [item] }, review);
      expect(result.claims[0]?.status, key).toBe(expected);
    }
  });

  it("associates price amounts with currency or cost context and rejects multiple plausible prices", async () => {
    const cases = [
      ["symbol-before", "The 2065 Chair costs £120.", "verified"],
      ["symbol-after", "The 2065 Chair costs 120£.", "verified"],
      ["iso-before", "The 2065 Chair costs GBP 120.", "verified"],
      ["iso-after", "The 2065 Chair costs 120 GBP.", "verified"],
      ["cost-context", "The 2065 Chair costs 120.", "verified"],
      ["price-context", "The 2065 Chair price is 120.", "verified"],
      ["unrelated-number", "The 2065 Chair is available; it costs £120.", "verified"],
      ["no-price-context", "The 2065 Chair is available in 120 colours.", "unverified"],
      ["range", "The chair costs £120–£140.", "unverified"],
      ["shared-currency-range", "The chair costs £120–140.", "unverified"],
      ["multiple", "The chair was £100 and now costs £120.", "unverified"],
    ] as const;
    for (const [key, text, expected] of cases) {
      const item = { ...items[0]!, stable_key: key, text, claim_type: "price" as const };
      const html = `<html><h1>Eames Chair</h1><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Eames Chair",
        sku: "eames-chair",
        offers: { price: "120", priceCurrency: "GBP" },
      })}</script></html>`;
      const result = await verifier(
        candidates("https://www.mobelaris.com/products/eames-chair"),
        pinned({ "/products/eames-chair": html }),
      ).verify({ ...request, fact_inventory: [item] }, review);
      expect(result.claims[0]?.status, key).toBe(expected);
    }
  });

  it("uses canonical, negation-safe availability states", async () => {
    const cases = [
      ["in stock", "https://schema.org/InStock", "verified"],
      ["not in stock", "https://schema.org/InStock", "contradicted"],
      ["out of stock", "https://schema.org/OutOfStock", "verified"],
      ["available", "https://schema.org/PreOrder", "contradicted"],
      ["not available", "https://schema.org/InStock", "contradicted"],
      ["not discontinued", "https://schema.org/Discontinued", "unverified"],
    ] as const;
    for (const [claimState, evidenceState, expected] of cases) {
      const item = {
        ...items[0]!,
        stable_key: `availability-${claimState}`,
        text: `The chair is ${claimState}.`,
        claim_type: "delivery" as const,
      };
      const html = `<html><h1>Eames Chair</h1><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Eames Chair",
        sku: "eames-chair",
        offers: { availability: evidenceState },
      })}</script></html>`;
      const result = await verifier(
        candidates("https://www.mobelaris.com/products/eames-chair"),
        pinned({ "/products/eames-chair": html }),
      ).verify({ ...request, fact_inventory: [item] }, review);
      expect(result.claims[0]?.status, claimState).toBe(expected);
    }
  });

  it("owns contradiction decisions and never verifies unsupported general/statistical claims", async () => {
    const result = await verifier(
      candidates("https://www.mobelaris.com/products/eames-chair"),
      pinned({ "/products/eames-chair": product("Eames Chair", "eames-chair", "70 cm") }),
    ).verify(request, review);
    expect(result.claims.map((claim) => claim.status)).toEqual([
      "contradicted",
      "unverified",
      "verified",
    ]);
  });

  it("fails closed for DNS, redirects/non-200, content type and response bounds", async () => {
    const sitemap = candidates("https://www.mobelaris.com/products/eames-chair");
    const privateFetch = vi.fn<PinnedFetcher>();
    await new PublicStorefrontFactVerifier({
      allowedOrigins: ["https://www.mobelaris.com"],
      sitemap,
      pinnedFetcher: privateFetch,
      resolver: async () => [{ address: "127.0.0.1" }],
      retries: 0,
    }).verify({ ...request, fact_inventory: [items[0]!] }, review);
    expect(privateFetch).not.toHaveBeenCalled();
    for (const response of [
      new Response(product(), { status: 302, headers: { "content-type": "text/html" } }),
      new Response(product(), { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      const result = await verifier(
        sitemap,
        vi.fn(async () => response),
      ).verify({ ...request, fact_inventory: [items[0]!] }, review);
      expect(result.claims[0]?.status).toBe("unverified");
    }
    const oversized = await verifier(
      sitemap,
      pinned({ "/products/eames-chair": product() + "x".repeat(20_000) }),
      { maxResponseBytes: 16_384 },
    ).verify({ ...request, fact_inventory: [items[0]!] }, review);
    expect(oversized.claims[0]?.status).toBe("unverified");
  });

  it("accepts only the credential-free environment contract and strict bounds", () => {
    expect(() =>
      factVerifierConfigFromEnv({ FACT_VERIFIER_ALLOWED_ORIGINS: "http://localhost:3000" }),
    ).toThrow();
    expect(
      factVerifierConfigFromEnv({
        FACT_VERIFIER_ALLOWED_ORIGINS: "https://www.mobelaris.com",
        FACT_VERIFIER_CONCURRENCY: "3",
      }),
    ).toMatchObject({ allowedOrigins: ["https://www.mobelaris.com"], concurrency: 3 });
    expect(() =>
      factVerifierConfigFromEnv({
        FACT_VERIFIER_ALLOWED_ORIGINS: "https://www.mobelaris.com",
        FACT_VERIFIER_RETRIES: "3",
      }),
    ).toThrow();
    expect(
      factVerifierConfigFromEnv({ FACT_VERIFIER_MEDUSA_BASE_URL: "https://legacy.example" }),
    ).toBeUndefined();
  });
});

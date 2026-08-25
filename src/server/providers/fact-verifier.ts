import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { z } from "zod";
import type { SitemapClient, SitemapCandidate } from "./internal-link-discovery.js";
import { nodeHttpsPinnedFetcher, type PinnedFetcher } from "./public-page-retriever.js";
import {
  ReviewRequestSchema,
  ReviewResponseSchema,
  type FactInventoryItem,
  type ReviewRequest,
  type ReviewResponse,
} from "../../shared/milestone-three.js";

const PRODUCT_TYPES = new Set(["dimension", "material", "price", "delivery", "provenance"]);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_CANDIDATES = 30;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 1;
const MAX_INVENTORY_ITEMS = 100;
const MAX_CLAIM_LENGTH = 2_000;
const MAX_EXCERPT = 2_000;

type Resolver = (host: string) => Promise<readonly { address: string }[]>;
type SitemapReader = Pick<SitemapClient, "listUrls">;
type Status = "verified" | "contradicted" | "unverified";

export interface FactVerifier {
  verify(request: ReviewRequest, review: ReviewResponse): Promise<ReviewResponse>;
}
export interface FactVerifierConfig {
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxCandidates?: number;
  concurrency?: number;
  retries?: number;
}
export interface PublicStorefrontFactVerifierOptions extends FactVerifierConfig {
  sitemap: SitemapReader;
  resolver?: Resolver;
  pinnedFetcher?: PinnedFetcher;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

const integer = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) => {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
};
function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.toString() !== `${url.origin}/` ||
    url.hostname === "localhost" ||
    isIP(url.hostname)
  )
    throw new Error(
      "FACT_VERIFIER_ALLOWED_ORIGINS must contain credential-free public HTTPS origins.",
    );
  return url.origin;
}
export function factVerifierConfigFromEnv(
  env: Record<string, string | undefined>,
): FactVerifierConfig | undefined {
  const raw = env.FACT_VERIFIER_ALLOWED_ORIGINS?.trim();
  const settings = [
    env.FACT_VERIFIER_TIMEOUT_MS,
    env.FACT_VERIFIER_MAX_RESPONSE_BYTES,
    env.FACT_VERIFIER_MAX_CANDIDATES,
    env.FACT_VERIFIER_CONCURRENCY,
    env.FACT_VERIFIER_RETRIES,
  ];
  if (!raw && !settings.some((value) => value?.trim())) return undefined;
  if (!raw)
    throw new Error(
      "FACT_VERIFIER_ALLOWED_ORIGINS is required when fact verifier settings are configured.",
    );
  return {
    allowedOrigins: [...new Set(raw.split(",").map((value) => exactOrigin(value.trim())))],
    timeoutMs: integer(
      env.FACT_VERIFIER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      500,
      30_000,
      "FACT_VERIFIER_TIMEOUT_MS",
    ),
    maxResponseBytes: integer(
      env.FACT_VERIFIER_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_BYTES,
      16_384,
      1024 * 1024,
      "FACT_VERIFIER_MAX_RESPONSE_BYTES",
    ),
    maxCandidates: integer(
      env.FACT_VERIFIER_MAX_CANDIDATES,
      DEFAULT_MAX_CANDIDATES,
      1,
      100,
      "FACT_VERIFIER_MAX_CANDIDATES",
    ),
    concurrency: integer(
      env.FACT_VERIFIER_CONCURRENCY,
      DEFAULT_CONCURRENCY,
      1,
      8,
      "FACT_VERIFIER_CONCURRENCY",
    ),
    retries: integer(env.FACT_VERIFIER_RETRIES, DEFAULT_RETRIES, 0, 2, "FACT_VERIFIER_RETRIES"),
  };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stableKey = (prefix: string, value: string) => `${prefix}-${hash(value).slice(0, 20)}`;
function unresolvedSource(
  item: FactInventoryItem,
  retrievedAt: string,
  reason = "No unambiguous public storefront evidence was found.",
) {
  return {
    stable_key: stableKey("source-unresolved", item.stable_key),
    uri: `mock://fact-check/unresolved/${item.stable_key}`,
    title: "No approved evidence available",
    source_type: "unresolved" as const,
    retrieved_at: retrievedAt,
    snapshot: { production_verified: false, reason },
    evidence: reason,
  };
}
function findingFor(
  item: FactInventoryItem,
  status: "unverified" | "contradicted",
  evidence?: string,
) {
  const provenance =
    item.classification === "attribution_provenance" || item.claim_type === "provenance";
  return {
    stable_key: stableKey("fact", `${item.stable_key}:${status}`),
    category: provenance ? "provenance" : "fact_checking",
    rule_reference: provenance ? "facts.provenance_always_review" : `facts.${status}`,
    severity: "blocker" as const,
    location: item.location,
    issue: provenance
      ? `Provenance claim requires operator review (${status}): ${item.text}`
      : `Factual claim is ${status}: ${item.text}`,
    ...(evidence ? { evidence } : {}),
    suggested_fix: "Review the evidence and correct, source, or remove this claim before approval.",
  };
}

export class NoNetworkFactVerifier implements FactVerifier {
  constructor(private readonly now: () => Date = () => new Date()) {}
  async verify(rawRequest: ReviewRequest, rawReview: ReviewResponse): Promise<ReviewResponse> {
    const request = ReviewRequestSchema.parse(rawRequest),
      review = ReviewResponseSchema.parse(rawReview),
      retrievedAt = this.now().toISOString();
    const sources = request.fact_inventory.map((item) => unresolvedSource(item, retrievedAt));
    const claims = request.fact_inventory.map((item, index) =>
      claimRecord(item, "unverified", sources[index]!.stable_key),
    );
    return ReviewResponseSchema.parse({
      ...review,
      sources,
      claims,
      findings: dedupe([
        ...review.findings,
        ...request.fact_inventory.map((item) => findingFor(item, "unverified")),
      ]),
    });
  }
}

type ExtractedValue = { value: string; method: string; field?: string };
type StructuredProduct = {
  title: string;
  identifiers: string[];
  fields: Record<string, ExtractedValue[]>;
};
type Extracted = {
  title: string;
  slug: string;
  identifiers: string[];
  fields: Record<string, ExtractedValue[]>;
  products: StructuredProduct[];
};
type Page = { candidate: SitemapCandidate; html: string; data: Extracted; contentHash: string };
type Evidence = {
  status: Status;
  excerpt: string;
  page: Page;
  selection: Record<string, unknown>;
  method: string;
  conflict: boolean;
};

/** Credential-free, read-only verification against independently discovered sitemap product pages. */
export class PublicStorefrontFactVerifier implements FactVerifier {
  private readonly allowedOrigins: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxCandidates: number;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly resolver: Resolver;
  private readonly pinned: PinnedFetcher;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: PublicStorefrontFactVerifierOptions) {
    this.allowedOrigins = options.allowedOrigins.map((value) => exactOrigin(value));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    if (
      this.timeoutMs < 500 ||
      this.timeoutMs > 30_000 ||
      this.maxBytes < 16_384 ||
      this.maxBytes > 1024 * 1024 ||
      this.maxCandidates < 1 ||
      this.maxCandidates > 100 ||
      this.concurrency < 1 ||
      this.concurrency > 8 ||
      this.retries < 0 ||
      this.retries > 2
    )
      throw new Error("Fact verifier runtime bounds are invalid");
    this.resolver = options.resolver ?? ((host) => dns.lookup(host, { all: true }));
    this.pinned = options.pinnedFetcher ?? nodeHttpsPinnedFetcher;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async verify(rawRequest: ReviewRequest, rawReview: ReviewResponse): Promise<ReviewResponse> {
    const request = ReviewRequestSchema.parse(rawRequest),
      review = ReviewResponseSchema.parse(rawReview);
    if (
      request.fact_inventory.length > MAX_INVENTORY_ITEMS ||
      request.fact_inventory.some((item) => item.text.length > MAX_CLAIM_LENGTH)
    )
      throw new Error("Fact inventory exceeds verifier bounds");
    const retrievedAt = this.now().toISOString();
    const needsProducts = request.fact_inventory.some(
      (item) => PRODUCT_TYPES.has(item.claim_type) && item.product_identifier,
    );
    const pages = needsProducts ? await this.productPages() : [];
    const sources: ReviewResponse["sources"] = [],
      claims: ReviewResponse["claims"] = [];
    for (const item of request.fact_inventory) {
      const evidence =
        PRODUCT_TYPES.has(item.claim_type) && item.product_identifier
          ? this.evidence(item, pages)
          : undefined;
      const source = evidence
        ? this.source(evidence, retrievedAt)
        : unresolvedSource(
            item,
            retrievedAt,
            item.claim_type === "general" || item.claim_type === "statistic"
              ? "General and statistical claims are unsupported by storefront product evidence."
              : undefined,
          );
      const existing = sources.find((entry) => entry.stable_key === source.stable_key);
      if (!existing) sources.push(source);
      claims.push(
        claimRecord(item, evidence?.status ?? "unverified", (existing ?? source).stable_key),
      );
    }
    const flagged = claims
      .filter((claim) => claim.status !== "verified" || claim.type === "provenance")
      .map((claim) => {
        const source = sources.find((entry) => entry.stable_key === claim.source_key);
        const conflict = source?.snapshot.conflict === true;
        return findingFor(
          request.fact_inventory.find((item) => item.stable_key === claim.inventory_key)!,
          claim.status === "contradicted" ? "contradicted" : "unverified",
          conflict ? `Conflicting source values: ${source.evidence}` : undefined,
        );
      });
    return ReviewResponseSchema.parse({
      ...review,
      sources,
      claims,
      findings: dedupe([...review.findings, ...flagged]),
    });
  }
  private async productPages(): Promise<Page[]> {
    let candidates: SitemapCandidate[];
    try {
      candidates = (await this.options.sitemap.listUrls())
        .filter((candidate) => {
          const path = new URL(candidate.url).pathname.replace(/\/+$/, "");
          return /(?:^|\/)products\/[^/]+$/i.test(path);
        })
        .slice(0, this.maxCandidates);
    } catch {
      return [];
    }
    const results: Page[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, candidates.length) }, async () => {
        for (;;) {
          const candidate = candidates[cursor++];
          if (!candidate) return;
          const html = await this.get(candidate.url);
          if (!html) continue;
          const data = extractProduct(html, candidate.url);
          if (data) results.push({ candidate, html, data, contentHash: hash(html) });
        }
      }),
    );
    return results.sort((a, b) => a.candidate.url.localeCompare(b.candidate.url));
  }
  private evidence(item: FactInventoryItem, pages: Page[]): Evidence | undefined {
    const id = normal(item.product_identifier!);
    const exact = pages.filter(
      (page) =>
        page.data.identifiers.some((value) => normal(value) === id) ||
        normal(page.data.title) === id ||
        normal(page.data.slug) === id,
    );
    if (exact.length > 1) return undefined;
    const scored = pages
      .map((page) => ({
        page,
        score: similarity(
          id,
          normal(`${page.data.title} ${page.data.slug} ${page.data.identifiers.join(" ")}`),
        ),
      }))
      .filter((entry) => entry.score >= 0.72)
      .sort(
        (a, b) => b.score - a.score || a.page.candidate.url.localeCompare(b.page.candidate.url),
      );
    if (
      exact.length === 0 &&
      (!scored[0] || (scored[1] && Math.abs(scored[0].score - scored[1].score) < 0.08))
    )
      return undefined;
    const selected = exact[0] ?? scored[0]?.page;
    if (!selected) return undefined;
    const selection: Record<string, unknown> = exact[0]
      ? {
          strategy: "exact_identifier_title_or_slug",
          product_identifier: item.product_identifier,
          matched_url: selected.candidate.url,
        }
      : {
          strategy: "bounded_fuzzy",
          score: scored[0]!.score,
          runner_up_score: scored[1]?.score ?? null,
          product_identifier: item.product_identifier,
          matched_url: selected.candidate.url,
        };
    const structured = selectStructuredProducts(selected.data, item.product_identifier!);
    const values = [
      ...structured.products.flatMap((product) => product.fields[item.claim_type] ?? []),
      ...(selected.data.fields[item.claim_type] ?? []),
    ];
    if (!values.length) return undefined;
    const excerpt = values
      .map((entry) => `${entry.field ? `${entry.field}: ` : ""}${entry.value}`)
      .join("; ")
      .slice(0, MAX_EXCERPT);
    const comparisons = values.map((entry) => compare(item.claim_type, item.text, entry));
    const decisive = comparisons.filter((value) => value !== "missing");
    const conflict =
      structured.conflict ||
      new Set(decisive).size > 1 ||
      sourceValuesConflict(item.claim_type, values);
    const compared = conflict
      ? "missing"
      : decisive.includes("verified")
        ? "verified"
        : decisive.includes("contradicted")
          ? "contradicted"
          : "missing";
    return {
      status: compared === "missing" ? "unverified" : compared,
      excerpt,
      page: selected,
      selection: {
        ...selection,
        json_ld_product_selection: structured.selection,
        selection_reason: conflict
          ? "Conflicting structured or visible evidence was retained for operator review."
          : "Matched the claim field against all bounded structured and visible product evidence.",
        conflict,
      },
      method: [...new Set(values.map((entry) => entry.method))].join("+"),
      conflict,
    };
  }
  private source(evidence: Evidence, retrievedAt: string): ReviewResponse["sources"][number] {
    const snapshot = {
      content_hash: evidence.page.contentHash,
      evidence_hash: hash(evidence.excerpt),
      evidence_excerpt: evidence.excerpt,
      extraction_method: evidence.method,
      selection_evidence: evidence.selection,
      selection_reason: String(evidence.selection.selection_reason ?? evidence.selection.strategy),
      conflict: evidence.conflict,
      sitemap_source: evidence.page.candidate.sitemapUrl,
      bounded_characters: evidence.page.html.length,
    };
    return {
      stable_key: stableKey(
        "source",
        `${evidence.page.candidate.url}:${evidence.page.contentHash}:${hash(evidence.excerpt)}`,
      ),
      uri: evidence.page.candidate.url,
      title: evidence.page.data.title || "Mobelaris product",
      source_type: "public_storefront",
      retrieved_at: retrievedAt,
      snapshot,
      evidence: evidence.excerpt,
    };
  }
  private async get(value: string): Promise<string | undefined> {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !this.allowedOrigins.includes(url.origin)
    )
      return undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++)
      try {
        const records = await Promise.race([
          this.resolver(url.hostname),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("DNS timeout")), Math.min(this.timeoutMs, 5_000)),
          ),
        ]);
        if (!records.length || records.some((record) => !publicAddress(record.address)))
          return undefined;
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.pinned({
            url,
            addresses: records.map((record) => record.address),
            signal: controller.signal,
            init: { method: "GET", headers: { Accept: "text/html,application/xhtml+xml" } },
          });
          if (response.status !== 200 || (response.url && new URL(response.url).href !== url.href))
            return undefined;
          const type = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (!type.includes("text/html") && !type.includes("application/xhtml+xml"))
            return undefined;
          const bytes = await readBounded(response, this.maxBytes);
          return new TextDecoder().decode(bytes);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        if (attempt === this.retries) return undefined;
        await this.sleep(100 * (attempt + 1));
      }
    return undefined;
  }
}

function claimRecord(item: FactInventoryItem, status: Status, sourceKey: string) {
  return {
    stable_key: stableKey("claim", item.stable_key),
    inventory_key: item.stable_key,
    claim_text: item.text,
    type:
      item.classification === "attribution_provenance" ? ("provenance" as const) : item.claim_type,
    status,
    location: item.location,
    hard_flag: item.classification === "attribution_provenance" || item.claim_type === "provenance",
    source_key: sourceKey,
  };
}
async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function extractProduct(html: string, url: string): Extracted | undefined {
  const fields: Record<string, ExtractedValue[]> = {};
  const addTo = (
    target: Record<string, ExtractedValue[]>,
    key: string,
    value: unknown,
    method: string,
    field?: string,
  ) => {
    for (const item of Array.isArray(value) ? value : [value])
      if (["string", "number"].includes(typeof item) && String(item).trim())
        (target[key] ??= []).push({
          value: clean(String(item)),
          method,
          ...(field ? { field } : {}),
        });
  };
  const add = (key: string, value: unknown, method: string, field?: string) =>
    addTo(fields, key, value, method, field);
  const productNodes: Record<string, unknown>[] = [];
  const offerNodes = new Map<string, Record<string, unknown>>();
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ))
    try {
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
        if (types.includes("Product")) productNodes.push(record);
        if (types.includes("Offer") && typeof record["@id"] === "string")
          offerNodes.set(record["@id"], record);
        if (record["@graph"]) visit(record["@graph"]);
      };
      visit(JSON.parse(match[1]!));
    } catch {
      /* malformed structured data is ignored */
    }
  const products: StructuredProduct[] = productNodes.map((product) => {
    const productFields: Record<string, ExtractedValue[]> = {};
    const identifiers = [product.sku, product.productID, product.mpn, product["@id"]].filter(
      (value): value is string => typeof value === "string",
    );
    addTo(productFields, "material", product.material, "product_json_ld", "material");
    addTo(productFields, "provenance", product.brand, "product_json_ld", "brand");
    for (const field of ["height", "width", "depth", "length", "weight"])
      addTo(productFields, "dimension", product[field], "product_json_ld", field);
    const offerValues = Array.isArray(product.offers) ? product.offers : [product.offers];
    const ownedOffers = offerValues.flatMap((offer) => {
      if (!offer || typeof offer !== "object") return [];
      const record = offer as Record<string, unknown>;
      return typeof record["@id"] === "string" && offerNodes.has(record["@id"])
        ? [offerNodes.get(record["@id"])!]
        : [record];
    });
    for (const offer of ownedOffers) {
      addTo(
        productFields,
        "price",
        `${String(offer.price ?? "")} ${String(offer.priceCurrency ?? "")}`.trim(),
        "offer_json_ld",
        "price",
      );
      addTo(productFields, "delivery", offer.deliveryLeadTime, "offer_json_ld", "delivery");
      addTo(productFields, "delivery", offer.availability, "offer_json_ld", "availability");
    }
    return { title: clean(String(product.name ?? "")), identifiers, fields: productFields };
  });
  let title = "";
  const visible = visibleText(html);
  title ||= decode(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
      "",
  );
  for (const match of visible.matchAll(
    /\b(dimensions?|height|width|depth|length|weight|material|price|delivery|lead time|availability|designer|designed by)\s*[:\-]\s*([^.;|]{1,200})/gi,
  )) {
    const label = normal(match[1]!),
      value = match[2]!;
    const key = /dimension|height|width|depth|length|weight/.test(label)
      ? "dimension"
      : /material/.test(label)
        ? "material"
        : /price/.test(label)
          ? "price"
          : /designer|designed/.test(label)
            ? "provenance"
            : "delivery";
    add(key, value, "visible_labelled", label.replace(" ", "_"));
  }
  if (!title && !products.length) return undefined;
  const slug = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""),
    pageIdentities = [normal(title), normal(slug)];
  return {
    title: clean(title),
    slug,
    identifiers: [
      ...new Set(
        products
          .filter(
            (product) =>
              pageIdentities.includes(normal(product.title)) ||
              product.identifiers.some((identifier) => pageIdentities.includes(normal(identifier))),
          )
          .flatMap((product) => product.identifiers),
      ),
    ],
    fields,
    products,
  };
}
function selectStructuredProducts(
  data: Extracted,
  productIdentifier: string,
): { products: StructuredProduct[]; conflict: boolean; selection: Record<string, unknown> } {
  if (!data.products.length)
    return { products: [], conflict: false, selection: { strategy: "no_product_json_ld" } };
  const identities = [productIdentifier, data.slug, data.title].map(normal).filter(Boolean);
  const scored = data.products.map((product, index) => {
    const productIdentities = [...product.identifiers, product.title].map(normal);
    const exactIndex = identities.findIndex((identity) => productIdentities.includes(identity));
    return { product, index, score: exactIndex < 0 ? 0 : identities.length - exactIndex };
  });
  const highest = Math.max(...scored.map((entry) => entry.score));
  if (highest === 0)
    return {
      products: [],
      conflict: false,
      selection: { strategy: "no_identity_match", candidate_count: data.products.length },
    };
  const selected = scored.filter((entry) => entry.score === highest);
  const conflict =
    selected.length > 1 &&
    Object.keys(Object.assign({}, ...selected.map((entry) => entry.product.fields))).some((type) =>
      sourceValuesConflict(
        type,
        selected.flatMap((entry) => entry.product.fields[type] ?? []),
      ),
    );
  return {
    products: selected.map((entry) => entry.product),
    conflict,
    selection: {
      strategy: "exact_page_product_identity",
      matching_node_count: selected.length,
      selected_node_indexes: selected.map((entry) => entry.index),
      conflict,
    },
  };
}
function visibleText(html: string): string {
  let safe = html
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<([a-z][\w:-]*)\b(?=[^>]*(?:\bhidden\b|\baria-hidden\s*=\s*["']?true|\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)|\bclass\s*=\s*["'][^"']*\bhidden\b))[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
  return clean(
    safe
      .replace(/<[^>]*\b(?:hidden|aria-hidden\s*=\s*["']?true)[^>]*>/gi, " ")
      .replace(/<\/(?:dt|th|label)>/gi, ": ")
      .replace(/<\/(?:dd|td|p|li)>/gi, ". ")
      .replace(/<[^>]+>/g, " "),
  );
}
function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
function clean(value: string): string {
  return decode(value).replace(/\s+/g, " ").trim();
}
function normal(value: string): string {
  return value
    .toLocaleLowerCase("en-GB")
    .replace(/[^\p{L}\p{N}£$€%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(value: string): Set<string> {
  return new Set(
    normal(value)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}
function similarity(a: string, b: string): number {
  const aa = tokens(a),
    bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  return (2 * [...aa].filter((value) => bb.has(value)).length) / (aa.size + bb.size);
}
const DIMENSION_FIELDS = ["height", "width", "depth", "length", "weight"] as const;
const UNIT_FACTORS: Record<string, { family: string; factor: number }> = {
  mm: { family: "length", factor: 1 },
  cm: { family: "length", factor: 10 },
  m: { family: "length", factor: 1000 },
  g: { family: "weight", factor: 1 },
  kg: { family: "weight", factor: 1000 },
};
function measurement(value: string): { amount: number; unit: string } | undefined {
  const match = normal(value).match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|kg|m|g)\b/);
  return match ? { amount: Number(match[1]!.replace(",", ".")), unit: match[2]! } : undefined;
}
function amountEqual(a: { amount: number; unit: string }, b: { amount: number; unit: string }) {
  const aa = UNIT_FACTORS[a.unit],
    bb = UNIT_FACTORS[b.unit];
  return Boolean(
    aa && bb && aa.family === bb.family && a.amount * aa.factor === b.amount * bb.factor,
  );
}
const CURRENCIES: Record<string, string> = {
  "£": "GBP",
  $: "USD",
  "€": "EUR",
  gbp: "GBP",
  usd: "USD",
  eur: "EUR",
};
type ParsedPrice = { amount: number; currency?: string; mismatch?: boolean };
type PriceCandidate = ParsedPrice & { numberStart: number; numberEnd: number };
const PRICE_NUMBER = "\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const CURRENCY_TOKEN = "GBP\\b|USD\\b|EUR\\b|[£$€]";
function parsedPrice(raw: string, currencyTokens: string[]): ParsedPrice | undefined {
  const currencies = currencyTokens.map((token) => CURRENCIES[token.toLowerCase()]!);
  const amount = localeAmount(raw, currencies[0]);
  if (amount === undefined) return undefined;
  return {
    amount,
    ...(currencies[0] ? { currency: currencies[0] } : {}),
    ...(new Set(currencies).size > 1 ? { mismatch: true } : {}),
  };
}
function price(value: string): ParsedPrice | undefined {
  const candidates: PriceCandidate[] = [];
  const occupiedNumbers: Array<readonly [number, number]> = [];
  const currencyAdjacent = new RegExp(
    `(?:(?<![A-Za-z])(${CURRENCY_TOKEN})\\s*(${PRICE_NUMBER})(?:\\s*(${CURRENCY_TOKEN}))?|(${PRICE_NUMBER})\\s*(${CURRENCY_TOKEN}))`,
    "gi",
  );
  for (const match of value.matchAll(currencyAdjacent)) {
    const raw = match[2] ?? match[4]!;
    const relativeStart = match[0].indexOf(raw);
    const numberStart = match.index + relativeStart;
    const numberEnd = numberStart + raw.length;
    const parsed = parsedPrice(raw, [match[1], match[3], match[5]].filter(Boolean) as string[]);
    if (parsed) {
      candidates.push({ ...parsed, numberStart, numberEnd });
      occupiedNumbers.push([numberStart, numberEnd]);
    }
  }

  const costContext = new RegExp(
    `\\b(?:costs?|priced?\\s+at|price\\s*(?:is|of|:|-)?)\\s*(?:about|around|approximately)?\\s*(${PRICE_NUMBER})`,
    "gi",
  );
  for (const match of value.matchAll(costContext)) {
    const raw = match[1]!;
    const numberStart = match.index + match[0].lastIndexOf(raw);
    const numberEnd = numberStart + raw.length;
    if (occupiedNumbers.some(([start, end]) => start === numberStart && end === numberEnd))
      continue;
    const parsed = parsedPrice(raw, []);
    if (parsed) candidates.push({ ...parsed, numberStart, numberEnd });
  }

  // A range contains two plausible prices even when its currency/context is stated only once.
  for (const candidate of [...candidates]) {
    const followingRange = value
      .slice(candidate.numberEnd)
      .match(/^\s*(?:-|–|—|to)\s*(?:GBP|USD|EUR|[£$€])?\s*(\d+(?:[.,]\d+)?)/i);
    if (!followingRange) continue;
    const raw = followingRange[1]!;
    const parsed = parsedPrice(raw, candidate.currency ? [candidate.currency] : []);
    if (parsed)
      candidates.push({
        ...parsed,
        numberStart: candidate.numberEnd + followingRange[0].lastIndexOf(raw),
        numberEnd: candidate.numberEnd + followingRange[0].lastIndexOf(raw) + raw.length,
      });
  }

  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate) return undefined;
  const { numberStart: _start, numberEnd: _end, ...result } = candidate;
  return result;
}
function localeAmount(raw: string, currency?: string): number | undefined {
  const separators = [...raw].filter((character) => character === "," || character === ".");
  if (!separators.length) return Number(raw);
  const comma = raw.lastIndexOf(","),
    dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".",
      thousands = decimal === "," ? "." : ",",
      [whole, fraction, ...extra] = raw.split(decimal);
    if (
      extra.length ||
      !fraction ||
      fraction.length > 2 ||
      !new RegExp(`^\\d{1,3}(?:\\${thousands}\\d{3})+$`).test(whole!)
    )
      return undefined;
    return Number(`${whole!.split(thousands).join("")}.${fraction}`);
  }
  const separator = separators[0]!;
  if (separators.some((value) => value !== separator)) return undefined;
  const groups = raw.split(separator);
  if (groups.length > 2) {
    if (groups[0]!.length > 3 || groups.slice(1).some((group) => group.length !== 3))
      return undefined;
    return Number(groups.join(""));
  }
  const [whole, tail] = groups;
  if (!whole || !tail) return undefined;
  if (tail.length === 3 && whole.length <= 3) {
    const localeThousands =
      (separator === "," && (currency === "GBP" || currency === "USD")) ||
      (separator === "." && currency === "EUR");
    return localeThousands ? Number(`${whole}${tail}`) : undefined;
  }
  if (tail.length <= 2) return Number(`${whole}.${tail}`);
  return undefined;
}
function materialTokens(value: string) {
  return [...tokens(value)].filter(
    (token) => !["the", "with", "made", "from", "uses", "material", "and"].includes(token),
  );
}
function compare(
  type: string,
  claim: string,
  evidence: ExtractedValue,
): "verified" | "contradicted" | "missing" {
  if (type === "dimension") {
    const field = DIMENSION_FIELDS.find((name) =>
      new RegExp(name === "height" ? "\\b(?:height|high)\\b" : `\\b${name}\\b`, "i").test(claim),
    );
    if (!field || evidence.field !== field) return "missing";
    const a = measurement(claim),
      b = measurement(evidence.value);
    return !a || !b ? "missing" : amountEqual(a, b) ? "verified" : "contradicted";
  }
  if (type === "price") {
    const a = price(claim),
      b = price(evidence.value);
    if (!a || !b || a.mismatch || b.mismatch)
      return a?.mismatch || b?.mismatch ? "contradicted" : "missing";
    if (a.currency && b.currency && a.currency !== b.currency) return "contradicted";
    return a.amount === b.amount ? "verified" : "contradicted";
  }
  if (type === "material") {
    const expected = materialTokens(evidence.value);
    return expected.length && expected.every((token) => tokens(claim).has(token))
      ? "verified"
      : "contradicted";
  }
  if (type === "provenance") {
    const expected = materialTokens(evidence.value);
    return expected.length && expected.every((token) => tokens(claim).has(token))
      ? "verified"
      : "contradicted";
  }
  if (type === "delivery") {
    if (evidence.field === "availability") {
      const expected = availabilityState(evidence.value),
        stated = availabilityState(claim);
      if (expected === "unknown" || stated === "unknown") return "missing";
      return expected === stated ? "verified" : "contradicted";
    }
    const a = measurement(claim) ?? duration(claim),
      b = measurement(evidence.value) ?? duration(evidence.value);
    return !a || !b ? "missing" : amountEqual(a, b) ? "verified" : "contradicted";
  }
  return similarity(claim, evidence.value) >= 0.5 ? "verified" : "missing";
}
type Availability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "backorder"
  | "discontinued"
  | "unavailable"
  | "unknown";
function availabilityState(value: string): Availability {
  const text = normal(value).replace(/^https? schema org /, "");
  if (/\bnot\s+(?:in\s*stock|instock)\b/.test(text)) return "out_of_stock";
  if (/\bnot\s+(?:available|for\s+sale)\b/.test(text)) return "unavailable";
  if (/\bnot\s+(?:out\s*of\s*stock|pre\s*order|back\s*order|discontinued|unavailable)\b/.test(text))
    return "unknown";
  if (/\b(?:out\s*of\s*stock|outofstock|sold\s*out)\b/.test(text)) return "out_of_stock";
  if (/\b(?:pre\s*order|preorder)\b/.test(text)) return "preorder";
  if (/\b(?:back\s*order|backorder)\b/.test(text)) return "backorder";
  if (/\bdiscontinued\b/.test(text)) return "discontinued";
  if (/\bunavailable\b/.test(text)) return "unavailable";
  if (/\b(?:in\s*stock|instock|available)\b/.test(text)) return "in_stock";
  return "unknown";
}
function duration(value: string): { amount: number; unit: string } | undefined {
  const match = normal(value).match(/(\d+(?:[.,]\d+)?)\s*(days?|weeks?|months?|hours?)\b/);
  if (!match) return undefined;
  const factors: Record<string, number> = {
    hour: 1,
    hours: 1,
    day: 24,
    days: 24,
    week: 168,
    weeks: 168,
    month: 720,
    months: 720,
  };
  return { amount: Number(match[1]!.replace(",", ".")) * factors[match[2]!]!, unit: "g" };
}
function sourceValuesConflict(type: string, values: ExtractedValue[]): boolean {
  const decisivePairs = values.flatMap((left, index) =>
    values.slice(index + 1).map((right) => [left, right] as const),
  );
  return decisivePairs.some(([left, right]) => {
    if (type === "dimension" && left.field !== right.field) return false;
    if (type === "delivery" && left.field !== right.field) return false;
    if (type === "delivery" && left.field === "availability") {
      const a = availabilityState(left.value),
        b = availabilityState(right.value);
      return a !== "unknown" && b !== "unknown" && a !== b;
    }
    if (type === "price") {
      const a = price(left.value),
        b = price(right.value);
      return Boolean(
        a &&
        b &&
        (a.amount !== b.amount || (a.currency && b.currency && a.currency !== b.currency)),
      );
    }
    const a = measurement(left.value) ?? (type === "delivery" ? duration(left.value) : undefined);
    const b = measurement(right.value) ?? (type === "delivery" ? duration(right.value) : undefined);
    if (a && b) return !amountEqual(a, b);
    return normal(left.value) !== normal(right.value);
  });
}
function publicAddress(address: string): boolean {
  const value = address.toLowerCase().split("%")[0]!;
  if (isIP(value) === 4) {
    const octets = value.split(".").map(Number);
    const numeric = octets.reduce((result, octet) => (result * 256 + octet) >>> 0, 0);
    const denied: ReadonlyArray<readonly [number, number]> = [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ];
    return !denied.some(([prefix, bits]) => {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      return (numeric & mask) >>> 0 === (prefix & mask) >>> 0;
    });
  }
  if (isIP(value) !== 6) return false;
  return !(
    value === "::" ||
    value === "::1" ||
    value.startsWith("::ffff:") ||
    /^(?:fe[89ab]|f[cd]|ff)/.test(value) ||
    /^2001:(?:db8|0{0,4}:|0?2:|0?10:|0?20:)/.test(value) ||
    /^2002:/.test(value) ||
    /^3fff:/.test(value) ||
    /^5f00:/.test(value)
  );
}
function dedupe<T extends { stable_key: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.stable_key, item])).values()];
}

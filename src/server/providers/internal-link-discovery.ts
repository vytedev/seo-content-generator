import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { nodeHttpsPinnedFetcher, type PinnedFetcher } from "./public-page-retriever.js";
import type { Pool } from "pg";
import { z } from "zod";
import {
  INTERNAL_LINK_HIERARCHY_RANK,
  InternalLinkHierarchySchema,
} from "../../shared/checker/contracts.js";
import {
  InternalLinkSchema,
  LiveInternalLinkSchema,
  canonicalHash,
  type InternalLink,
  type LinkDiscoveryCounts,
  type LinkDiscoveryMetadata,
} from "../../shared/milestone-two.js";
import { canonicaliseInternalUrl } from "../../shared/internal-link-url.js";
import { isCanonicalProductRoute } from "../../shared/product-route.js";
import type {
  DraftLinkVerifier,
  LinkVerificationOutcome,
} from "../../shared/link-conversion-review.js";
import { GOOGLE_GSC_SCOPES, type GoogleOAuthClient } from "./google-oauth.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_SITEMAP_URLS = 10_000;
const MAX_SITEMAP_DOCUMENTS = 100;
const MAX_SITEMAP_DEPTH = 3;
const MAX_PRESELECT = 100;
const MIN_PRESELECT_PER_HIERARCHY = 25;
const VERIFY_CONCURRENCY = 5;
const DISCOVERY_POLICY_VERSION =
  "internal-link-discovery-v7-flat-products-diverse-hierarchy-verification";
type ResolvedAddress = { address: string; family?: number };
type PublicResolver = (hostname: string) => Promise<readonly ResolvedAddress[] | void>;
const integerSetting = (
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

const gscResponseSchema = z.object({
  rows: z
    .array(
      z.object({
        keys: z.tuple([z.string().min(1), z.string().url()]),
        clicks: z.number().nonnegative(),
        impressions: z.number().nonnegative(),
      }),
    )
    .max(25000)
    .optional(),
});

export interface LinkDiscoveryConfig {
  sitemapUrl: string;
  siteOrigin: string;
  gscSiteUrl?: string;
  allowedOrigins: readonly string[];
  cacheTtlMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxSitemapUrls: number;
}

export function linkDiscoveryConfigFromEnv(
  env: NodeJS.ProcessEnv,
): LinkDiscoveryConfig | undefined {
  const sitemapUrl = env.INTERNAL_LINK_SITEMAP_URL?.trim() ?? "";
  const origin = env.INTERNAL_LINK_SITE_ORIGIN?.trim() ?? "";
  const gscSiteUrl = env.GSC_SITE_URL?.trim() ?? "";
  const allowedRaw = env.INTERNAL_LINK_ALLOWED_ORIGINS?.trim() ?? "";
  const optionalSettings = [
    env.INTERNAL_LINK_CACHE_TTL_SECONDS,
    env.INTERNAL_LINK_REQUEST_TIMEOUT_MS,
    env.INTERNAL_LINK_MAX_RESPONSE_BYTES,
    env.INTERNAL_LINK_MAX_SITEMAP_URLS,
  ];
  if (
    ![sitemapUrl, origin, gscSiteUrl, allowedRaw, ...optionalSettings].some((value) =>
      value?.trim(),
    )
  )
    return undefined;
  if (!sitemapUrl || !origin || !allowedRaw)
    throw new Error("Internal-link discovery configuration is incomplete.");
  const parsedSitemap = requirePublicHttpsUrl(sitemapUrl);
  const parsedOrigin = requirePublicHttpsUrl(origin);
  if (parsedOrigin.toString() !== `${parsedOrigin.origin}/`)
    throw new Error("INTERNAL_LINK_SITE_ORIGIN must be an exact HTTPS origin.");
  const allowedOrigins = [
    ...new Set(allowedRaw.split(",").map((item) => requireExactOrigin(item.trim()).origin)),
  ];
  if (
    !allowedOrigins.includes(parsedSitemap.origin) ||
    !allowedOrigins.includes(parsedOrigin.origin) ||
    parsedSitemap.origin !== parsedOrigin.origin
  )
    throw new Error(
      "INTERNAL_LINK_ALLOWED_ORIGINS must include the sitemap/internal site origin, and the sitemap must use that exact origin.",
    );
  if (gscSiteUrl) {
    validateGscProperty(gscSiteUrl);
    if (!allowedOrigins.includes("https://searchconsole.googleapis.com"))
      throw new Error(
        "INTERNAL_LINK_ALLOWED_ORIGINS must include the Search Console API origin when GSC is configured.",
      );
  }
  return {
    sitemapUrl: parsedSitemap.toString(),
    siteOrigin: parsedOrigin.origin,
    ...(gscSiteUrl ? { gscSiteUrl } : {}),
    allowedOrigins,
    cacheTtlMs:
      integerSetting(
        env.INTERNAL_LINK_CACHE_TTL_SECONDS,
        DEFAULT_TTL_MS / 1000,
        60,
        86400,
        "INTERNAL_LINK_CACHE_TTL_SECONDS",
      ) * 1000,
    requestTimeoutMs: integerSetting(
      env.INTERNAL_LINK_REQUEST_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      30000,
      "INTERNAL_LINK_REQUEST_TIMEOUT_MS",
    ),
    maxResponseBytes: integerSetting(
      env.INTERNAL_LINK_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_BYTES,
      1024,
      5 * 1024 * 1024,
      "INTERNAL_LINK_MAX_RESPONSE_BYTES",
    ),
    maxSitemapUrls: integerSetting(
      env.INTERNAL_LINK_MAX_SITEMAP_URLS,
      DEFAULT_MAX_SITEMAP_URLS,
      1,
      50_000,
      "INTERNAL_LINK_MAX_SITEMAP_URLS",
    ),
  };
}

function validateGscProperty(value: string): void {
  if (value.startsWith("sc-domain:")) {
    if (!/^sc-domain:[a-z0-9.-]+$/i.test(value))
      throw new Error("GSC_SITE_URL must be an HTTPS URL-prefix or sc-domain property.");
  } else if (requirePublicHttpsUrl(value).protocol !== "https:")
    throw new Error("GSC_SITE_URL must be an HTTPS URL-prefix or sc-domain property.");
}
function requireExactOrigin(value: string): URL {
  const url = requirePublicHttpsUrl(value);
  if (url.toString() !== `${url.origin}/`)
    throw new Error("Allowed origins must be exact HTTPS origins.");
  return url;
}
function requirePublicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Discovery URLs must be credential-free HTTPS URLs on the default port.");
  if (url.hostname === "localhost" || isPrivateAddress(url.hostname))
    throw new Error("Discovery URLs must use a public host.");
  return url;
}
function ipv6Bytes(value: string): Uint8Array | undefined {
  let input = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  const dotted = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) return undefined;
    input = `${input.slice(0, -dotted.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  if (input.split("::").length > 2) return undefined;
  const [leftRaw, rightRaw] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0))
    return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group)))
    return undefined;
  return Uint8Array.from(
    groups.flatMap((group) => {
      const number = Number.parseInt(group, 16);
      return [number >>> 8, number & 0xff];
    }),
  );
}
function prefixMatches(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let index = 0; index < whole; index++) if (bytes[index] !== prefix[index]) return false;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[whole] ?? 0) & mask) === ((prefix[whole] ?? 0) & mask);
}
export function isPrivateAddress(value: string): boolean {
  const normal = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  const version = isIP(normal);
  if (version === 4) {
    const [a, b] = normal.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (version !== 6) return false;
  const bytes = ipv6Bytes(normal);
  if (!bytes) return true;
  if (prefixMatches(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96))
    return isPrivateAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  const denied: ReadonlyArray<readonly [readonly number[], number]> = [
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
    [[0x01, 0x00], 64],
    [[0x20, 0x01, 0x00, 0x00], 32],
    [[0x20, 0x01, 0x00, 0x02], 48],
    [[0x20, 0x01, 0x00, 0x10], 28],
    [[0x20, 0x01, 0x00, 0x20], 28],
    [[0x20, 0x01, 0x0d, 0xb8], 32],
    [[0x20, 0x02], 16],
    [[0x3f, 0xff], 20],
    [[0x5f, 0x00], 16],
    [[0xfc], 7],
    [[0xfe, 0x80], 10],
    [[0xff], 8],
  ];
  return denied.some(([prefix, bits]) => prefixMatches(bytes, prefix, bits));
}
function assertPublicAddresses(
  records: readonly ResolvedAddress[] | void,
): readonly ResolvedAddress[] | void {
  if (records?.length && records.some((record) => isPrivateAddress(record.address)))
    throw new Error("Discovery host did not resolve exclusively to public addresses.");
  return records;
}
async function assertPublicDns(hostname: string): Promise<readonly ResolvedAddress[]> {
  const records = await Promise.race([
    dns.lookup(hostname, { all: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS lookup timed out")), 2000),
    ),
  ]);
  if (!records.length || records.some((record) => isPrivateAddress(record.address)))
    throw new Error("Discovery host did not resolve exclusively to public addresses.");
  return records;
}

class SafeRequestError extends Error {
  constructor(readonly retryable: boolean) {
    super("safe provider request failed");
  }
}

interface NetworkBounds {
  allowedOrigins: readonly string[];
  timeoutMs: number;
  maxBytes: number;
}
async function safeJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  bounds: NetworkBounds,
  resolvePublic: PublicResolver,
  pinnedFetcher: PinnedFetcher,
): Promise<unknown> {
  if (!bounds.allowedOrigins.includes(url.origin))
    throw new Error("Provider origin is not explicitly allowed.");
  const deadline = Date.now() + bounds.timeoutMs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const records = assertPublicAddresses(await resolvePublic(url.hostname));
      const response = records?.length
        ? await pinnedFetcher({
            url,
            addresses: records.map((record) => record.address),
            signal: controller.signal,
            init,
          })
        : await fetchImpl(url, {
            ...init,
            redirect: "error",
            signal: controller.signal,
          });
      if (!response.ok) {
        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (attempt === 0 && retryable) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
          );
          continue;
        }
        throw new SafeRequestError(false);
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
        throw new SafeRequestError(false);
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(response, bounds.maxBytes);
      } catch {
        throw new SafeRequestError(false);
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (
        attempt === 0 &&
        !(error instanceof SyntaxError) &&
        !(error instanceof SafeRequestError && !error.retryable) &&
        Date.now() < deadline
      )
        continue;
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  // Never propagate upstream fetch details or bearer-token-bearing request metadata.
  throw new Error("Provider request failed safely.");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface SitemapCandidate {
  url: string;
  sitemapUrl: string;
  lastModified?: string;
}
export interface SearchCandidate {
  url: string;
  clicks: number;
  impressions: number;
  queries: string[];
  property?: string;
  startDate?: string;
  endDate?: string;
}
async function safeXml(
  fetchImpl: typeof fetch,
  url: URL,
  bounds: NetworkBounds,
  resolvePublic: PublicResolver,
  pinnedFetcher: PinnedFetcher,
): Promise<string> {
  if (!bounds.allowedOrigins.includes(url.origin))
    throw new Error("Sitemap origin is not explicitly allowed.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
  try {
    const records = assertPublicAddresses(await resolvePublic(url.hostname));
    const response = records?.length
      ? await pinnedFetcher({
          url,
          addresses: records.map((record) => record.address),
          signal: controller.signal,
          init: { method: "GET", headers: { Accept: "application/xml,text/xml" } },
        })
      : await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/xml,text/xml" },
          redirect: "error",
          signal: controller.signal,
        });
    if (response.status !== 200) throw new Error("Sitemap request did not return HTTP 200.");
    const xml = new TextDecoder().decode(await readBoundedBody(response, bounds.maxBytes));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe XML constructs are forbidden.");
    parseSitemapXml(xml);
    return xml;
  } finally {
    clearTimeout(timer);
  }
}

interface XmlElement {
  name: string;
  localName: string;
  namespace: string | null;
  attributes: ReadonlyMap<string, string>;
  children: XmlElement[];
  text: string;
}
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

function decodeXmlText(value: string): string {
  return value.replace(/&([^;]+);/g, (_match, entity: string) => {
    const predefined: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (predefined[entity]) return predefined[entity];
    const numeric = entity.match(/^#(x[0-9a-f]+|[0-9]+)$/i);
    if (!numeric) throw new Error("Unknown or malformed XML entity.");
    const point = Number.parseInt(
      numeric[1]!.replace(/^x/i, ""),
      /^x/i.test(numeric[1]!) ? 16 : 10,
    );
    if (
      !Number.isSafeInteger(point) ||
      point === 0 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff) ||
      (point < 0x20 && ![0x9, 0xa, 0xd].includes(point))
    )
      throw new Error("Invalid XML character reference.");
    return String.fromCodePoint(point);
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let rest = source;
  while (rest.trim()) {
    const match = rest.match(/^\s+([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/);
    if (
      !match ||
      !XML_NAME.test(match[1]!) ||
      /[<&]/.test(match[3]!.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));/gi, ""))
    )
      throw new Error("Malformed XML attribute.");
    if (attributes.has(match[1]!)) throw new Error("Duplicate XML attribute.");
    attributes.set(match[1]!, decodeXmlText(match[3]!));
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

function parseSitemapXml(xml: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe XML constructs are forbidden.");
  const document = { children: [] as XmlElement[], text: "" };
  const stack: Array<XmlElement | typeof document> = [document];
  let cursor = 0;
  let declarationSeen = false;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const text = xml.slice(cursor, open < 0 ? xml.length : open);
    if (text) {
      if (/[^\t\n\r ]/.test(text) && stack.length === 1)
        throw new Error("XML text is not allowed outside the document root.");
      if (stack.length > 1) (stack.at(-1)! as XmlElement).text += decodeXmlText(text);
    }
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0 || xml.slice(open + 4, end).includes("--"))
        throw new Error("Malformed XML comment.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open))
      throw new Error("CDATA is not supported in sitemap XML.");
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      const declaration = end < 0 ? "" : xml.slice(open, end + 2);
      if (
        end < 0 ||
        open !== 0 ||
        declarationSeen ||
        !/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?\s*\?>$/i.test(
          declaration,
        )
      )
        throw new Error("Malformed or misplaced XML declaration.");
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }
    const end = xml.indexOf(">", open + 1);
    if (end < 0) throw new Error("Malformed sitemap XML.");
    const raw = xml.slice(open + 1, end);
    if (raw.includes("<") || /^!/.test(raw)) throw new Error("Unsupported XML markup.");
    const closing = raw.match(/^\/\s*([^\s]+)\s*$/);
    if (closing) {
      const current = stack.pop();
      if (
        stack.length === 0 ||
        !XML_NAME.test(closing[1]!) ||
        !current ||
        current === document ||
        !("name" in current) ||
        current.name !== closing[1]
      )
        throw new Error("Malformed sitemap XML.");
      cursor = end + 1;
      continue;
    }
    const selfClosing = /\/\s*$/.test(raw);
    const content = selfClosing ? raw.replace(/\/\s*$/, "") : raw;
    const opening = content.match(/^\s*([^\s/]+)([\s\S]*)$/);
    if (!opening || !XML_NAME.test(opening[1]!)) throw new Error("Malformed sitemap XML.");
    const attributes = parseAttributes(opening[2]!);
    const parent = stack.at(-1)!;
    const inherited =
      parent === document ? new Map<string, string>() : new Map((parent as XmlElement).attributes);
    for (const [name, value] of attributes)
      if (name === "xmlns" || name.startsWith("xmlns:")) inherited.set(name, value);
    const [prefix, localName] = opening[1]!.includes(":")
      ? opening[1]!.split(":")
      : [undefined, opening[1]!];
    const namespace = inherited.get(prefix ? `xmlns:${prefix}` : "xmlns") ?? null;
    if (prefix && !namespace) throw new Error("Undeclared XML namespace prefix.");
    for (const name of attributes.keys()) {
      const attributePrefix = name.includes(":") ? name.split(":")[0] : undefined;
      if (
        attributePrefix &&
        attributePrefix !== "xmlns" &&
        !inherited.has(`xmlns:${attributePrefix}`)
      )
        throw new Error("Undeclared XML attribute namespace prefix.");
    }
    const element: XmlElement = {
      name: opening[1]!,
      localName: localName!,
      namespace,
      attributes: inherited,
      children: [],
      text: "",
    };
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
    cursor = end + 1;
  }
  if (stack.length !== 1 || document.children.length !== 1)
    throw new Error("Sitemap XML must contain exactly one document root.");
  const root = document.children[0]!;
  if (
    !new Set(["sitemapindex", "urlset"]).has(root.localName) ||
    root.namespace !== SITEMAP_NAMESPACE
  )
    throw new Error("Sitemap root must be sitemapindex or urlset in the sitemap namespace.");
  validateSitemapStructure(root);
  return root;
}

function directCoreChildren(element: XmlElement, localName: string): XmlElement[] {
  return element.children.filter(
    (child) => child.localName === localName && child.namespace === element.namespace,
  );
}
function directText(element: XmlElement, localName: string): string | undefined {
  const matches = directCoreChildren(element, localName);
  if (matches.length > 1)
    throw new Error(`Sitemap ${localName} must occur at most once per entry.`);
  const match = matches[0];
  if (!match) return undefined;
  if (match.children.length) throw new Error(`Sitemap ${localName} must contain text only.`);
  return match.text.trim() || undefined;
}
/**
 * Standard sitemap extension namespaces tolerated inside <url>/<sitemap> entries
 * (hreflang alternates and image/video metadata). Their content is ignored for
 * candidate extraction - only core sitemap-namespace fields are read.
 */
const SITEMAP_EXTENSION_NAMESPACES = new Set([
  "http://www.w3.org/1999/xhtml",
  "http://www.google.com/schemas/sitemap-image/1.1",
  "http://www.google.com/schemas/sitemap-video/1.1",
  "http://www.google.com/schemas/sitemap-mobile/1.0",
]);
function validateSitemapStructure(root: XmlElement): void {
  if (/[^\t\n\r ]/.test(root.text)) throw new Error("Unexpected text in sitemap root.");
  const entryName = root.localName === "sitemapindex" ? "sitemap" : "url";
  for (const child of root.children) {
    if (child.namespace !== SITEMAP_NAMESPACE || child.localName !== entryName)
      throw new Error(`Invalid ${root.localName} child namespace or structure.`);
    if (/[^\t\n\r ]/.test(child.text)) throw new Error(`Unexpected text in sitemap ${entryName}.`);
    const locations = directCoreChildren(child, "loc");
    if (locations.length !== 1 || !directText(child, "loc"))
      throw new Error(`Each sitemap ${entryName} requires exactly one direct loc.`);
    for (const field of child.children) {
      if (field.namespace !== null && SITEMAP_EXTENSION_NAMESPACES.has(field.namespace)) continue;
      if (
        field.namespace !== SITEMAP_NAMESPACE ||
        !new Set(["loc", "lastmod", "changefreq", "priority"]).has(field.localName)
      )
        throw new Error(`Invalid sitemap ${entryName} child namespace or structure.`);
      if (field.children.length)
        throw new Error(`Sitemap ${field.localName} must contain text only.`);
    }
  }
}

export class SitemapClient {
  constructor(
    private readonly config: LinkDiscoveryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolvePublic: PublicResolver = assertPublicDns,
    private readonly pinnedFetcher: PinnedFetcher = nodeHttpsPinnedFetcher,
  ) {}
  async listUrls(): Promise<SitemapCandidate[]> {
    const queue = [{ url: this.config.sitemapUrl, depth: 0 }];
    const visited = new Set<string>();
    const candidates = new Map<string, SitemapCandidate>();
    while (queue.length && visited.size < MAX_SITEMAP_DOCUMENTS) {
      const item = queue.shift()!;
      const sitemap = canonicalUrl(item.url, this.config.siteOrigin, this.config.allowedOrigins);
      const key = sitemap.toString();
      if (visited.has(key)) continue;
      visited.add(key);
      const xml = await safeXml(
        this.fetchImpl,
        sitemap,
        this.bounds(),
        this.resolvePublic,
        this.pinnedFetcher,
      );
      const root = parseSitemapXml(xml);
      if (root.localName === "sitemapindex") {
        const entries = directCoreChildren(root, "sitemap");
        if (entries.length && item.depth >= MAX_SITEMAP_DEPTH)
          throw new Error("Sitemap nesting depth bound exceeded.");
        for (const entry of entries) {
          const nested = canonicalUrl(
            directText(entry, "loc")!,
            this.config.siteOrigin,
            this.config.allowedOrigins,
          ).toString();
          if (visited.has(nested) || queue.some((queued) => queued.url === nested)) continue;
          if (visited.size + queue.length >= MAX_SITEMAP_DOCUMENTS)
            throw new Error("Sitemap document bound exceeded.");
          queue.push({ url: nested, depth: item.depth + 1 });
        }
        continue;
      }
      for (const entry of directCoreChildren(root, "url")) {
        const url = canonicalUrl(
          directText(entry, "loc")!,
          this.config.siteOrigin,
          this.config.allowedOrigins,
        ).toString();
        if (!candidates.has(url)) {
          if (candidates.size >= this.config.maxSitemapUrls)
            throw new Error("Sitemap URL bound exceeded.");
          const lastmod = directText(entry, "lastmod");
          let lastModified: string | undefined;
          if (lastmod && !Number.isNaN(Date.parse(lastmod)))
            lastModified = new Date(lastmod).toISOString();
          candidates.set(url, { url, sitemapUrl: key, ...(lastModified ? { lastModified } : {}) });
        }
      }
    }
    return [...candidates.values()];
  }
  private bounds(): NetworkBounds {
    return {
      allowedOrigins: this.config.allowedOrigins,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
    };
  }
}

export class GscSearchAnalyticsClient {
  constructor(
    private readonly oauth: GoogleOAuthClient,
    private readonly siteUrl: string,
    private readonly config: LinkDiscoveryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolvePublic: PublicResolver = assertPublicDns,
    private readonly now = () => new Date(),
    private readonly pinnedFetcher: PinnedFetcher = nodeHttpsPinnedFetcher,
  ) {}
  async pages(primaryKeyword: string): Promise<SearchCandidate[]> {
    const token = await this.oauth.accessToken(GOOGLE_GSC_SCOPES);
    const url = new URL(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`,
    );
    const keyword = normalise(primaryKeyword);
    const body = {
      startDate: isoDay(this.now(), -90),
      endDate: isoDay(this.now(), -1),
      dimensions: ["query", "page"],
      dimensionFilterGroups: [
        { filters: [{ dimension: "query", operator: "contains", expression: keyword }] },
      ],
      rowLimit: 25000,
    };
    const parsed = gscResponseSchema.parse(
      await safeJson(
        this.fetchImpl,
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        {
          allowedOrigins: this.config.allowedOrigins,
          timeoutMs: this.config.requestTimeoutMs,
          maxBytes: this.config.maxResponseBytes,
        },
        this.resolvePublic,
        this.pinnedFetcher,
      ),
    );
    const pages = new Map<string, SearchCandidate>();
    for (const row of parsed.rows ?? []) {
      if (!queryRelated(row.keys[0], keyword)) continue;
      const existing = pages.get(row.keys[1]);
      if (existing) {
        existing.clicks += row.clicks;
        existing.impressions += row.impressions;
        if (!existing.queries.includes(row.keys[0])) existing.queries.push(row.keys[0]);
      } else
        pages.set(row.keys[1], {
          url: row.keys[1],
          clicks: row.clicks,
          impressions: row.impressions,
          queries: [row.keys[0]],
        });
    }
    return [...pages.values()].map((page) => ({
      ...page,
      property: this.siteUrl,
      startDate: body.startDate,
      endDate: body.endDate,
      queries: page.queries.sort((a, b) => a.localeCompare(b, "en-GB")),
    }));
  }
}
function isoDay(now: Date, offset: number): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function queryRelated(query: string, keyword: string): boolean {
  const terms = normalise(keyword).split(" ").filter(Boolean);
  const queryTerms = new Set(normalise(query).split(" "));
  return terms.length > 0 && terms.every((term) => queryTerms.has(term));
}

export interface Verification {
  status: 200;
  verifiedAt: string;
  hierarchy: z.infer<typeof InternalLinkHierarchySchema>;
  method: "head" | "get";
}
export class SafeUrlVerifier {
  constructor(
    private readonly config: Pick<
      LinkDiscoveryConfig,
      "siteOrigin" | "allowedOrigins" | "requestTimeoutMs"
    >,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => new Date(),
    private readonly resolvePublic: PublicResolver = assertPublicDns,
    private readonly pinnedFetcher: PinnedFetcher = nodeHttpsPinnedFetcher,
  ) {}
  async verify(value: string): Promise<Verification> {
    const outcome = await this.verifyOutcome(value);
    if (outcome.outcome !== "direct_200")
      throw new Error("Candidate verification did not return HTTP 200.");
    return {
      status: 200,
      method: outcome.method,
      verifiedAt: outcome.verified_at,
      hierarchy: outcome.hierarchy,
    };
  }

  /** Shared SSRF-safe transport used by discovery and the Step 1.8 audit. */
  async verifyOutcome(value: string): Promise<LinkVerificationOutcome> {
    let url: URL;
    try {
      url = canonicalUrl(value, this.config.siteOrigin, this.config.allowedOrigins);
    } catch {
      return { outcome: "unresolved_transport", reason: "unsafe" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const records = assertPublicAddresses(await this.resolvePublic(url.hostname));
      const request = (init: RequestInit) =>
        records?.length
          ? this.pinnedFetcher({
              url,
              addresses: records.map((record) => record.address),
              signal: controller.signal,
              init,
            })
          : this.fetchImpl(url, init);
      let method: "head" | "get" = "head";
      let response = await request({
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html" },
      });
      if (response.status === 405 || response.status === 501) {
        method = "get";
        response = await request({
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "text/html", Range: `bytes=0-${DEFAULT_MAX_BYTES - 1}` },
        });
      }
      if (response.status >= 300 && response.status < 400)
        return {
          outcome: "redirect",
          method,
          status: response.status,
          ...(response.headers.get("location")
            ? { location: response.headers.get("location")! }
            : {}),
        };
      if (response.status !== 200)
        return { outcome: "confirmed_non_200", method, status: response.status };
      // The fallback body is relevant only to a successful direct GET. Classify
      // redirects and failures from their status without consuming their bodies.
      if (method === "get") await readBoundedBody(response, DEFAULT_MAX_BYTES);
      return {
        outcome: "direct_200",
        method,
        verified_at: this.now().toISOString(),
        hierarchy: classifyHierarchy(url),
      };
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return { outcome: "unresolved_transport", reason: timeout ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LiveDraftLinkVerifier implements DraftLinkVerifier {
  constructor(private readonly safeVerifier: SafeUrlVerifier) {}
  verify(url: string): Promise<LinkVerificationOutcome> {
    return this.safeVerifier.verifyOutcome(url);
  }
}
function canonicalUrl(value: string, origin: string, allowedOrigins: readonly string[]): URL {
  const canonical = canonicaliseInternalUrl(value, [origin]);
  if (!canonical) throw new Error("Candidate URL is outside the configured internal origin.");
  const url = requirePublicHttpsUrl(canonical);
  if (!allowedOrigins.includes(url.origin))
    throw new Error("Candidate URL is outside the configured internal origin.");
  return url;
}
function classifyHierarchy(url: URL): z.infer<typeof InternalLinkHierarchySchema> {
  const path = url.pathname.toLowerCase();
  if (path === "/") return "homepage";
  if (/\/designers?\//.test(path)) return "designer_hub";
  if (isCanonicalProductRoute(url)) return "product";
  const segments = path.split("/").filter(Boolean);
  if (segments.includes("collections"))
    return segments.length > 2 ? "sub_collection" : "collection";
  return "broad_category";
}
function isCommercialHierarchy(value: z.infer<typeof InternalLinkHierarchySchema>): boolean {
  return value !== "homepage" && value !== "broad_category";
}

function emptyDiscoveryCounts(): LinkDiscoveryCounts {
  return {
    ghost_collected: 0,
    sitemap_collected: 0,
    gsc_collected: 0,
    deduplicated: 0,
    commercial: 0,
    editorial: 0,
    verification_attempted: 0,
    verification_omitted_bound: 0,
    verification_omitted_deadline: 0,
    direct_200: 0,
    rejected_non_200: 0,
    unresolved: 0,
    shortlisted: 0,
  };
}

export interface DiscoveryOutcome {
  availability: "available" | "partial" | "stale" | "unavailable";
  eligibility: "eligible" | "blocked";
  reason:
    | "verified_commercial_candidates"
    | "source_unavailable"
    | "no_candidates"
    | "editorial_only"
    | "verification_failed";
  links: InternalLink[];
  providerStatus: {
    sitemap: "available" | "unavailable" | "not_configured";
    gsc: "available" | "unavailable" | "not_configured" | "not_connected";
  };
  counts: LinkDiscoveryCounts;
  retrievedAt?: string;
}
const countsSchema = z
  .object({
    ghost_collected: z.number().int().nonnegative().default(0),
    sitemap_collected: z.number().int().nonnegative().default(0),
    gsc_collected: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    commercial: z.number().int().nonnegative(),
    editorial: z.number().int().nonnegative(),
    verification_attempted: z.number().int().nonnegative(),
    verification_omitted_bound: z.number().int().nonnegative().default(0),
    verification_omitted_deadline: z.number().int().nonnegative().default(0),
    direct_200: z.number().int().nonnegative(),
    rejected_non_200: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    shortlisted: z.number().int().nonnegative(),
  })
  .strict();
const discoveryOutcomeSchema = z
  .object({
    availability: z.enum(["available", "partial", "stale", "unavailable"]),
    eligibility: z.enum(["eligible", "blocked"]).default("blocked"),
    reason: z
      .enum([
        "verified_commercial_candidates",
        "source_unavailable",
        "no_candidates",
        "editorial_only",
        "verification_failed",
      ])
      .default("no_candidates"),
    links: z.array(LiveInternalLinkSchema),
    providerStatus: z
      .object({
        sitemap: z.enum(["available", "unavailable", "not_configured"]),
        gsc: z.enum(["available", "unavailable", "not_configured", "not_connected"]),
      })
      .strict(),
    counts: countsSchema.default({
      ghost_collected: 0,
      sitemap_collected: 0,
      gsc_collected: 0,
      deduplicated: 0,
      commercial: 0,
      editorial: 0,
      verification_attempted: 0,
      verification_omitted_bound: 0,
      verification_omitted_deadline: 0,
      direct_200: 0,
      rejected_non_200: 0,
      unresolved: 0,
      shortlisted: 0,
    }),
    retrievedAt: z.string().datetime().optional(),
  })
  .strict();
interface CacheRow {
  id: string;
  payload: unknown;
  expires_at: Date;
  retrieved_at: Date;
}
export interface CacheEntry {
  id: string;
  fresh: boolean;
  outcome: DiscoveryOutcome;
  retrievedAt: Date;
}
export class PostgresLinkDiscoveryCache {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now = () => new Date(),
  ) {}
  async read(key: string, requestHash: string): Promise<CacheEntry | null> {
    const result = await this.pool.query<CacheRow>(
      `select id,payload,expires_at,retrieved_at from link_discovery_cache where cache_key=$1 and request_hash=$2`,
      [key, requestHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      fresh: row.expires_at.getTime() > this.now().getTime(),
      outcome: discoveryOutcomeSchema.parse(row.payload) as DiscoveryOutcome,
      retrievedAt: row.retrieved_at,
    };
  }
}

export function linkDiscoveryConfigIdentity(config: LinkDiscoveryConfig): string {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return hash({
    policy_version: DISCOVERY_POLICY_VERSION,
    sitemap_url: new URL(config.sitemapUrl).toString(),
    site_origin: config.siteOrigin,
    gsc_property: config.gscSiteUrl ?? null,
    allowed_origins: [...config.allowedOrigins].sort(),
    cache_ttl_ms: config.cacheTtlMs,
    request_timeout_ms: config.requestTimeoutMs,
    max_response_bytes: config.maxResponseBytes,
    max_sitemap_urls: config.maxSitemapUrls,
    max_sitemap_documents: MAX_SITEMAP_DOCUMENTS,
    max_sitemap_depth: MAX_SITEMAP_DEPTH,
    max_preselect: MAX_PRESELECT,
    verify_concurrency: VERIFY_CONCURRENCY,
  });
}

type DiscoveryResult = DiscoveryOutcome &
  Pick<LinkDiscoveryMetadata, "cache" | "identity"> & {
    cacheId?: string;
    cacheWrite?: NonNullable<LinkDiscoveryMetadata["cacheWrite"]>;
  };

export class LiveInternalLinkDiscoverer {
  constructor(
    private readonly config: LinkDiscoveryConfig,
    private readonly sitemap: SitemapClient,
    private readonly verifier: SafeUrlVerifier,
    private readonly cache: Pick<PostgresLinkDiscoveryCache, "read">,
    private readonly gsc?: GscSearchAnalyticsClient,
    private readonly now = () => new Date(),
  ) {}
  async discover(
    primaryKeyword: string,
    options: { refresh?: boolean } = {},
  ): Promise<DiscoveryResult> {
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const queryHash = hash(normalise(primaryKeyword));
    const configHash = linkDiscoveryConfigIdentity(this.config);
    const originPolicyHash = hash({
      policy_version: DISCOVERY_POLICY_VERSION,
      site_origin: this.config.siteOrigin,
      allowed_origins: [...this.config.allowedOrigins].sort(),
      direct_status: 200,
      redirects: "forbidden",
      verifier_methods: ["HEAD", "GET"],
      verify_concurrency: VERIFY_CONCURRENCY,
      max_preselect: MAX_PRESELECT,
    });
    const requestHash = hash({ queryHash, configHash, originPolicyHash });
    const identity = {
      query_hash: queryHash,
      config_hash: configHash,
      origin_policy_hash: originPolicyHash,
      request_hash: requestHash,
    };
    const cached = await this.cache.read("internal-links:v2", requestHash);
    const cachedOutcome = cached
      ? (discoveryOutcomeSchema.parse(cached.outcome) as DiscoveryOutcome)
      : undefined;
    if (cached?.fresh && cachedOutcome && !options.refresh)
      return {
        ...cachedOutcome,
        cacheId: cached.id,
        identity,
        cache: {
          state: "fresh",
          retrieved_at: (
            cached.retrievedAt ?? new Date(cachedOutcome.retrievedAt ?? this.now())
          ).toISOString(),
          expires_at: new Date(
            (cached.retrievedAt ?? new Date(cachedOutcome.retrievedAt ?? this.now())).getTime() +
              this.config.cacheTtlMs,
          ).toISOString(),
        },
      };
    const [sitemapResult, gscResult] = await Promise.allSettled([
      this.sitemap.listUrls(),
      this.gsc
        ? this.gsc.pages(primaryKeyword)
        : this.config.gscSiteUrl
          ? Promise.reject(new Error("GSC OAuth connection is unavailable"))
          : Promise.resolve([]),
    ]);
    const providerStatus: DiscoveryOutcome["providerStatus"] = {
      sitemap: sitemapResult.status === "fulfilled" ? "available" : "unavailable",
      gsc: this.config.gscSiteUrl
        ? this.gsc
          ? gscResult.status === "fulfilled"
            ? "available"
            : "unavailable"
          : "not_connected"
        : "not_configured",
    };
    const configuredFailure = providerStatus.sitemap === "unavailable";
    const gscFailure =
      providerStatus.gsc === "unavailable" || providerStatus.gsc === "not_connected";
    if (configuredFailure && providerStatus.gsc !== "available" && cached && cachedOutcome)
      return {
        availability: "stale",
        eligibility: "blocked",
        reason: "source_unavailable",
        links: [],
        providerStatus,
        counts: emptyDiscoveryCounts(),
        identity,
        cache: {
          state: "stale",
          retrieved_at: (
            cached.retrievedAt ?? new Date(cachedOutcome.retrievedAt ?? this.now())
          ).toISOString(),
          expires_at: new Date(
            (cached.retrievedAt ?? new Date(cachedOutcome.retrievedAt ?? this.now())).getTime() +
              this.config.cacheTtlMs,
          ).toISOString(),
        },
      };

    if (providerStatus.sitemap === "unavailable" && providerStatus.gsc !== "available")
      return {
        availability: "unavailable",
        eligibility: "blocked",
        reason: "source_unavailable",
        links: [],
        providerStatus,
        counts: emptyDiscoveryCounts(),
        identity,
        cache: { state: cached ? "stale" : "miss", retrieved_at: null, expires_at: null },
      };
    const retrievedAt = this.now().toISOString();
    const merged = await mergeAndVerifyDetailed(
      primaryKeyword,
      this.config,
      sitemapResult.status === "fulfilled" ? sitemapResult.value : [],
      gscResult.status === "fulfilled" ? gscResult.value : [],
      this.verifier,
      retrievedAt,
    );
    const reason: DiscoveryOutcome["reason"] = merged.links.length
      ? "verified_commercial_candidates"
      : merged.counts.deduplicated === 0
        ? "no_candidates"
        : merged.counts.commercial === 0
          ? "editorial_only"
          : "verification_failed";
    const outcome: DiscoveryOutcome = {
      availability: configuredFailure || gscFailure ? "partial" : "available",
      eligibility: merged.links.length ? "eligible" : "blocked",
      reason,
      links: merged.links,
      providerStatus,
      counts: merged.counts,
      retrievedAt,
    };
    const retrieved = new Date(retrievedAt);
    const completeOutcome =
      providerStatus.sitemap === "available" &&
      (providerStatus.gsc === "available" || providerStatus.gsc === "not_configured") &&
      merged.counts.verification_omitted_deadline === 0 &&
      merged.counts.unresolved === 0;
    const cacheWrite = completeOutcome
      ? {
          cache_key: "internal-links:v2" as const,
          request_hash: requestHash,
          response_hash: canonicalHash(outcome),
          provider: "sitemap+gsc",
          retrieved_at: retrieved.toISOString(),
          expires_at: new Date(retrieved.getTime() + this.config.cacheTtlMs).toISOString(),
          payload: outcome,
          observed_retrieved_at: cached?.retrievedAt.toISOString() ?? null,
        }
      : undefined;
    return {
      ...outcome,
      identity,
      cache: {
        state: options.refresh ? "refreshed" : "miss",
        retrieved_at: retrieved.toISOString(),
        expires_at: cacheWrite
          ? new Date(retrieved.getTime() + this.config.cacheTtlMs).toISOString()
          : null,
      },
      ...(cacheWrite ? { cacheWrite } : {}),
    };
  }
}

export async function mergeAndVerify(
  keyword: string,
  config: Pick<LinkDiscoveryConfig, "siteOrigin" | "allowedOrigins">,
  sitemap: SitemapCandidate[],
  search: SearchCandidate[],
  verifier: SafeUrlVerifier,
  retrievedAt: string,
): Promise<InternalLink[]> {
  return (await mergeAndVerifyDetailed(keyword, config, sitemap, search, verifier, retrievedAt))
    .links;
}

export async function mergeAndVerifyDetailed(
  keyword: string,
  config: Pick<LinkDiscoveryConfig, "siteOrigin" | "allowedOrigins">,
  sitemap: SitemapCandidate[],
  search: SearchCandidate[],
  verifier: SafeUrlVerifier,
  retrievedAt: string,
  options: { verificationDeadlineMs?: number } = {},
): Promise<{ links: InternalLink[]; counts: LinkDiscoveryCounts }> {
  type Merged = {
    url: string;
    title: string;
    topic?: string;
    sitemap?: SitemapCandidate;
    analytics?: SearchCandidate;
    preScore?: number;
  };
  const merged = new Map<string, Merged>();
  for (const entry of sitemap) {
    try {
      const parsed = canonicalUrl(entry.url, config.siteOrigin, config.allowedOrigins);
      const url = parsed.toString();
      if (!merged.has(url)) merged.set(url, { url, title: titleFromUrl(parsed), sitemap: entry });
    } catch {
      /* unsafe candidate omitted */
    }
  }
  for (const item of search) {
    try {
      const url = canonicalUrl(item.url, config.siteOrigin, config.allowedOrigins);
      const hierarchy = classifyHierarchy(url);
      if (!isCommercialHierarchy(hierarchy)) continue;
      const canonical = url.toString();
      const existing = merged.get(canonical);
      if (existing) existing.analytics = item;
      else
        merged.set(canonical, {
          url: canonical,
          title: titleFromUrl(url),
          analytics: item,
        });
    } catch {
      /* unsafe candidate omitted */
    }
  }
  const terms = new Set(normalise(keyword).split(" ").filter(Boolean));
  let editorial = 0;
  const commercialCandidates = [...merged.values()].filter((candidate) => {
    try {
      if (isCommercialHierarchy(classifyHierarchy(new URL(candidate.url)))) return true;
    } catch {
      // Canonicalisation already ran; retain defensive exclusion.
    }
    editorial += 1;
    return false;
  });
  const scoredCandidates = commercialCandidates
    .map((candidate) => {
      const text = normalise(
        `${candidate.title} ${candidate.topic ?? ""} ${candidate.analytics?.queries.join(" ") ?? ""}`,
      );
      const overlap = terms.size
        ? [...terms].filter((term) => text.split(" ").includes(term)).length / terms.size
        : 0;
      return {
        ...candidate,
        preScore: overlap + Math.log10((candidate.analytics?.impressions ?? 0) + 1) / 10,
      };
    })
    .sort((a, b) => {
      const hierarchyDifference =
        INTERNAL_LINK_HIERARCHY_RANK[classifyHierarchy(new URL(a.url))] -
        INTERNAL_LINK_HIERARCHY_RANK[classifyHierarchy(new URL(b.url))];
      return hierarchyDifference || b.preScore - a.preScore || a.url.localeCompare(b.url, "en-GB");
    });
  // Reserve bounded verification capacity across hierarchy types before filling
  // the remainder by the normal hierarchy-first rank. This prevents a large set
  // of stale high-priority collection aliases from crowding every live product
  // URL out of the 100-candidate verification window.
  const selectedUrls = new Set<string>();
  const preselected: Merged[] = [];
  for (const hierarchy of InternalLinkHierarchySchema.options) {
    for (const candidate of scoredCandidates) {
      if (preselected.length >= MAX_PRESELECT) break;
      if (classifyHierarchy(new URL(candidate.url)) !== hierarchy) continue;
      if (
        [...preselected].filter(
          (selected) => classifyHierarchy(new URL(selected.url)) === hierarchy,
        ).length >= MIN_PRESELECT_PER_HIERARCHY
      )
        break;
      preselected.push(candidate);
      selectedUrls.add(candidate.url);
    }
  }
  for (const candidate of scoredCandidates) {
    if (preselected.length >= MAX_PRESELECT) break;
    if (selectedUrls.has(candidate.url)) continue;
    preselected.push(candidate);
    selectedUrls.add(candidate.url);
  }
  const omittedByBound = scoredCandidates.length - preselected.length;
  const verified: Array<{ candidate: Merged; verification: Verification } | null> = new Array(
    preselected.length,
  );
  let rejectedNon200 = 0;
  let unresolved = 0;
  let cursor = 0;
  let verificationAttempted = 0;
  const verificationDeadlineMs = options.verificationDeadlineMs ?? 30_000;
  const deadline = Date.now() + verificationDeadlineMs;
  const deadlineSignal = AbortSignal.timeout(verificationDeadlineMs);
  await Promise.all(
    Array.from({ length: Math.min(VERIFY_CONCURRENCY, preselected.length) }, async () => {
      while (Date.now() < deadline && !deadlineSignal.aborted) {
        const index = cursor++;
        const candidate = preselected[index];
        if (!candidate) return;
        verificationAttempted += 1;
        try {
          const outcome = await Promise.race([
            typeof verifier.verifyOutcome === "function"
              ? verifier.verifyOutcome(candidate.url)
              : verifier.verify(candidate.url).then((result) => ({
                  outcome: "direct_200" as const,
                  method: result.method,
                  verified_at: result.verifiedAt,
                  hierarchy: result.hierarchy,
                })),
            new Promise<never>((_, reject) =>
              deadlineSignal.addEventListener(
                "abort",
                () => reject(new Error("Link verification deadline exceeded.")),
                { once: true },
              ),
            ),
          ]);
          if (outcome.outcome === "direct_200") {
            verified[index] = {
              candidate,
              verification: {
                status: 200,
                method: outcome.method,
                verifiedAt: outcome.verified_at,
                hierarchy: outcome.hierarchy,
              },
            };
          } else {
            verified[index] = null;
            if (outcome.outcome === "unresolved_transport") unresolved += 1;
            else rejectedNon200 += 1;
          }
        } catch {
          verified[index] = null;
          unresolved += 1;
        }
      }
    }),
  );
  const omittedByDeadline = preselected.length - verificationAttempted;
  unresolved += omittedByDeadline;
  const links = verified
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(({ candidate, verification }) => {
      const overlapText = normalise(
        `${candidate.title} ${candidate.topic ?? ""} ${candidate.analytics?.queries.join(" ") ?? ""}`,
      );
      const overlap =
        terms.size === 0
          ? 0
          : [...terms].filter((term) => overlapText.split(" ").includes(term)).length / terms.size;
      const hierarchyRank = INTERNAL_LINK_HIERARCHY_RANK[verification.hierarchy];
      const topicalScore = Number(overlap.toFixed(6));
      const hierarchyScore = Number(((7 - hierarchyRank) / 6).toFixed(6));
      const analytics = candidate.analytics
        ? {
            ...candidate.analytics,
            property: candidate.analytics.property ?? config.siteOrigin,
            startDate: candidate.analytics.startDate ?? retrievedAt.slice(0, 10),
            endDate: candidate.analytics.endDate ?? retrievedAt.slice(0, 10),
          }
        : undefined;
      const gscScore = analytics
        ? Number(
            Math.min(
              1,
              (Math.log10(analytics.clicks + 1) + Math.log10(analytics.impressions + 1)) / 8,
            ).toFixed(6),
          )
        : 0;
      const relevance = Number(
        (topicalScore * 0.6 + hierarchyScore * 0.25 + gscScore * 0.15).toFixed(6),
      );
      return LiveInternalLinkSchema.parse({
        url: candidate.url,
        title: candidate.title,
        relevance,
        status: 200,
        hierarchy: verification.hierarchy,
        hierarchy_rank: hierarchyRank,
        verified_at: verification.verifiedAt,
        verification_method: verification.method,
        retrieved_at: retrievedAt,
        source: candidate.sitemap ? (candidate.analytics ? "sitemap+gsc" : "sitemap") : "gsc",
        ...(candidate.topic ? { primary_topic: candidate.topic } : {}),
        keyword_overlap: topicalScore,
        topical_score: topicalScore,
        hierarchy_score: hierarchyScore,
        gsc_score: gscScore,
        ...(candidate.sitemap
          ? {
              sitemap_url: candidate.sitemap.sitemapUrl,
              ...(candidate.sitemap.lastModified
                ? { sitemap_last_modified: candidate.sitemap.lastModified }
                : {}),
            }
          : {}),
        ...(analytics
          ? {
              gsc_clicks: analytics.clicks,
              gsc_impressions: analytics.impressions,
              gsc_queries: analytics.queries,
              gsc_property: analytics.property,
              gsc_start_date: analytics.startDate,
              gsc_end_date: analytics.endDate,
            }
          : {}),
      });
    })
    .sort(
      (a, b) =>
        a.hierarchy_rank! - b.hierarchy_rank! ||
        b.relevance - a.relevance ||
        a.url.localeCompare(b.url, "en-GB"),
    )
    .slice(0, 25);
  return {
    links,
    counts: {
      ghost_collected: 0,
      sitemap_collected: sitemap.length,
      gsc_collected: search.length,
      deduplicated: merged.size,
      commercial: commercialCandidates.length,
      editorial,
      verification_attempted: verificationAttempted,
      verification_omitted_bound: omittedByBound,
      verification_omitted_deadline: omittedByDeadline,
      direct_200: verified.filter(Boolean).length,
      rejected_non_200: rejectedNon200,
      unresolved,
      shortlisted: links.length,
    },
  };
}
function titleFromUrl(url: URL): string {
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
  try {
    return decodeURIComponent(segment)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return segment.replace(/[-_]+/g, " ");
  }
}
function normalise(value: string): string {
  return value
    .toLocaleLowerCase("en-GB")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export class NoNetworkLinkDiscoverer {
  async discover(): Promise<DiscoveryResult> {
    const unavailableHash = createHash("sha256").update("not-configured").digest("hex");
    return {
      availability: "unavailable",
      eligibility: "blocked",
      reason: "source_unavailable",
      links: [],
      providerStatus: { sitemap: "not_configured", gsc: "not_configured" },
      counts: emptyDiscoveryCounts(),
      identity: {
        query_hash: unavailableHash,
        config_hash: unavailableHash,
        origin_policy_hash: unavailableHash,
        request_hash: unavailableHash,
      },
      cache: { state: "miss", retrieved_at: null, expires_at: null },
    };
  }
}

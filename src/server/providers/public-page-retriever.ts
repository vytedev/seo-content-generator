import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  CALIBRATION_POSTS,
  CalibrationSnapshotSchema,
  type CalibrationSnapshot,
} from "../../shared/contracts/calibration.js";
import { UnprocessableError } from "../../shared/errors.js";
const MAX_BODY_BYTES = 2 * 1024 * 1024,
  TIMEOUT_MS = 15_000;
export interface PublicPageRetriever {
  retrieve(url: string): Promise<CalibrationSnapshot>;
}
export interface PinnedFetchContext {
  url: URL;
  addresses: readonly string[];
  signal: AbortSignal;
  init?: Pick<RequestInit, "method" | "headers" | "body">;
}
export type PinnedFetcher = (context: PinnedFetchContext) => Promise<Response>;
type HttpsRequest = typeof https.request;
const failure = (code: string) => new UnprocessableError(code);
function assertPublicAddress(address: string) {
  const normalised = address.toLowerCase();
  if (normalised.startsWith("::ffff:")) {
    const mapped = normalised.slice("::ffff:".length);
    if (isIP(mapped) === 4) return assertPublicAddress(mapped);
    const words = mapped.split(":");
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const numeric = (Number.parseInt(words[0]!, 16) << 16) | Number.parseInt(words[1]!, 16);
      const dotted = [24, 16, 8, 0].map((shift) => (numeric >>> shift) & 255).join(".");
      return assertPublicAddress(dotted);
    }
  }
  const version = isIP(normalised);
  if (!version) throw failure("RETRIEVAL_DNS_INVALID");
  const blocked =
    version === 4
      ? /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|224\.|255\.)/.test(address) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
      : normalised === "::" ||
        normalised === "::1" ||
        normalised.startsWith("fe80:") ||
        normalised.startsWith("fc") ||
        normalised.startsWith("fd") ||
        normalised.startsWith("ff");
  if (blocked) throw failure("RETRIEVAL_ADDRESS_FORBIDDEN");
}
export function assertAllowedCalibrationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure("RETRIEVAL_URL_INVALID");
  }
  if (
    url.origin !== "https://www.mobelaris.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !CALIBRATION_POSTS.some((p) => p.url === url.href)
  )
    throw failure("RETRIEVAL_URL_NOT_ALLOWED");
  return url;
}
const decode = (v: string) =>
  v
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const attribute = (tag: string | undefined, name: string) =>
  tag?.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1];
function meta(html: string, key: string) {
  const tag = html.match(
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    ),
  )?.[0];
  return decode(attribute(tag, "content") ?? "") || undefined;
}
function htmlToMarkdown(fragment: string) {
  return decode(
    fragment
      .replace(
        /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_a, l, b) => `\n${"#".repeat(Number(l))} ${b.replace(/<[^>]+>/g, "")}\n`,
      )
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}
export function parseCalibrationPage(
  url: string,
  html: string,
  retrievedAt: Date,
): CalibrationSnapshot {
  const post = CALIBRATION_POSTS.find((p) => p.url === url);
  if (!post) throw failure("RETRIEVAL_URL_NOT_CONFIGURED");
  const canonical = attribute(html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0], "href");
  if (canonical !== post.url) throw failure("RETRIEVAL_CANONICAL_MISMATCH");
  const prose = html.match(/<div class=["'][^"']*\bprose\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const article = prose ? htmlToMarkdown(prose) : "";
  return CalibrationSnapshotSchema.parse({
    slot: post.slot,
    url: post.url,
    canonical_url: canonical,
    http_status: 200,
    retrieved_at: retrievedAt.toISOString(),
    title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ""),
    meta_description: meta(html, "description"),
    published_time: meta(html, "article:published_time"),
    article_markdown: article,
    content_hash: createHash("sha256").update(article).digest("hex"),
    safe_metadata: {
      ...(meta(html, "author") ? { author_name: meta(html, "author") } : {}),
      ...(meta(html, "og:image") ? { image_url: meta(html, "og:image") } : {}),
      ...(meta(html, "article:modified_time")
        ? { date_modified: meta(html, "article:modified_time") }
        : {}),
    },
  });
}
export function nodeHttpsPinnedFetcher(
  context: PinnedFetchContext,
  request: HttpsRequest = https.request,
): Promise<Response> {
  const { url, addresses, signal, init } = context;
  const address = addresses[0];
  if (!address) return Promise.reject(failure("RETRIEVAL_DNS_EMPTY"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const options: RequestOptions = {
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      servername: url.hostname,
      headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), Host: url.host },
      lookup: (_hostname, lookupOptions, callback) => {
        const record = { address, family: isIP(address) };
        if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [record]);
        else callback(null, record.address, record.family);
      },
      signal,
    };
    const req = request(options, (incoming) => {
      settled = true;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, String(value));
      }
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const response = new Response(body, {
        status: incoming.statusCode ?? 0,
        ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
        headers,
      });
      Object.defineProperty(response, "url", { value: url.href });
      resolve(response);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(failure("RETRIEVAL_TIMEOUT")));
    req.once("error", (error) => {
      if (!settled) reject(error);
    });
    if (typeof init?.body === "string" || init?.body instanceof Uint8Array) req.write(init.body);
    req.end();
  });
}

async function streamBody(response: Response) {
  if (!response.body) throw failure("RETRIEVAL_BODY_MISSING");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw failure("RETRIEVAL_BODY_TOO_LARGE");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}
export class SafePublicPageRetriever implements PublicPageRetriever {
  constructor(
    private readonly fetcher: PinnedFetcher = nodeHttpsPinnedFetcher,
    private readonly resolver = (host: string) => dns.lookup(host, { all: true }),
  ) {}
  async retrieve(value: string) {
    const url = assertAllowedCalibrationUrl(value);
    const records = await this.resolver(url.hostname);
    if (!records.length) throw failure("RETRIEVAL_DNS_EMPTY");
    const addresses = records.map((r) => r.address);
    addresses.forEach(assertPublicAddress);
    const response = await this.fetcher({
      url,
      addresses,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status))
      throw failure("RETRIEVAL_REDIRECT_FORBIDDEN");
    if (response.url && response.url !== url.href) throw failure("RETRIEVAL_FINAL_URL_MISMATCH");
    if (response.status !== 200) throw failure("RETRIEVAL_HTTP_STATUS");
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html"))
      throw failure("RETRIEVAL_CONTENT_TYPE");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) throw failure("RETRIEVAL_BODY_TOO_LARGE");
    return parseCalibrationPage(url.href, await streamBody(response), new Date());
  }
}

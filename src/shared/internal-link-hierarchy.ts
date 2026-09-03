import { INTERNAL_LINK_HIERARCHY_RANK, type InternalLinkHierarchy } from "./checker/contracts.js";
import { isCanonicalProductRoute } from "./product-route.js";

export { INTERNAL_LINK_HIERARCHY_RANK };

const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

/**
 * Canonical hierarchy policy shared by discovery (1.2), verification (1.7),
 * review (1.8), and browser-side checker payload construction.
 *
 * Invalid or ambiguous URLs are never classified. Callers that already own a
 * validated URL may assert the non-null result; boundary callers must fail
 * closed on null.
 */
export function classifyInternalLinkHierarchy(value: string | URL): InternalLinkHierarchy | null {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    MALFORMED_ESCAPE.test(url.pathname) ||
    ENCODED_SEPARATOR.test(url.pathname)
  )
    return null;
  if (isCanonicalProductRoute(url)) return "product";

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const localePrefixed = Boolean(segments[0] && LOCALE_SEGMENT.test(segments[0]));
  if (localePrefixed) segments = segments.slice(1);
  if (segments.length === 0) return localePrefixed ? "broad_category" : "homepage";

  const normalised = segments.map((segment) => segment.toLocaleLowerCase("en-GB"));
  if (["designer", "designers"].includes(normalised[0]!)) return "designer_hub";
  if (normalised[0] === "collections")
    return normalised.length > 2 ? "sub_collection" : "collection";
  return "broad_category";
}

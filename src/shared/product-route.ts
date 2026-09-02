const LOCALE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const FLAT_PRODUCT_SLUG = /^style-[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/i;
const PRODUCT_SLUG = /^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/i;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

/** Canonical Mobelaris product-route policy shared by pipeline Steps 1.2, 1.7 and 1.8. */
export function isCanonicalProductRoute(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value, "https://route.invalid/");
  } catch {
    return false;
  }
  if (
    url.search ||
    url.hash ||
    MALFORMED_ESCAPE.test(url.pathname) ||
    ENCODED_SEPARATOR.test(url.pathname)
  )
    return false;

  const pathSegments = url.pathname.split("/");
  if (pathSegments[0] !== "" || pathSegments.slice(1, -1).includes("")) return false;
  if (pathSegments.at(-1) === "") pathSegments.pop();

  let segments: string[];
  try {
    segments = pathSegments.slice(1).map(decodeURIComponent);
  } catch {
    return false;
  }
  if (segments.length === 2 && /^products?$/i.test(segments[0]!))
    return PRODUCT_SLUG.test(segments[1]!);
  return segments.length === 2 && LOCALE.test(segments[0]!) && FLAT_PRODUCT_SLUG.test(segments[1]!);
}

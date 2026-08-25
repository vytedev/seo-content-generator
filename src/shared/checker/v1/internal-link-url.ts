const TRACKING_PARAMETER = /^(?:utm_|gclid$|fbclid$)/i;

/**
 * Resolves an internal link against the configured authoritative origins and
 * returns one stable identity for checks in Steps 1.4, 1.8 and 1.11.
 */
export function canonicaliseInternalUrl(
  value: string,
  authoritativeOrigins: readonly string[],
): string | undefined {
  const origins = [...new Set(authoritativeOrigins.map((item) => new URL(item).origin))];
  for (const origin of origins) {
    try {
      const url = new URL(value, `${origin}/`);
      if (!origins.includes(url.origin)) continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()])
        if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    } catch {
      // A relative value may only be resolved by another authoritative origin.
    }
  }
  return undefined;
}

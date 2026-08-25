# Step 1.2 internal-link discovery

Step 1.2 uses the configured public XML sitemap as its credential-free baseline. Existing Google Search Console OAuth may optionally enrich candidates with query, click and impression data; GSC failure does not invalidate verified sitemap candidates. If sitemap retrieval fails, valid GSC-only commercial candidates may satisfy the gate.

## Safety and bounds

- Sitemap retrieval requires exactly one document root: `urlset` or `sitemapindex`. The root and every structural element must use the standard `http://www.sitemaps.org/schemas/sitemap/0.9` namespace. Missing, wrong and mixed namespaces, wrappers, extra roots, malformed attributes/entities and invalid direct-child structure are rejected.
- All sitemap documents and page URLs must use the exact configured HTTPS site origin and explicit origin allowlist.
- DNS is resolved to public addresses and the HTTP connection is pinned to the validated answer. Redirects are rejected.
- XML bodies are byte- and timeout-bounded. DTD and entity declarations are rejected.
- Traversal detects cycles and is bounded to depth 3, exactly 100 sitemap documents and `INTERNAL_LINK_MAX_SITEMAP_URLS` canonical page URLs. Exceeding any bound blocks discovery; results are never silently truncated.
- Candidate verification repeats the exact-origin, public-DNS and pinned-connection checks. Only a direct HTTP 200 is eligible; HEAD falls back to a bounded GET only for 405/501.
- Verification selection is deterministic and hierarchy-first, then uses topical/GSC pre-score and canonical URL. The 100-candidate verification bound therefore cannot displace a stronger conversion hierarchy. Evidence separately records candidates omitted by the bound and by the deadline; deadline omissions are unresolved and are never counted as attempted. Final ranking remains hierarchy-first and at most 25 links are persisted.
- Cache entries expire after 24 hours. A stale result cannot satisfy eligibility.

## Gate behaviour

Drafting remains blocked unless at least one verified commercial result is present. The explicit local-only `LOCAL_ALLOW_UNVERIFIED_LINK_BYPASS=true` remains available under its existing localhost/database guard and defaults to false. Every attempt records whether the bypass was enabled and used, plus the fixed reason; run detail shows this evidence. Step 1.3 receives only the exact persisted shortlist, and later link-conversion/export gates remain unchanged.

Current artefacts record sitemap provenance and source health. Historical Ghost artefacts remain readable through compatibility-only contract fields; Ghost configuration and credentials are no longer runtime requirements.

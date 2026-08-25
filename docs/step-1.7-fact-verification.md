# Step 1.7 fact verification

Step 1.7 uses direct, server-only, read-only HTTPS adapters. Connector discovery did not find a suitable Medusa or general exact-claim MCP operation, so this implementation does not claim MCP coverage.

The application owns the complete claim inventory, claim rows, type, location, sources, status and hard flags. The model receives the deterministic inventory and may return only compact advisory findings tied to known inventory IDs; it cannot return claims, evidence, source metadata, status or location.

Step 1.7 makes exactly one model HTTP request and never makes a corrective request or transport retry. A non-200 configuration, billing, permission, network or timeout failure safely fails the step. By contrast, malformed, truncated or otherwise unusable HTTP 200 output is discarded: the application creates a deterministic visible `fact.advisory_unavailable` warning, runs the verifier over the full inventory, and persists every application-owned claim/source and all verifier findings. Unknown advisory inventory IDs follow this same fallback. Provider body fragments and secret/raw upstream details are never persisted or included in the warning.

Product claims require a structured product identifier. Product candidates are discovered independently from the configured strict public sitemap, then matched deterministically by exact identifier/title/slug or a bounded unique fuzzy score. Ambiguous matches remain unverified. The application extracts bounded Product JSON-LD (object, array or `@graph`) and safe visible labelled product evidence. General and statistical claims are unsupported by storefront evidence and remain unverified.

All page requests are credential-free GET-only HTTPS, explicitly origin-allowlisted, direct-200 only, DNS-checked and pinned to the validated address, timeout/retry/size/concurrency bounded, and reject private, mapped-private, link-local, multicast and reserved addresses. No cookies or authentication headers are sent.

# Step 1.8 link and conversion review

Step 1.8 owns internal-link target auditing and model judgement. It is a fixed pipeline step and never rewrites the draft.

## Deterministic audit

The framework-neutral audit parses every internal Markdown link and canonicalises the target. It checks shortlist membership **before** invoking an injected verifier. External and off-shortlist targets are never requested. Repeated occurrences share one request sequence per canonical target.

The verifier returns one typed outcome:

- direct HTTP 200;
- confirmed non-200;
- redirect;
- unresolved transport (including the honest no-network default).

The live adapter reuses Step 1.2's SSRF controls: configured HTTPS origin restriction, public-DNS check, timeout, disabled redirect following, HEAD with bounded GET fallback, and no unsafe response logging. Address parsing handles bracketed IPv6 and dotted or hexadecimal IPv4-mapped IPv6 before private/special-range checks. Hierarchy classification and rank metadata are checked for direct-200 targets.

Residual limitation: generic `fetch` performs its own DNS resolution after the application preflight lookup, so DNS rebinding remains possible between those operations. Closing that gap requires a transport that pins the validated address while preserving TLS host verification; this slice deliberately does not attempt that larger transport rewrite.

Hierarchy is a priority only after contextual suitability has been established. The deterministic audit therefore does not reject a lower-ranked link merely because a higher-ranked shortlist target exists.

## Model review

OpenRouter receives only:

- minimal run and document-version identification plus the primary keyword;
- each occurrence's anchor, canonical URL, line/section and surrounding context;
- shortlist title, canonical URL, hierarchy, rank and relevance.

It does not receive the full draft, handoff notes, internal-link records outside the safe shortlist projection, or reference snapshots.

It never receives an application status judgement. A strict findings-only JSON schema accepts `link.*` rules and allows one correction request. The prompt asks only for anchor quality, contextual suitability and conversion-support versus decorative use. It explicitly excludes membership, transport/status/redirects, hierarchy integrity, counts, body-presence, facts, style and information gain.

## Persistence and ownership

Step 1.8 runs the deterministic audit and model call under the same lease heartbeat, merges both finding lists, and persists them through the existing fenced atomic `saveReview` operation.

External URL and model calls are unavoidably at least once. If the process dies after a provider responds but before `saveReview` commits, a retry can repeat those calls because there is no distributed transaction with the providers. Stable request identities let providers deduplicate where supported, but the application does not claim exactly-once external execution. It deliberately does not partially persist a response before the atomic fenced save: durable findings, request/response artefacts, usage, sources, claims and step completion remain one operation, so retries create no duplicate durable records and never mutate the draft.

Step 1.4 no longer emits membership, target-status or rank-only hierarchy findings. It retains the commercial body-presence rule. That same deterministic rule remains in Step 1.11's rerun, protecting revisions from removing the required body link.

## Local default

When live internal-link configuration is absent, verification returns `unresolved_transport/no_network`; it never claims a target is live. Unit tests inject verifiers and make no live calls.

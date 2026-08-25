# Fact-Checking Rules

> **Status: Task-derived draft — pending editorial approval.**

## Claim extraction

Extract every factual claim into a structured record containing:

- `claim_text`
- `claim_type`
- `source`
- `verification_status`
- `location`

## Claim types

- `dimension`
- `material`
- `price`
- `delivery`
- `statistic`
- `provenance`
- `general`

## Verification statuses

- `verified` — supported by the recorded evidence.
- `unverified` — no adequate source could resolve the claim.
- `contradicted` — recorded evidence conflicts with the claim.

Never turn missing evidence into verification.

## Source routing

- General factual claims: web search with the source URL and retrieval time retained.
- Product claims: Mobelaris Medusa API first.
- Product fallback: storefront/Tina content only when the Medusa field is absent or unavailable.
- Preserve conflicting values and mark the claim contradicted; do not silently merge them.
- Client insights may shape useful content but are not verification evidence.

## Mandatory operator review

- Provenance claims are hard flagged regardless of verification status.
- Designer-attribution claims are hard flagged regardless of verification status.
- This is required because Mobelaris sells replicas and invented attribution creates brand exposure.

## Evidence handling

- Store the source type, URI, retrieval time and a content/evidence snapshot or hash.
- Link each claim to its location in the document version.
- Keep unverified and contradicted claims visible in the final export.
- Do not remove a hard flag merely because one source agrees with the claim.

## Pending editorial input

The task does not specify and this draft does not invent:

- A complete approved-source catalogue.
- Source-age limits by claim type.
- Price/currency timing tolerances.
- Delivery-region rules.
- Conflict resolution beyond preserving and flagging contradictory evidence.

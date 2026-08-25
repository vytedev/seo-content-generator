# Step 1.5 resilient writing-style review

## Runtime contract

- Step 1.5 remains the fixed `review_writing_style` pipeline step and returns structured findings only.
- The application prepares lossless Markdown blocks with stable `loc-NNNN` IDs. Every finding must use a supplied ID, which the application resolves to its owned field, absolute line range and section.
- The request includes only the active mapped `blog_writing_guide` section needed for subjective judgement. It is character-bounded and excludes Step 1.4 countable structure, length, placement, density, status, readability-grade and repeated-adjective checks.
- Findings use the allowlisted `style.*` judgement rules. A valid compact `{ "f": [] }` response is successful.
- Exactly one provider request is permitted. Step 1.5 has no corrective request and no HTTP or transport retry.

## Resilience boundary

Malformed, truncated, unknown-ID, duplicate, non-allowlisted, countable-rule or otherwise unsafe HTTP 200 output is discarded. Rejected provider content is neither persisted nor logged. The application emits one deterministic warning at the first application-owned draft block:

- `rule_reference`: `style.advisory_unavailable`
- severity: `warning`
- stable key: `style-advisory-unavailable`

The review persists normally. Step 1.9 freezes the pending warning with the current-document findings and requires an explicit operator acceptance or rejection.

Non-200 responses and configuration, billing, permission, network and timeout errors remain redacted safe failures. They do not become advisory-unavailable warnings.

## QA notes

Unit coverage checks empty success, stable-ID mapping, allowlisted style findings, bounded subjective guide context, Step 1.4 exclusion, malformed/truncated/unsafe/unknown-ID fallback and single-request failures. Memory and PostgreSQL orchestration coverage checks that the warning persists pending and belongs to the immutable Step 1.9 review set.

No database migration is required; the warning uses the existing immutable finding and review-set contracts.

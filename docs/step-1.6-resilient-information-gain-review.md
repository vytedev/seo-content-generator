# Step 1.6 resilient information-gain review

## Runtime contract

- Step 1.6 remains the fixed `review_information_gain` pipeline step and returns optional structured findings only.
- The application prepares lossless Markdown blocks with stable `loc-NNNN` IDs. Model findings must reference one of those IDs; the application resolves it to an owned field, line range and section.
- Topic, handoff notes, optional client insights and approved reference text are character-bounded before the provider request. Client insights remain context, not verified evidence.
- A valid compact `{ "f": [] }` response is successful.
- Exactly one provider request is permitted. Step 1.6 has neither corrective requests nor HTTP/transport retries.

## Resilience boundary

Malformed, truncated, unknown-ID or otherwise unsafe HTTP 200 output is discarded. No rejected text is persisted or logged. The application emits one deterministic warning at the first application-owned draft block:

- `rule_reference`: `value.advisory_unavailable`
- severity: `warning`
- stable key: `value-advisory-unavailable`

The review output then persists normally. Step 1.9 freezes this warning with all current-document findings and requires an explicit operator acceptance or rejection.

Non-200 responses and configuration, billing, permission, network and timeout errors remain redacted safe failures. They do not become advisory-unavailable warnings.

## QA notes

Unit coverage checks empty success, stable-ID mapping, malformed/truncated/unsafe/unknown-ID fallback, single-request transport behaviour and bounded context. Memory and PostgreSQL orchestration coverage checks that the warning persists as pending and belongs to the immutable Step 1.9 review set.

No database migration is required; the warning uses the existing immutable finding and review-set contracts.

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

## Durable operation and producer adoption

Step 1.6 uses the shared review-operation state machine and tables; it does not have a Step 1.6-specific operation path. Before its single dispatch, `runReview` persists the canonical `review_information_gain` operation as `started`, then durably marks it `provider_in_flight`. The validated structured response is checkpointed before findings, provider usage, request/response artefacts and the step output are saved.

A crash after `started` but before dispatch is safely adoptable by a later fenced Step 1.6 attempt. Adoption transfers the existing operation only from its exact lease-free, `retryable_failed` predecessor to a higher live attempt and records immutable ownership history in `review_operation_adoptions`. A stale producer cannot dispatch, checkpoint or save.

A `provider_in_flight` operation without a checkpoint is permanently ambiguous: replay fails closed and never recalls the provider. A checkpointed response is reconstructed and saved without provider recall. Replay cannot duplicate findings, usage, artefacts or output, and operation/request/response hashes continue to bind the exact immutable document, request and validated response.

## Storage

Step 1.6 reuses `review_operation_states`, `review_operation_adoptions`, `findings`, `provider_usage`, `artifacts` and `step_outputs`. No new table or migration is required.

## QA notes

Provider unit coverage checks empty success, stable-ID mapping, malformed/truncated/unsafe/unknown-ID fallback, a single request for transport failures and bounded context. Step 1.6-specific memory and PostgreSQL orchestration coverage exercises pre-dispatch crash/adoption ownership, stale-owner rejection, ambiguous `provider_in_flight` replay without recall, checkpoint-before-save replay without recall, exactly one Step 1.6 request, hash binding, immutable records and absence of duplicate findings, usage, artefacts or output. The malformed-response warning is also verified as pending membership in the immutable Step 1.9 review set.

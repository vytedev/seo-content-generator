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

## Durable operation and producer adoption

Before dispatch, Step 1.5 persists a deterministic review-operation identity and moves it from `started` to `provider_in_flight`. A validated response is checkpointed before findings are saved. A checkpointed response is reconstructed on replay without another provider call; `provider_in_flight` without a checkpoint remains ambiguous and fails closed.

A process loss after `started` but before dispatch leaves a safely reusable operation. Once the failed producer is lease-free and `retryable_failed`, a later active fenced execution for the same run and step may atomically adopt it. The replacement must have a higher attempt number and the operation must still name the exact predecessor as its current producer. Each transfer is immutable and source- and target-unique per operation, preserving complete A→B→C attribution. Concurrent or stale adoption, wrong-run/step, non-failed predecessor, non-current predecessor, expired replacement, and `provider_in_flight` or checkpointed operation adoption are rejected.

## Database adoption

Migration `0049_bumpy_steel_serpent.sql` adds `review_operation_adoptions`, including run-scoped execution foreign keys, distinct source/target enforcement, unique `(operation_id, from_step_execution_id)` and `(operation_id, to_step_execution_id)` constraints, immutable-row guards, and trigger validation. The trigger serialises on the operation row and locks predecessor and replacement executions in deterministic UUID order before validating their live states. Existing installations populated through migration 0048 receive this schema by applying 0049; no historical review rows are rewritten.

## QA notes

Unit coverage checks empty success, stable-ID mapping, allowlisted style findings, bounded subjective guide context, Step 1.4 exclusion, malformed/truncated/unsafe/unknown-ID fallback and single-request failures. Memory and PostgreSQL orchestration coverage checks that the warning persists pending and belongs to the immutable Step 1.9 review set. PostgreSQL adoption coverage exercises one-hop pre-dispatch crash recovery, checkpoint reconstruction, immutable producer history and duplicate rejection; migration coverage applies 0049 to a database populated through 0048. Disposable PostgreSQL execution and explicit A→B→C, concurrent-adoption and invalid-state rejection evidence remain required before production verification is complete.

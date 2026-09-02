# Step 1.3 durable provider operation

Step 1.3 uses an application-owned operation identity derived from the run and canonical frozen request. The provider, pinned model, prompt version, reference snapshots, handoff and persisted link shortlist therefore participate in the durable request identity.

## State machine

`started -> provider_in_flight -> checkpointed`

A narrowly proven pre-dispatch configuration/request failure may transition `provider_in_flight -> started`. No other backward transition is permitted. Identity fields and checkpointed responses are immutable; rows cannot be deleted. The repository derives the operation identity from the exact run, request, provider, model, effective token policy, reasoning policy, retry policy, prompt/schema contract and purpose; callers cannot supply an arbitrary operation ID.

The orchestrator creates/replays `started`, commits `provider_in_flight` before the single provider dispatch, validates and checkpoints the complete structured response, then persists the draft/version/request artefact/usage only from that exact checkpoint. Step 1.3 makes no automatic corrective, network, 429 or 5xx retry because none proves that the preceding paid request was not processed. A restart replays `checkpointed` without calling the provider. A restart that finds `provider_in_flight` with no response fails closed as ambiguous and does not call the provider.

## OpenRouter idempotency finding

The official OpenRouter API overview and chat-completion reference reviewed for this change do not document a server-side idempotency-key guarantee for chat completions. The application therefore does not claim upstream deduplication and does not retry an ambiguous reserved operation. OpenRouter's returned request id remains usage/audit evidence only, not a pre-dispatch idempotency mechanism.

## Residual ambiguity

A process or network failure after the reservation commits but before the validated response checkpoint commits cannot prove whether OpenRouter processed the request. The operation remains permanently ambiguous and the normal Resume action cannot repeat it. The UI directs the operator to technical review; any separate recovery must be explicitly authorised and receives a distinct immutable purpose/identity. This deliberately favours no duplicate paid/model side effect over automatic recovery.

Runs that failed at Step 1.3 before this checkpoint table existed have no reusable response. One normal operator click can explicitly authorise a single `legacy_operator_recovery` operation only when durable history proves a failed draft attempt, no draft exists and no draft operation exists. Once any operation exists, the legacy bootstrap is refused, preventing repeated recovery reservations.

Provider reasoning remains excluded by the existing Step 1.3 provider response schema and provider diagnostics remain safe/bounded; the checkpoint stores only the validated response contract.

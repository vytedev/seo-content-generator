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

Step 1.8 runs the deterministic audit before the model call under the same lease heartbeat. Its durable state sequence is explicit:

1. `beginReviewOperation` commits `started` with the stable operation identity.
2. A retry may adopt that exact `started` operation to its fresh, fenced step execution before dispatch; the adoption is immutable and the previous execution can no longer dispatch, checkpoint or save.
3. `markReviewProviderInFlight` commits `provider_in_flight` before the external call.
4. The validated provider-only response is committed as `checkpointed` with its provider-response hash.
5. The current audit is merged immediately before fenced, atomic `saveReview`; findings, request/merged-response artefacts, usage, sources, claims, step output and completion commit together.

The stable operation/request identity is derived from the run id, document-version id, step id, canonical request hash, provider and model. Audit outcomes are deliberately absent from that identity: they are refreshed on replay, while the provider request projection and provider-only checkpoint remain stable. Any identity mismatch fails as an immutable operation conflict rather than creating or reinterpreting a response.

The operation checkpoint hash identifies only the provider response. The merged response artefact content hash and step-output hash identify the final response containing the fresh deterministic audit plus provider findings. A checkpointed model response is replayed without another model dispatch. A post-dispatch crash before that checkpoint is ambiguous and fails closed rather than recalling the model. URL verification has different timing: the deterministic audit runs once before the model in every execution, including a checkpoint replay, so replay uses current verification outcomes. A fresh execution does not perform a second live verification during merge or save.

All three state-changing boundaries—pre-dispatch reservation, checkpoint and final save—require the current unexpired lease token and adopted producing execution. Stale owners cannot dispatch, checkpoint or save. Retries create no duplicate durable records and never mutate the draft. Incompatible historical merged checkpoints are not reinterpreted; persistence fails closed.

## Verification status

The in-memory Step 1.8 orchestration, crash/replay, audit replacement, hash separation, wrong-checkpoint atomicity, fencing and unchanged-draft tests are credential-free unit tests. PostgreSQL equivalents are opt-in and run only when the caller explicitly supplies a disposable `TEST_DATABASE_URL`; without that variable they are skipped, not reported as passed. No database URL is inferred from local configuration.

Step 1.4 no longer emits membership, target-status or rank-only hierarchy findings. It retains the commercial body-presence rule. That same deterministic rule remains in Step 1.11's rerun, protecting revisions from removing the required body link.

## Local default

When live internal-link configuration is absent, verification returns `unresolved_transport/no_network`; it never claims a target is live. Unit tests inject verifiers and make no live calls.

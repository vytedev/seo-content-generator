# Step 1.10 controlled revision

## Current verified contract

Step 1.10 reads operator-accepted findings only through the frozen Step 1.9 review-set membership, source document and ordinal. Deterministic, coherence and operator-authorised repairs use separate revision sources and never resend or reopen the original operator review.

The versioned planner reduces a non-empty pass before any model call. Its current planning version and deterministic policy identity live in `src/shared/revision-planning.ts`; documentation must not duplicate them as fixed historical constants. Explicitly allowlisted rules use bounded application-owned corrections. Other exact safe targets go to the model; ambiguous, broad or server-owned targets are preclassified `unable`. The model receives only its subset. The server merges deterministic, model and unable rows back into original finding order before exactly one `applyRevisionEnvelope`, preserving one audit row per accepted finding and one resulting document version.

A non-empty model subset makes exactly one subjective model request; there is no corrective model request. OpenRouter receives strict JSON Schema `mobelaris_revision_edit_plan_v2`: every row requires `replacement`, which is a string for `applied` and `null` for `unable`. Prompt and compact-normaliser identities are versioned in source. Exact supplied ID order is mandatory; unknown, duplicate, missing or reordered IDs, extra keys/prose, full documents, claims and out-of-scope edits are rejected.

A successful HTTP 200 with malformed, truncated, malicious or otherwise unusable output is not retried. Its raw body is discarded and never persisted. The provider constructs a safe subset response with every subjective finding marked `unable` and a bounded generic reason. The orchestrator merges those rows with deterministic edits and preclassified unable rows in original order, persists one controlled revision and its audits, then continues to Step 1.11. This successful-HTTP fallback does not create a provider-failure row or contribute to durable lockout. All non-200 HTTP, configuration, permission, billing, 429, 5xx, network and timeout failures make no second model request and retain the existing durable safe-failure lockout. `applied` means an exact accepted location changed; `unable` records why it could not safely be applied.

Provider failures are append-only and typed as `configuration`, `malformed_response`, `transient_exhausted`, `timeout` or `guard_rejected`. Before a call, the app checks the durable identity `(run, provider, model, prompt version, planning version, failure category)`. Two failed executions with the same identity/category lock out a third call across restarts. The operator must change the model/configuration; safe logs expose identities, category and counts but no prose, response body or credential.

The server reconstructs the result from the immutable source version. It permits exact scalar fields, indexed image/FAQ properties, or Markdown hunks computed once against immutable source coordinates. Semantic Markdown blocks are attributed to exactly one accepted location and applied in reverse source order; ambiguous, overlapping, rejected, broadly authorised or fact-unsafe edits fail closed as `unable`. Claims are always copied unchanged. Each accepted finding gets one immutable audit row with its full structured location, exact hunks, before/after hashes and actual-change status, bound by a canonical manifest hash.

A fenced operation row is committed before the provider call. The validated strict-JSON response is checkpointed under the live fence before any failure hook, allowing concurrent resume after a crash without another provider call. The revised document, audit rows, provider usage, operation identity and successful step completion then commit atomically under the live fencing token.

## Production continuation and startup recovery

The Step 1.9 dispositions transaction atomically marks findings review complete, moves the run to `revision_pass` and readies the run's existing durable queue job. The HTTP route returns `202` with `continuation: "queue_accepted"`; it does not call Step 1.10 inline. The single `PipelineQueueWorker` owns continuation, runs `MilestoneFourOrchestrator.run()`, and that orchestrator alone invokes its private controlled revision method under the independently fenced Step 1.10 lease.

Worker startup awaits `recoverQueueJobs()` before polling. A process restart between route acceptance and worker claim therefore retains the committed job and resumes it through the same queue; expired queue leases are recovered subject to active step-lease coordination, and ambiguous revision provider operations fail closed rather than dispatching twice. The production-shaped route/queue/restart test is `tests/run-advancement.test.ts` (`continues Step 1.10 only through the durable queue after a worker restart`); queue recovery and fencing cases are covered by `tests/queue.test.ts` and PostgreSQL recovery by `tests/postgres-queue.integration.test.ts` when `TEST_DATABASE_URL` is explicitly supplied.

With zero accepted findings, the provider and document-version creation are skipped. An immutable no-op completion records the stable operation identity and the step advances under the same fence.

## Candidate preflight before persistence

The envelope proves that a change stayed within authorised structure; it does not prove that the rule was resolved. Step 1.10 therefore runs the same frozen checker Step 1.11 uses against the complete candidate after controlled application and before `saveRevision()`, reusing `getDeterministicManifest`, `validateDeterministicManifest`, `mapDeterministicInput`, `checkerInputFromManifest`, `runVersionedDeterministicChecks` and `compareDeterministicResults` rather than duplicating any checker formula.

The preflight:

- retains `applied` only where the accepted blocker's rule is provably gone, and only when ownership is exact (one accepted blocker and one baseline blocker for that rule);
- reverts an ineffective edit and records it `unable` with a bounded reason;
- attributes an introduced blocker by reverting one applied edit at a time, reverting only the responsible edit;
- fails closed to a full reversion when an introduced blocker cannot be attributed to exactly one edit, and rechecks the candidate after selective reversion;
- preserves successful independent sibling edits;
- keeps audits consistent with the bytes that persist, so `changed` always equals `status === "applied"`; and
- is a pure function of the checkpointed provider response, the immutable source document and the frozen manifest, so a resume replays it without another provider request.

Reverted edits still persist one truthful audit row per accepted finding through the normal `saveRevision` path. The existing no-op contract records no audits, so it is not used for a fully reverted candidate; that would trade a truthful record for one fewer document version.

## Frozen exclusions and exceptional authority

Rejected, factual, link-owned, reserved and other accepted-finding exclusions are computed once per revision and reused for binding, multi-block readability selection, the provider-visible targets, the additional authority, the operation identity and envelope validation. A rejected paragraph is therefore never disclosed to the provider; envelope rejection remains a second line of defence rather than the primary protection.

An exceptional authorisation persists the complete readability authority — every exact line range, the selector version and the target-set identity — inside its immutable `blocker_bindings` evidence, so the operator authorises exactly what may be sent. Execution uses those persisted ranges verbatim and never recomputes authority: a missing entry, a stale selector version, an identity disagreeing with its own ranges, or any freshly computed difference (stale document, missing, extra, duplicate or reordered range) fails closed before provider dispatch. Authorisation applies the same exclusions execution will apply, so the two routes produce equivalent target sets for the same document, findings and exclusions. A blocker with no safe binding still makes the exceptional correction unavailable.

Same-key authorisation replay is purely observational in both repositories: it returns the existing result and never changes run status, current step, block reason, document version, blocker set, revision operation or provider-call count, and never extends the one-time correction.

## Coherence provider reservation

Step 1.12 now mirrors the revision lifecycle. The canonical request and operation identity are frozen, the operation is reserved atomically, and `coherence_checkpoints.status` is durably set to `provider_in_flight` before dispatch. After a process loss with a reservation and no checkpoint, a resume fails closed with a safe retryable state instead of repeating the paid call; only provider errors that provably precede the HTTP request (missing token, invalid model, model mismatch) release the reservation. A checkpointed response replays with no further call, and the deterministic and exact-document export gates are untouched.

## Application-owned binding for locationless rules

Several checker rules carry a field with no line range, and both the deterministic planners and the model gate require an exact `line_start`. Those findings therefore receive a versioned, rule-specific, application-owned binding (`REVISION_BINDING_VERSION` in `src/shared/revision-planning.ts`), shared by the normal and exceptional routes so both authorise identical locations:

- `keyword.primary.h2` binds to one existing eligible H2. H1 and deeper levels, the Conclusion/Key Takeaways/FAQ headings, headings that already contain the keyword, protected ranges and any correction that would duplicate an existing heading are all refused. Appending the keyword to the heading text preserves the `##` prefix, so hierarchy cannot be corrupted.
- `style.readability_grade_8` is document-global, so one paragraph usually cannot move Grade 9.7 to Grade 8. One accepted readability finding therefore authorises a bounded set of exact, non-contiguous prose blocks, selected by the versioned `READABILITY_SELECTOR_VERSION` selector. Ranking reuses the frozen checker's own `calculateReadabilityGrade`, and only paragraphs already above the target are eligible — simplifying prose that is already simple cannot lower the document mean. The selector never chooses the direct answer, headings, list or quote blocks, HTML/image-marker blocks, link-owned prose, factual ranges, rejected ranges, the protected Conclusion/Key Takeaways/FAQ sections, or a paragraph another accepted finding already authorises. Limits are explicit: at most `READABILITY_MAX_BLOCKS` blocks, `READABILITY_MAX_SOURCE_CHARACTERS` source characters and `READABILITY_MAX_SOURCE_LINES` source lines. With no eligible target it returns `unable`.

  Each authorised block is issued an application-owned id (`<finding-id>::rbN`) and expanded into one row of the existing `mobelaris_revision_edit_plan_v2` contract, so the provider contract, prompt and schema version are unchanged: the model only ever sees issued ids and their bounded source text, and unknown, missing, duplicate or reordered ids still fail closed on the existing exact positional match. Those rows collapse back into the single immutable audit the original readability finding owns, carrying every exact hunk with its own before/after hashes. Authority is never widened to `body_markdown`, and the blocks are never merged into one broad span that would swallow the unauthorised prose between them — a finding with no exact primary location grants no authority at all, even when extra block ranges are supplied.

  Because the rule is whole-document, the candidate preflight still evaluates the complete frozen checker: if Grade 8 is not met, every block the readability finding owns is reverted together and the finding is recorded `unable`, while successful independent sibling corrections such as the H2 and direct-answer fixes are preserved. The selected target set takes part in the revision operation identity, so a replay reuses its checkpoint instead of paying again.

No other locationless rule is bound: binding arbitrary prose to a structural rule would authorise an edit that cannot resolve it. Those rules keep reaching the bounded Step 1.11 fallback, and the exceptional correction is refused up front when any blocker has no safe binding rather than spending the one authorisation on an edit that cannot land.

`on_page.meta_description.length` is also corrected above 155 characters: shortening counts UTF-16 code units to match the frozen checker's `value.length`, iterates code points so a surrogate pair is never split, prefers complete words, must preserve the exact primary keyword, and returns `unable` when no candidate lands in 150–155.

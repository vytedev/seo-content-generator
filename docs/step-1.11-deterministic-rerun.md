# Step 1.11 deterministic rerun

## Meaning of `succeeded`

A Step 1.11 execution marked `succeeded` means the frozen checker completed and its result was persisted. It does **not** by itself mean the article passed. The authoritative article outcome is the persisted run transition plus the rerun’s retained and introduced blocker counts.

- Zero blockers: clear an obsolete deterministic block reason, set the run to `running`, and advance `current_step` to `final_coherence_export` (Step 1.12).
- Blockers with repair budget remaining: return to `revision_pass`, increment the run-wide deterministic repair count and rerun Step 1.11 after correction.
- Blockers after two automatic repair cycles: keep the Step 1.11 history as `succeeded`, set the article to `blocked`, and present the gate as “Blocked after 1.11” with exact operator guidance.
- A failed checker execution remains `retryable_failed` and retains safe resume behaviour; it is not the same state as a completed checker with blockers.

Step 1.4 atomically stores its findings, output, success and an immutable manifest. The manifest freezes checker/input/schema versions, the canonical handoff, ordered rule descriptors (authority, applicability and complete parameters), build/execution/time metadata, source-document identity, non-executable reference pointers plus content snapshots, a fixture source identity plus content snapshot, and the exact persisted Step 1.2 artefact body/identity/hash/metadata. Passing rules do not create findings; every descriptor is nevertheless reported exactly once as evaluated or skipped with a reason.

The checker version dispatches an immutable executable runner snapshot from the application registry. Its build ID is the canonical hash of the source contract, inventory and parameters and is asserted at runtime; behavioural changes require a new runner version rather than comparison with a mutable global checker.

Step 1.11 loads that exact manifest. It validates manifest, configuration, references, fixture, shortlist artefact, canonical handoff, baseline findings/result and row lineage hashes, then substitutes only the current immutable document's draft-owned body and on-page fields. It does not read the current fixture, active references, discovery state or the network. Schema parse and every mismatch path fail with typed `DETERMINISTIC_MANIFEST_MISMATCH`.

Each revised document version has one unique, fenced and idempotent Step 1.11 result. The result stores evaluated rules, configuration/findings/result hashes and semantic `resolved`, `retained` and `introduced` finding IDs. Finding IDs derive from rule, stable structural Markdown path and subject rather than line numbers or full mutable block prose. Reordering and same-subject prose edits remain stable. Repeated identical subjects in the same structural container are unavoidably ambiguous and are compared as occurrence-qualified identities (`#2`, `#3`, …).

Final coherence and export require a Step 1.11 result whose document ID and content hash exactly match the current document. A retained or introduced blocker now creates a controlled deterministic-repair Step 1.10 cycle from those exact persisted blocker rows without reopening the immutable Step 1.9 review set. The existing revision planner applies supported safe code-only corrections and sends only the remaining location-scoped rows to the revision model. Step 1.11 then reruns from its frozen manifest.

The run stores one deterministic repair-cycle count for the whole run; coherence returns and exceptional correction never reset it. The orchestration guard permits the initial pass, two deterministic repairs total, and at most two coherence returns. After two deterministic cycles, remaining blockers atomically block at Step 1.11 for exceptional operator action; the API exposes their exact issue, rule, location and suggested fix. Eligible legacy rows blocked before the cycle migration can be resumed once into Step 1.10 using the persisted Step 1.11 blockers without reopening frozen Step 1.9; coherence and unknown blocks are never reopened.

Step 1.12 and Google Docs export are never entered while this gate is non-zero. Revision operation identities and response checkpoints remain document- and finding-bound. A persisted `provider_in_flight` operation without a response is ambiguous after process loss and fails closed with operator guidance rather than repeating a paid call; a checkpointed response replays without a provider call. Every revised document persists its authoritative revision source (`operator_findings`, `deterministic_repair` or `coherence_repair`) for coherence lineage.

## Worker ownership and restart recovery

Production does not execute Step 1.11 from an HTTP request. Resume and findings-disposition routes only commit or ready the run's existing durable queue job; the single `PipelineQueueWorker` invokes `MilestoneFourOrchestrator.run()`, which claims Step 1.11 under its independent fenced step lease. Service startup awaits `recoverQueueJobs()` before polling.

If a worker dies after the Step 1.11 result and transition commit but before queue completion, the expired queue lease is recovered and a replacement worker observes `current_step: final_coherence_export`. The orchestrator therefore does not claim or rerun Step 1.11; it continues at Step 1.12 against the exact persisted gate. `tests/run-advancement.test.ts` covers this production-shaped worker crash, startup recovery and takeover path, including one persisted rerun, one revision call and one export. Queue fencing and active-step-lease coordination remain covered separately by `tests/queue.test.ts` and, when an explicit disposable `TEST_DATABASE_URL` is supplied, `tests/postgres-queue.integration.test.ts`.

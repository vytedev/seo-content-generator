# Step 1.11 exceptional targeted correction

## Purpose

This is a rare safety fallback, not a second normal findings review. Step 1.9 remains frozen. Normal safely correctable findings should be resolved by Step 1.10 and proven by the Step 1.11 gate; the exceptional action exists only after the run-wide budget of two automatic deterministic repair cycles is exhausted.

## QA contract

After two automatic correction cycles, a deterministic Step 1.11 block exposes at most one operator-authorised targeted correction only when every blocker belongs to the exact persisted current document/rerun and can be bound to precise, safe edit authority.

- The operator sees the persisted blockers before acting and must explicitly confirm that one additional bounded AI request may be used.
- The UI states when all blockers are eligible for code-only handling; otherwise at most one scoped revision request is allowed.
- The authorisation is immutable, idempotent and unique per run. Replaying its key returns current state without rerunning the orchestrator or provider.
- The revision source is `operator_authorised_repair`; Step 1.9 review membership and dispositions remain frozen.
- The existing controlled revision envelope limits edits to the persisted blocker locations. Claims and unauthorised fields remain protected.
- Step 1.11 is rerun against the new immutable document. Remaining blockers stop the run with no export, no repair-budget reset and no second exceptional action. Zero blockers permit the normal Step 1.12 coherence/export gate.
- Ambiguous provider dispatch remains fail-closed through the existing durable revision operation state.

## Review checks

Test explicit confirmation rejection, exact current-document/rerun binding, one-per-run uniqueness, idempotent replay, immutable authorisation/revision records, no Step 1.9 mutation, zero-model deterministic routes, one-model maximum, no export with remaining blockers, successful export with zero blockers, and pre-migration blocked-run availability after restart.

# Step 1.7 resilient fact review — QA and technical notes

## QA acceptance

- Valid compact `{ f: [...] }` advisories map only known inventory IDs to application-owned locations.
- Malformed, truncated, unsafe or unknown-ID HTTP 200 output produces one visible `fact.advisory_unavailable` warning and no corrective model request.
- The fact verifier still receives the full inventory and persists every claim/source plus verifier and valid advisory findings.
- Non-200, network and timeout failures remain redacted safe failures.
- Persisted outputs and logs contain no secret, raw provider body or rejected fragment.
- Step 1.9 requires an explicit disposition for verifier findings and advisory-unavailable warnings.

## Technical boundary

The provider wire response contains compact advisory fields only (`k`, `q`, `r`, `v`, `i`, `x`). The orchestrator passes those advisories to the application verifier, which builds claim/source/status/location/type/hard-flag records from the deterministic inventory. Repository persistence remains atomic and identical for memory and PostgreSQL implementations; no schema migration is required.

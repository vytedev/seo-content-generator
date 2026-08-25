# Step 1.9 findings review

Step 1.9 appends an immutable review-set record before entering the operator wait. It binds the run, findings-review execution, exact document version, ordered finding membership, membership hash and count. Server reads and submissions use only that membership; later or historical findings cannot enter it.

Findings and dispositions are append-only. `hard_flag` is persisted application-owned data; attribution/provenance inventory findings are marked by the application rather than inferred in the UI. Each row exposes producing step, full location, issue, evidence, suggested fix and rule reference.

A submission must carry an idempotency key and an explicit decision for every finding in the frozen set, including deterministic fact-verifier findings and the `fact.advisory_unavailable` warning when Step 1.7 model output was unusable. Its canonical payload hash includes trimmed rationale (blank becomes null); a reused key with different payload, or any cross-run key collision, is a typed conflict. The transaction records dispositions, an auditable review submission, completes 1.9 and advances to 1.10. The route invokes milestone four once; if continuation fails, committed decisions remain visible and normal milestone-four recovery applies.

An empty review set records a zero-count review submission and completes 1.9 without a human interruption. The ingest path then continues through the existing milestone-four orchestration. SERP warnings remain informational and never gate this transition.

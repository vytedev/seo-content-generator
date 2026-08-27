# MM03-01 Agent Guide

## Source of truth

Build and harden the current standalone Mobelaris SEO Content Generator in this repository. The primary goal is a smooth, production-ready product.
Use these sources in order:

1. The current application behaviour and source code, constrained by current safety invariants.
2. Newer recorded Xevy decisions, with explicit supersession taking precedence over older decisions.
3. Locked Xevy specs and active task notes that still describe the current product, especially Step 1.10–1.12 contracts, UI/UX Flow, QA Notes and Technical Review Instructions.
4. `docs/current-product-production-readiness.md`, this guide and the current step documents under `docs/`.
5. `.xevy/design.md` for frontend design decisions.
6. The original MM03-01 task and early plans as historical context only for requirements the current product retains.

Do not restore obsolete flows or integrations solely because they appear in the original task. When current sources conflict, prefer the newer explicit decision and current product contract. If a conflict changes product scope or safety and cannot be resolved from those sources, stop and resolve it in Xevy rather than guessing. If Xevy is unavailable, use checked-in current contracts, disclose the limitation and stop only when correctness depends on the unresolved conflict.

Production-readiness reviews must distinguish a working happy path from smooth UX, crash/retry safety and deployable operation. Report concrete evidence, risk, exact fix location and priority; do not grade the product against superseded historical prose.

## Product invariants

- This is a fixed twelve-step pipeline, not an autonomous agent.
- The canonical steps and order are defined in `src/shared/pipeline.ts`.
- Deterministic checks run before probabilistic/model reviews.
- Reviews return structured findings only; they never rewrite prose.
- Step 1.10 applies accepted findings in one controlled revision operation. Exact edit authority, immutable audits and provider checkpoints must remain narrow and traceable.
- Step 1.11 reruns the frozen deterministic checker. A Step 1.11 execution marked `succeeded` means the checker completed; it does not mean the article passed. A clean result clears obsolete deterministic block state and advances to Step 1.12. Remaining blockers enter at most two automatic controlled repair cycles, then block for one operator-authorised targeted correction.
- Step 1.12 may return blockers to revision for at most two coherence cycles, then blocks for operator action.
- Findings review is the only normal human interruption and must support bulk acceptance. The one-time exceptional Step 1.11 correction is a safety fallback, not a second normal findings review.
- Step 1.9 is never reopened by deterministic or coherence recovery. There is no unrestricted rewrite and no repair-budget reset.
- Deterministic or coherence blockers always prevent export. Google Docs receives only the exact current document that passed the Step 1.11 gate.
- Reference documents, mappings, artefacts and document versions are versioned and traceable.
- Every factual figure needs provenance. Unresolved claims remain `unverified`.
- Provenance and designer-attribution claims are always hard flagged.
- Product verification uses credential-free public Mobelaris storefront evidence discovered from the public sitemap. Unsupported claims remain `unverified`; Medusa and paid evidence gateways are not active dependencies.
- The handoff includes optional `client_insights`; a SERP composition mismatch warns but does not block.
- Export targets Google Docs through an in-app Google OAuth connection and must be idempotent.

## Launch scope

- Mobelaris blog posts only.
- New content only; no refresh/rebuild mode.
- English (UK) only.
- Single operator; no role system.
- The app ends at Google Docs export. It does not publish or translate content.
- No customer, lead or order data.

## Worktree and deployment boundary

For the current isolated MM03-01 development flow:

- Work only in `/apps/mobelaris/seo-content-generator-MM03-01` on `xevy/mm03-01-seo-content-app`, unless a newer explicit Xevy decision and session task lock name another worktree. Verify the Git root and branch before editing.
- Repository hosting configuration for `content-generator.vyte.dev` has separate approval, but implementation work does not authorise a deploy. Do not deploy, rebuild production or change production configuration without explicit approval.
- Do not create a remote repository, add or modify a Git remote, commit, push or merge unless the user separately authorises that action. Never push directly to a protected branch.
- Do not use production credentials.
- Do not modify or import source from reference repositories.
- Reference repositories may be read only for patterns, never for secrets.
- Do not read `.env`, credential, token, key or certificate files.
- Local disposable PostgreSQL/Docker testing is allowed; remove temporary containers after use.

## Step 1.10–1.12 correction status

### Current verified behaviour

- Step 1.10 checkpoints provider output before controlled application and persists only authorised structural changes.
- Step 1.11 uses the frozen Step 1.4 manifest, advances a zero-blocker document to `final_coherence_export`, and blocks safely after the two-cycle repair cap.
- The UI describes a completed Step 1.11 with remaining blockers as “Blocked after 1.11”, while its history remains `Succeeded`.
- Step 1.12 and Google Docs export remain exact-document and zero-blocker gated.

### Step 1.10 correction behaviour now implemented

- The complete Step 1.10 candidate is evaluated with the same frozen checker Step 1.11 uses, after controlled application and before `saveRevision()`.
- A correction stays `applied` only when its target blocker is provably resolved and ownership is exact. Ineffective and blocker-introducing edits are reverted, successful independent sibling edits are preserved, and unattributable introduced blockers fail closed to a full reversion.
- Locationless rules receive only rule-specific, versioned, application-owned bindings, shared by the normal and exceptional routes. `keyword.primary.h2` and `style.readability_grade_8` are bound; no other locationless rule is, and there is no unrestricted `body_markdown` rewrite authority.
- `style.readability_grade_8` may authorise a bounded set of exact, non-contiguous prose blocks under one immutable audit, issued as application-owned block ids through the unchanged provider contract. The whole-document frozen rule still decides whether those edits persist.
- Over-length meta descriptions are shortened using the frozen checker's UTF-16 code-unit semantics without splitting surrogate pairs.

### Approved target behaviour not yet implemented

- The exceptional correction is refused up front when any blocker has no safe binding. Rule-specific bindings for the remaining locationless rules are not implemented.
- An exceptional authorisation freezes the complete readability block set, selector version and target-set identity; execution uses only those ranges and fails closed on any drift. Same-key replay is observational in both repositories and never extends the one-time correction.
- Coherence has revision-equivalent protection: a durable `provider_in_flight` reservation before dispatch, fail-closed ambiguity on restart, and a narrowly proven release for provably undispatched provider errors.

Do not document these target items as implemented until code and tests prove them.

## Engineering rules

- TypeScript strict mode stays enabled.
- Validate external and user input with Zod at the boundary.
- Keep shared pipeline contracts framework-neutral under `src/shared`.
- PostgreSQL/Drizzle migrations are append-only after review; do not edit applied migrations casually.
- Worker operations must be atomic, idempotent and fenced by an unexpired lease token.
- Immutable/versioned records must not be updated in place.
- Provider clients must be server-only, bounded by timeout/retry limits and mockable.
- Never log secrets or full unsafe upstream responses.
- Use British English in operator-facing copy.
- Make the smallest task-focused change; do not refactor unrelated code.

## Formatting and verification

Repository Prettier configuration is authoritative; editor extensions are optional convenience.
Before reporting a slice complete, run:

```bash
npm run format
npm run check
npm run db:generate
npm run format:check
```

PostgreSQL integration tests are opt-in through `TEST_DATABASE_URL` and must point only to an explicitly disposable local database. Never derive it by reading or copying a deployed `.env`. When database invariants change, also apply migrations to disposable local PostgreSQL and run:

```bash
TEST_DATABASE_URL=postgresql://LOCAL_USER:LOCAL_PASSWORD@127.0.0.1:LOCAL_PORT/mm0301_test npm test
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db-invariants.sql
```

Do not claim success without command output. Do not commit or push unless the user explicitly authorises that separate action.

# MM03-01 Agent Guide

## Source of truth

Implement the standalone Mobelaris SEO content production web app in this repository.
Use these sources in order:

1. The original Xevy task MM03-01 requirements. Never rewrite or weaken them.
2. Recorded Xevy decisions.
3. Plan spec MM03-01-S1.
4. Active task notes: UI/UX Flow, QA Notes and Technical Review Instructions.
5. `.xevy/design.md` for frontend design decisions.

When sources appear to conflict, stop and resolve the conflict in Xevy rather than guessing.

## Product invariants

- This is a fixed twelve-step pipeline, not an autonomous agent.
- The canonical steps and order are defined in `src/shared/pipeline.ts`.
- Deterministic checks run before probabilistic/model reviews.
- Reviews return structured findings only; they never rewrite prose.
- Step 1.10 applies accepted findings in one controlled revision operation.
- Step 1.12 may return blockers to revision for at most two coherence cycles, then blocks for operator action.
- Findings review is the only normal human interruption and must support bulk acceptance.
- Reference documents, mappings, artefacts and document versions are versioned and traceable.
- Every factual figure needs provenance. Unresolved claims remain `unverified`.
- Provenance and designer-attribution claims are always hard flagged.
- Product verification uses Medusa first and storefront/Tina only as fallback.
- The handoff includes optional `client_insights`; a SERP composition mismatch warns but does not block.
- Export targets Google Docs through an in-app Google OAuth connection and must be idempotent.

## Launch scope

- Mobelaris blog posts only.
- New content only; no refresh/rebuild mode.
- English (UK) only.
- Single operator; no role system.
- The app ends at Google Docs export. It does not publish or translate content.
- No customer, lead or order data.

## Local-only boundary

Until separate written approval:

- Work only in `/apps/mobelaris/MM03-01-seo-content-app` on `xevy/mm03-01-seo-content-app`.
- Do not configure production deployment or choose a production runtime.
- Do not create a remote repository, add a Git remote or push.
- Do not use production credentials.
- Do not modify or import source from reference repositories.
- Reference repositories may be read only for patterns, never for secrets.
- Do not read `.env`, credential, token, key or certificate files.
- Local disposable PostgreSQL/Docker testing is allowed; remove temporary containers after use.

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

When database invariants change, also apply migrations to disposable local PostgreSQL and run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db-invariants.sql
```

Do not claim success without command output. Do not commit or push unless the user explicitly authorises that separate action.

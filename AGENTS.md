# SEO Content Generator Agent Guide

## Source of truth

Implement the standalone Mobelaris SEO content production web app in this repository.
Use these sources in order:

1. The current Xevy task requirements. Never rewrite or weaken them.
2. Recorded Xevy decisions for the current task.
3. Approved plan specs for the current task.
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

## Project scope

- This repository contains the standalone Mobelaris SEO content production application.
- It supports Mobelaris blog posts only.
- It creates new content only; refresh and rebuild modes are out of scope.
- Operator-facing content is English (UK) only.
- It is designed for a single operator and has no role system.
- The workflow ends at Google Docs export; publishing and translation are out of scope.
- Customer, lead and order data are out of scope.

## Local-only boundary

Until separate written approval:

- Work only in this repository and its dedicated task worktrees.
- Do not configure production deployment or choose a production runtime.
- Do not create a remote repository or add a Git remote. Push only to an existing remote from a dedicated task branch.
- Do not use production credentials.
- Do not modify or import source from reference repositories.
- Reference repositories may be read only for patterns, never for secrets.
- Do not read `.env`, credential, token, key or certificate files.
- Local disposable PostgreSQL/Docker testing is allowed; remove temporary containers after use.

## Xevy and Plane task coordination

- These coordination rules apply to any coding agent coordinating work between Plane and Xevy, regardless of the agent, tool or session used to perform the work.
- Use Plane MCP for Plane reads and updates when it is connected. If Plane MCP is unavailable, use the Plane API tooling in `/apps/mobelaris/plane-qa` instead. Never read, print, log or expose its credentials; use the existing API client and scripts, which load credentials internally.
- Use Plane as the source of the original request and for concise stakeholder communication. Use Xevy for analysis, planning, decisions, subtasks, specifications, execution, review and QA. Treat the repository and test results as the source of truth for implementation state.
- Maintain a one-to-one relationship between Plane and Xevy tasks. Search for an existing linked or referenced Xevy task before creating one; do not create duplicates for the same Plane task.
- If the user supplies a Plane task by code, link or another reference and no corresponding Xevy task exists, always ask the user to confirm whether they want one created before creating anything.
- When creating a Xevy task from a Plane task, copy the Plane task title and description exactly without rewriting, summarising, expanding or otherwise changing them.
- Include the originating Plane task code and link explicitly in the Xevy task description, and also store them in structured metadata when supported. Both the code and link must be present and easy to identify. Because the Plane description must otherwise remain unchanged, append the code and link as a clearly labelled reference section.
- Treat the Plane task as the stakeholder-facing record. Plane comments must use concise, plain language and include only relevant requirements, decisions, outcomes, blockers and verification information. Keep agent names, execution details, internal stages, transcripts, session locks, Xevy identifiers and other internal workflow details out of Plane.
- Treat the original Plane task as the source of user intent. Do not silently change its scope or requirements in Xevy; obtain explicit user confirmation for scope changes and record the agreed change clearly. If Plane, Xevy and the implementation conflict, stop and ask the user which direction to follow.
- Before starting or resuming implementation, check the linked task's current Xevy activity, active coding or Dev Sessions, branch, worktree and pull request. Resume or coordinate with existing work instead of creating a competing implementation. Do not take over another active session or branch without explicit user approval.
- When handing work between agents or sessions, provide the objective, agreed scope, completed work, remaining work, decisions, blockers, branch/worktree, pull request and test results. Never include secrets or raw transcripts.
- Before running any Xevy `analyze`, `plan`, `mark ready` or `execute` command for a task connected to Plane, first re-read the Plane task's current status and recent comments, then set its status to `In Progress`. This update is a strict prerequisite: confirm it succeeded before running the Xevy command. If the Plane update fails, stop and report the failure; do not run the command. Do not synchronise any other status changes to Plane.
- After both analysis and planning are complete, add one consolidated comment to the linked Plane task summarising the substantive analysis and plan. Do not post separate analysis and planning comments.
- If work is blocked by a human decision, add a concise Plane comment explaining the question, its impact and what is needed to continue. Do not include internal decision IDs or tooling details.
- Before posting an automated Plane milestone comment, check whether an equivalent update already exists and avoid duplicate comments.
- If a Plane status or comment update fails, do not report or imply that synchronisation succeeded. Surface the failure clearly and retry only when it is safe to do so.
- Never close, complete, cancel or otherwise move a Plane task out of `In Progress` automatically. Do not set `PR Subitted`, `PR Review`, `Testing on Live`, `Done` or `Cancelled` unless the user explicitly instructs it. Pushing code alone never means the task is complete.

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

## Git workflow rules

### Branching and worktrees

- One branch per task: every task must have its own dedicated branch and worktree. Never edit files directly in the main worktree; it serves only as the integration target.
- Name branches according to the type of work:
  - `feature/TASKCODE-slug` for features and enhancements.
  - `fix/TASKCODE-slug` for bug fixes.
  - `hotfix/TASKCODE-slug` for urgent production fixes.
- Use a short, lowercase, hyphenated slug and include the task code for traceability.
- Create each task branch from the branch currently checked out in the main worktree; do not assume `main` or `master`.
- Place each task worktree in a sibling directory to the main repository, for example `../TASKCODE-slug`.
- When resuming work, pull the task branch before making changes and resolve any conflicts first.
- After a merge, remove the task worktree and delete the local task branch.

### Commits, pushes and amending

- Commit and push after each meaningful implementation iteration. Do not accumulate unrelated or large uncommitted changes.
- Keep one logical change per commit.
- Use the commit format `<type>(<module>): <imperative summary>`:
  - Valid types: `feat`, `fix`, `refactor`, `docs`, `chore`, `perf`, `test`, `security`.
  - Scope: the relevant application module, such as `pipeline`, `drafts`, `findings`, `references`, `export`, `calibration`, `auth` or `ui`.
  - Summary: lowercase, imperative, fewer than 72 characters and no trailing period.
  - Example: `feat(findings): add bulk acceptance controls`.

#### Amend versus new commit

- Decide from inside the task worktree while its task branch is checked out.
- Amend only when the new changes directly continue the latest commit from the same task and logical change.
- Touching the same file is not sufficient; the purpose of the change must also be the same.
- Never amend:
  - A commit inherited from the main worktree's branch.
  - A commit belonging to another task.
  - A commit containing another contributor's work.
  - A commit when amend safety is uncertain.
- Create a new commit when the change is separate, unrelated or addresses a different issue.
- If the current worktree is the main worktree or its branch is protected, do not commit or amend; switch to the task worktree.
- After amending an already-pushed task commit, push with `--force-with-lease`; never use plain `--force`.
- Use `--force-with-lease` only on isolated task branches after confirming nobody else has updated the remote branch.

### Protected branches

- `main`, `staging` and `master` are protected.
- Never commit or push directly to a protected branch.
- Commit and push task changes only from their dedicated task branches.
- If an agent discovers it is working on a protected branch, it must stop and switch to the correct task worktree.

### Merging

- Before merging, pull the latest changes from both the source task branch and the target branch.
- The merge target is the branch currently selected in the main worktree, not automatically `main` or `master`.
- Push the updated task branch and provide a pull request link for review.
- Agents must not merge automatically.
- Merging into the main worktree's branch is allowed only when the user explicitly commands it.
- Always use `--no-ff` so the task remains represented by a merge commit and can be rolled back cleanly.
- After confirmed merge completion, remove the task worktree and delete the local task branch.

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

Do not claim success without command output. Follow the Git workflow rules above for commits and pushes.

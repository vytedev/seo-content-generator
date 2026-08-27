# Mobelaris SEO Content Production

A standalone editorial operations app that turns a validated keyword handoff into a reviewed, traceable Google Docs export through a fixed twelve-step pipeline.

The app is built for Mobelaris blog posts, English (UK), and one operator. It is not an autonomous agent, publishing platform, translation tool, or keyword-research tool.

The delivery baseline is the current product in this repository. Historical MM03-01 requirements provide context but do not override newer decisions or current checked-in contracts. Development now prioritises smooth operation and production readiness; see [`docs/current-product-production-readiness.md`](docs/current-product-production-readiness.md).

## What it does

- Accepts a strict JSON content handoff
- Discovers and verifies relevant internal links
- Generates a structured article draft
- Runs deterministic SEO and editorial checks before model reviews
- Reviews style, information gain, factual claims, and link alignment
- Gives the operator one normal findings-review step with bulk decisions
- Applies accepted findings through a controlled, auditable revision
- Reruns deterministic checks and performs bounded coherence review
- Exports idempotently to Google Docs
- Provides a standalone draft checker and calibration workspace

## Pipeline

| Step | Operation                                     |
| ---- | --------------------------------------------- |
| 1.1  | Ingest handoff                                |
| 1.2  | Internal link discovery                       |
| 1.3  | Draft                                         |
| 1.4  | Automated checks                              |
| 1.5  | Writing format and style review               |
| 1.6  | Unique value and information-gain review      |
| 1.7  | Fact checking                                 |
| 1.8  | Internal linking and conversion review        |
| 1.9  | Operator findings review                      |
| 1.10 | Controlled revision pass                      |
| 1.11 | Automated checks rerun                        |
| 1.12 | Final coherence review and Google Docs export |

The canonical order is defined in [`src/shared/pipeline.ts`](src/shared/pipeline.ts).

## Technology stack

### Application

- TypeScript with strict mode
- React 19
- Vite 7
- Express 5
- PostgreSQL
- Drizzle ORM and append-only SQL migrations
- Zod boundary validation

### Interface

- Tailwind CSS 4
- Radix UI primitives
- shadcn-style local components
- Lucide icons
- Responsive, accessible editorial workspace

### Integrations

- OpenRouter or Hugging Face with an explicitly pinned model
- Google Docs and Drive through in-app OAuth
- Optional Google Search Console enrichment
- Public Mobelaris sitemap and storefront verification

### Quality

- Vitest
- Testing Library
- Prettier
- TypeScript type checking
- PostgreSQL integration and invariant tests
- Stateful Google Docs structural simulation

## Repository structure

```text
src/
├── client/                 React operator interface
├── db/                     Drizzle schema and reference seed data
├── server/
│   ├── auth/               Single-operator authentication
│   ├── pipeline/           Twelve-step orchestration
│   ├── providers/          Model, Google, link, and fact providers
│   ├── repositories/       PostgreSQL and memory persistence
│   ├── routes/             Express API routes
│   └── services/           Export, calibration, and support services
└── shared/                 Framework-neutral contracts and rules

drizzle/                    Append-only SQL migrations
references/drafts/          Versioned local reference drafts
tests/                      Unit, component, integration, and simulator tests
docs/                       Architecture, operations, and handover guides
```

## Local setup

For the complete handover procedure—including PostgreSQL, operator authentication, Google OAuth, model configuration, migrations, and reference data—read:

**[`docs/local-handover-setup.md`](docs/local-handover-setup.md)**

Quick start:

```bash
npm ci
cp .env.example .env
npm run auth:setup
npm run dev
```

Open the development interface at:

```text
http://127.0.0.1:5173
```

The local API runs at:

```text
http://127.0.0.1:3110
```

A configured local PostgreSQL database and the required `.env` values are needed for the full pipeline.

## Common commands

```bash
npm run dev          # Start API, web client, and watched client build
npm run build        # Build client and server
npm start            # Start the built local app
npm run check        # Formatting check, typecheck, and tests
npm run format       # Apply repository formatting
npm run db:generate  # Check/generate Drizzle migration metadata
npm run auth:setup   # Create the local operator login safely
```

## Configuration and secrets

Use [`.env.example`](.env.example) as the variable template.

Never commit or share the real `.env`. Each installation should create its own:

- PostgreSQL connection
- Operator password and session secret
- Google token-encryption key
- Google account connection

Provider keys and OAuth secrets must be transferred through an approved private secret-sharing channel.

## Verification

Before handing over a change, run:

```bash
npm run format
npm run check
npm run db:generate
npm run format:check
git diff --check
```

PostgreSQL integration suites are opt-in and must use a separate disposable local database:

```bash
TEST_DATABASE_URL=postgresql://LOCAL_USER:LOCAL_PASSWORD@127.0.0.1:LOCAL_PORT/mm0301_test npm test
```

Never point `TEST_DATABASE_URL` at the operator, shared or deployed database. When database invariants change, also apply all migrations to disposable PostgreSQL and run:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db-invariants.sql
```

## Project boundaries

- Mobelaris blog posts only
- New content only
- English (UK) only
- Single operator
- Ends at Google Docs export
- No publishing or translation
- No customer, lead, or order data
- Local-only until production runtime is separately approved

See [`AGENTS.md`](AGENTS.md) for engineering invariants and [`.xevy/design.md`](.xevy/design.md) for the interface design system.

# Current product and production-readiness baseline

## Delivery basis

MM03-01 now follows the **current SEO Content Generator implemented in this repository**.

The original task description, early plans and superseded decisions remain useful history, but they are not a checklist that must be restored when they differ from the current product. Future analysis, fixes and reviews must start from:

1. the current application behaviour and source code;
2. newer recorded decisions;
3. active locked contracts and current task notes;
4. the current checked-in documentation;
5. the original task only as historical context for requirements still retained.

Do not remove a useful current capability merely because it differs from an older description. Do not reintroduce obsolete integrations or flows unless the operator explicitly approves that product change.

## Primary goal

The goal is a production-ready SEO Content Generator that works smoothly for its operator.

Production readiness means more than a passing happy path. The current product must provide:

- correct end-to-end behaviour;
- clear operator states and recovery actions;
- durable PostgreSQL state and restart recovery;
- bounded and safe provider calls;
- protection against uncontrolled duplicate paid work;
- immutable and traceable document, finding, evidence and export history;
- strict input and provider-response validation;
- honest handling when an integration is absent or fails;
- no test/mock result presented as production success;
- secure authentication, configuration and secret handling;
- production hosting and operational health appropriate to the deployed environment;
- focused tests for normal flow, failure, replay and recovery.

## Review approach

Reviews should be practical and developer-focused. For each pipeline area, report:

| Area    | Working now        | Production ready | Evidence        | Problem                  | Where to fix          | Priority                      |
| ------- | ------------------ | ---------------- | --------------- | ------------------------ | --------------------- | ----------------------------- |
| Example | Yes / Partial / No | Yes / No         | Files and tests | Concise operational risk | Exact module/function | Blocker / High / Medium / Low |

Distinguish clearly between:

- a working happy path;
- smooth operator experience;
- crash/retry safety;
- production readiness;
- behaviour that still needs an authorised live-provider test.

Do not fail a review only because the current product differs from historical task prose. Fail it when the current product is incorrect, unsafe, unreliable, misleading, insufficiently tested or not operable in production.

## Change boundaries

- Preserve the fixed twelve-step pipeline unless a newer explicit product decision changes it.
- Preserve deterministic checks before model judgement.
- Preserve structured findings and controlled revision rather than unrestricted rewriting.
- Preserve Step 1.9 as the only normal human interruption.
- Never export a document that fails required deterministic or coherence gates.
- Never weaken safety gates merely to make a run complete.
- Keep historical records readable without forcing new runs to use obsolete contracts.

## Documentation rule

When behaviour changes, update the relevant step document and this baseline if the product direction changes. Historical statements should be labelled historical or superseded rather than silently treated as current requirements.

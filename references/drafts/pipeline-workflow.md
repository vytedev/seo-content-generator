# Pipeline Workflow

> **Status: Task-derived draft — pending editorial approval.**

## Governing behavior

- Execute fixed steps in the defined order; this is not an autonomous agent.
- Validate and commit one step before the next begins.
- Resume from the first incomplete step after interruption.
- Load only the reference versions mapped to the current step.
- Store the prompt, mapped reference versions, pinned model, temperature, response, token usage and cost for model steps.
- Deterministic checks run before probabilistic reviews.
- Reviews emit structured findings only, never rewritten prose.

## Steps

### 1.1 Ingest handoff

- Input: pasted or uploaded handoff JSON.
- Validate the whole object atomically.
- Include optional `client_insights` when supplied.
- Run the approved SERP-composition check as a warning only; provider failure does not block.

### 1.2 Internal link discovery

- Query published Ghost blog posts and relevant GSC pages.
- Rank by relevance, conversion value and hierarchy.
- Verify HTTP 200 and persist the shortlist with daily caching.

### 1.3 Draft

- Load the handoff, link shortlist, writing guide, submission structure and keyword-placement rules.
- Produce body markdown and structured on-page elements.
- Enforce unique angle, in-body commercial links and all on-page elements in the drafting instruction.

### 1.4 Automated checks

- Run code-only checks.
- Emit normalized findings with severity, location, issue, suggested fix and rule reference.

### 1.5 Review writing format and style

- Load the writing guide.
- Judge only non-countable writing and style requirements.
- Return findings only.

### 1.6 Review unique value and information gain

- Assess what the draft adds beyond generic knowledge.
- Use client insights when present.
- Return proposed additions as findings only.

### 1.7 Review fact checking

- Extract all factual claims.
- Route verification by claim type.
- Mark unresolved claims unverified.
- Hard flag provenance and designer attribution.

### 1.8 Review internal linking and conversion alignment

- Code verifies shortlist membership, HTTP status and hierarchy.
- Model judges anchor quality, contextual fit and conversion usefulness.
- Return findings only.

### 1.9 Findings review

- Pause for the operator.
- Group findings by severity.
- Support accept all, selected bulk actions and per-finding accept/reject.
- Persist decisions before continuing.

### 1.10 Revision pass

- Apply only accepted findings to a new immutable document version.
- Do not perform a free rewrite.

### 1.11 Automated checks re-run

- Run the same deterministic checks against the revised version.
- Confirm the controlled edit did not break existing requirements.

### 1.12 Final coherence review and export

- Check grammar, messaging, consistency and redundancy introduced by revision.
- A blocker may return to 1.10 for no more than two cycles; then stop for operator action.
- Render the canonical export and create/retry one idempotent Google Doc.

## Normal human interruption

Step 1.9 is the only normal human interruption. A final-coherence run that exhausts two return cycles is an exceptional blocked state requiring operator action.

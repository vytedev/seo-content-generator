# Step 1.12 — Google Docs export architecture

> **Status: Google Docs writer and coherence operation lifecycle implemented.** The
> historical diagnosis below is retained because it explains why the reread-driven
> writer exists. Step 1.12 durably reserves coherence before provider dispatch,
> checkpoints the validated response, fails closed on ambiguous restart, and replays
> checkpoints without another provider call. See “What was built” at the end.

## Current Step 1.12 gate

Step 1.12 begins only when the current immutable document has a persisted Step 1.11 result with an exact document ID/content-hash match and zero retained or introduced deterministic blockers. A Step 1.11 history row marked `succeeded` is not sufficient by itself. Coherence findings remain restricted to exact changed locations, and Google export cannot start while deterministic or coherence blockers remain.

The normal Google writer is idempotent and reread-driven as documented below. Coherence has revision-equivalent durable `provider_in_flight` ambiguity protection: only a provably undispatched configuration failure may release the reservation; transport, timeout, malformed-success and restart ambiguity never trigger a second paid call. Successful provider responses used by the bounded corrective request contribute their independently validated usage and cost to the one checkpointed operation total, including safe usage from a malformed successful envelope; malformed choices and content are never trusted.

The export service repeats the final gate independently: the exact current document must have a checkpointed coherence response joined to its matching `final_coherence_export` provider operation and producing execution, and that execution must be the currently fenced Step 1.12 attempt. Any persisted Step 1.12 blocker for that document refuses export. Provider-operation existence alone is not completion evidence.

The dedicated export retry route is narrower than general pipeline resume. It requires all of: `retryable_failed` run state at `final_coherence_export`, a latest Step 1.12 attempt in `retryable_failed` with the safe `stage=google_docs_export` diagnostic, and a persisted failed export operation. Enqueue-error fallback returns the durable detail only when a refreshed read still proves that exact predicate; coherence and other retryable failures remain typed conflicts.

This change was verified without credentials or network access. **Live Google verification remains pending; no live Google call was made.** The real run and database were not queried.

## 1. What actually failed (run `67aa0ce9…`, document version `b497112e…`)

Two different failures, in sequence, both inside the **same table**:

| Attempt | `request_index` | Request                       | Google reason           |
| ------- | --------------- | ----------------------------- | ----------------------- |
| 1, 2    | 762             | `updateTableCellStyle`        | `table_request_invalid` |
| 3, 4    | 765             | `insertText` at index `25685` | `invalid_batch_request` |

The per-table request order emitted by `nativeRequestsForOperations`
([google-docs.ts:2566-2650](../src/server/providers/google-docs.ts#L2566-L2650)) is:

```
insertTable
  … per cell: insertText, updateParagraphStyle/updateTextStyle, styles …
762  updateTableCellStyle   (padding + alignment, whole table)
763  updateTableCellStyle   (header background, row 0)
764  pinTableHeaderRows
765  insertText             ← first top-level text AFTER the table
```

So attempts 1–2 died on the _first_ table-scoped request; after
`tableStartIndex = tableIndex + 1` was corrected they got past all three
table requests and died on the _next_ one instead.

**This is not a bullet problem and not a styling problem.** Both failures are the
same underlying defect: the exporter computes absolute document indices
analytically, and the table's index arithmetic is wrong in a way that only shows
up for particular shapes. Fixing the table-start constant simply moved the
failure one request later, from "where does the table begin" to "where does the
table end".

The reserved document was **empty** at the time (`operation_count=0`,
`expected_operation_count=104`), so this is the full write, not a partial
recovery artefact.

## 2. The failing table's dimensions

Cannot be determined from the logs alone — no log field carries rows/columns, and
reading the run's stored operations is out of scope here. It is derivable offline
from the canonical export operations for `b497112e…` (the operation immediately
preceding the `insertText` at request 765). The important point is that it should
not matter: the exporter must be correct for _all_ rectangular tables.

## 3. Root cause: analytic index prediction, validated against itself

`nativeRequestsForOperations` builds **one atomic `batchUpdate`** (~800 requests)
against a document it never reads, computing every absolute index from source
text lengths and two hand-derived table formulas:

```ts
const tableSize = 2 * rows * columns + rows + 2; // line 2584
cellIndex = tableIndex + 4 + r * (2 * columns + 1) + c * 2; // line 2592
```

Every later index is `previousIndex + predictedDelta`. A single wrong delta
anywhere shifts **every subsequent request**, and Google rejects the whole batch
atomically. That is precisely the observed behaviour: correct the table start,
and the error reappears at the next index that depends on the table's size.

Google's own rules that this design must reproduce by hand, and currently gets
wrong for some shapes:

- `insertTable` inserts a **newline before** the table; the table's official
  start is the requested index **+ 1**.
- `insertText` must target an **existing paragraph**. A computed table boundary
  is a structural position, not necessarily a paragraph you may type into.
- `createParagraphBullets` **consumes leading tab characters** used for nesting,
  which retroactively shortens the text and shifts every following index.
- `batchUpdate` validates the whole sequential request set atomically.

### Why the tests never caught it

Two independent reasons, both fatal:

**(a) The test doubles do not model a document.** The `batchUpdate` mock is:

```ts
if (target.includes("batchUpdate")) {
  batch = JSON.parse(String(init?.body)).requests;
  return new Response("{}"); // unconditional 200
}
```

([google-docs-export-hygiene.test.ts:97-100](../tests/google-docs-export-hygiene.test.ts#L97-L100),
same shape in [google-docs-roundtrip.test.ts:644-651](../tests/google-docs-roundtrip.test.ts#L644-L651))

It captures the requests and returns success. It never applies them, never tracks
a length, never checks that an index exists. Index `25685` into a document that
has no such position passes every test in the suite.

**(b) The tests re-implement production's formula verbatim**, so they assert that
the code agrees with a copy of itself:

| File                                                       | Duplicated arithmetic |
| ---------------------------------------------------------- | --------------------- |
| `src/server/providers/google-docs.ts:2584,2592,2649`       | source of truth       |
| `tests/google-docs-export-hygiene.test.ts:216,229`         | same two formulas     |
| `tests/google-docs.test.ts:412-416`                        | same two formulas     |
| `tests/synthetic-deterministic-v2-e2e.test.ts:173,180,341` | same two formulas     |
| `tests/google-docs-roundtrip.test.ts:286,345`              | same two formulas     |

If the formula is wrong relative to _Google_, all five agree and all five pass.
This is why the cycle repeats: submit JSON → new shape → new failure → adjust a
constant → that JSON passes → next JSON fails somewhere else.

## 4. Which operations move later indices

Anything whose emitted length differs from its source length:

- `insertTable` — adds a preceding newline plus the full table skeleton.
- Table cell text — inserted in reverse cell order (correct), but the running
  cursor must still account for every cell.
- `createParagraphBullets` — deletes the leading nesting tabs it consumes.
- `toDocsText` — maps `\n` to U+000B inside cells (same length, but the
  distinction between "in-paragraph break" and "new paragraph" is what decides
  whether a later index is a paragraph at all).
- Images / markers, inline link and style ranges.

## 5. Solution options

### Option A — Stateful structural simulator (recommended)

Build an in-repo model of a Google Docs body that implements the documented
structural rules, then:

1. **Production** runs the request list through it to compute indices from the
   simulated document state rather than from source lengths, and to assert every
   `insertText` targets a real paragraph before the batch is sent.
2. **Tests** use the _same_ simulator as the `batchUpdate` double, so a bad index
   fails locally exactly as Google would fail it.

Property tests then generate random valid articles — varying rows, columns, empty
and long cells, nesting depths, adjacent tables, Unicode — and assert the batch
applies cleanly. Deliberate `+1`/`-1` mutations must fail those tests.

- **Pros:** kills the whole class of bug; no network; fast; catches shapes nobody
  thought to write a fixture for; the formula stops being duplicated because
  there is one executor.
- **Cons:** the simulator must be faithful — it is a second implementation of
  Google's rules, and if _it_ is wrong the tests are confidently wrong. Mitigate
  by keeping it small, rule-by-rule, and cross-checking each rule once against a
  real document in a scratch account.

### Option B — Phased writes with reread between phases

Stop predicting. Send structure-creating requests (tables, paragraphs) in one
batch, **reread the document**, then use Google's returned `startIndex`/`endIndex`
values to place text and styling in the next batch.

- **Pros:** indices come from Google, so they cannot drift; this is the only
  option that is correct by construction.
- **Cons:** more round trips; the existing single-shot idempotency/recovery
  contract (reserved document, exact reread verification, `requiredRevisionId`
  fencing) needs a checkpoint per phase so a crash between phases still resumes
  without duplicating content.

### Option C — Semantic components / executors per block type

Replace the one 200-line loop with a small executor per canonical operation
(paragraph, blockquote, list item, image marker, table), each owning its own
"how many indices do I occupy" and "where can text go" logic, driven by a shared
cursor object.

- **Pros:** removes the copy-paste arithmetic; each block type gets its own unit
  tests; adding a block type stops being surgery on a monolith.
- **Cons:** on its own it reorganises the bug rather than removing it — the
  cursor is still predicted. Best combined with A or B.

### Recommended combination

**C + A now, B for tables specifically.** Componentise the block types so the
arithmetic lives in one place per type; put a structural simulator in front of
the batch so a bad index fails locally; and for tables — the one structure whose
geometry Google owns — reread after `insertTable` and take the real cell indices
from the response instead of deriving them.

### Non-negotiable acceptance bar

Adding another valid article JSON must require **zero** changes to the Google Docs
adapter. Anything that only makes this run pass — an unexplained `±1`, a
dimension special case, a fixture-shaped branch — is not a fix.

## 6. Constraints any fix must preserve

Immutable document versions; canonical export operations; export manifests; exact
reread verification; revision fencing (`writeControl.requiredRevisionId`);
idempotent same-document recovery; never silently create a duplicate document.
Phased writes (Option B) are the only proposal that touches these — it needs an
explicit idempotency checkpoint per phase.

## 7. What was built

The live export path no longer predicts a single index.

**Semantic components** — `src/server/providers/google-docs-writer.ts` holds one
component per canonical operation (paragraph, blockquote, list item, image
marker, table). Each declares only the text it contributes and how it is
decorated once its real position is known, so operations compose in any order.

**Phased, reread-driven writes** — `planNextBatch` is a pure function of the
document as Google most recently returned it:

| Position                    | Source                                       |
| --------------------------- | -------------------------------------------- |
| Append point                | the reread document's trailing paragraph     |
| A table's own start index   | read back after `insertTable`, never derived |
| Each cell's paragraph start | read back from the cell, never derived       |

The only arithmetic left is offsets inside a single string the writer itself
authored in a single request, which is exact for any shape. `tableSize` and the
cell-offset formula are gone from the live path.

**Idempotency and fencing** — the adapter reads, plans, writes under
`writeControl.requiredRevisionId`, and reads again. Because the plan is a pure
function of the document, the canonical prefix already in the document _is_ the
checkpoint: an interrupted export resumes with no other state and cannot
duplicate content. A phase that leaves the document unchanged fails closed
rather than looping.

**The simulator is a test oracle only** — `tests/helpers/google-docs-simulator.ts`
executes requests against a document model and rejects invalid positions the way
Google does. `tests/helpers/simulated-google.ts` wires it in as the Drive/Docs
double, replacing the ones that returned HTTP 200 unconditionally. Production
never consults it.

**The acceptance property** — nothing in this repository is independent ground
truth for Google's table layout, so the simulator can present several plausible
geometries. A predicted-index writer passes exactly the one it assumes; a
reread-driven one passes all of them. Both the writer suite and the adapter
end-to-end suite run every shape under every variant.

### Still predicted, and why

Two paths retain the old arithmetic and were deliberately left alone:

- `exportBodyMarkerV1` and its `nativeRequests` helper — unreachable; no caller.
- `repairHistoricalTableCorruption` (v1 and v2) — reachable only for the one
  proven historical corruption, against documents whose shape is already proven
  before any write.

Neither is on the path a new article takes.

<!-- xevy:document-id: 33bafb64-d0de-4af0-bd8c-30eb4a489cdd -->

# Mobelaris SEO Production — Design System

## 01. Product register

**Product:** Mobelaris SEO Production
**Type:** Internal editorial operations application
**Primary use:** A single operator turns a validated keyword handoff into a reviewed, traceable, export-ready blog post through a fixed twelve-step production pipeline.

The interface must feel like a **calm editorial desk**, not a generic analytics dashboard, AI chat interface, or marketing product.

## 02. Product principles

1. **Make state unmistakable**
   The operator should always understand what stage the document is in, what completed, what is waiting, and what requires action.

2. **Use structure instead of decoration**
   Fine rules, considered spacing, type hierarchy, and alignment are preferred over card grids, shadows, ornamental icons, and colour-heavy panels.

3. **Keep the operator in control**
   The pipeline is fixed. The app does not use a chat or "agent" metaphor. Human input is required only for explicit review decisions.

4. **Treat the document as editorial content**
   System data is compact and operational; the article preview should read like an editorial document with a distinct prose typeface.

5. **Reduce ambiguity, not add visual interest**
   Every border, colour, status, surface, and transition must communicate structure or state.

## 03. Visual personality

### Character

- Calm
- Exact
- Editorial
- Premium
- Operational
- Restrained
- Traceable
- Light-mode only

### Anchors

- Dense operational navigation without visual noise (Linear)
- Familiar editorial document hierarchy (Notion / Google Docs)
- Crisp, square control language
- Warm paper-like interface surfaces
- Clear workflow progression

### Anti-references

- SaaS KPI dashboards
- Large metric cards
- Generic rounded-card grids
- Chat and assistant interfaces
- Bright blue product UI
- Glassmorphism
- Decorative gradients
- Excessive animation
- Pill-shaped buttons
- Dark mode

## 04. Brand provenance — Mobelaris storefront

Reference evidence from a read-only public audit of `https://www.mobelaris.com/en`. Only brand cues carry over — never commerce navigation, product grids, promotional layout or hero imagery. Licensed storefront assets and webfonts must never be copied or bundled; this repository's approved local wordmark files (`src/client/assets/LOGO-MOBELARIS_Final.webp`, `src/client/assets/Mobelaris-Logo-M.png`) are used instead.

- **Display character:** the storefront's bold condensed uppercase display treatment is realised through **Barlow Condensed** (SIL OFL) for screen titles — no licensed font required.
- **Neutrals:** warm, low-chroma paper neutrals retained over pure white/cool grey — gentler for long editorial sessions, aligned with the storefront's restrained neutral family.
- **Accent:** Mobelaris orange `#FF9800` is the app's **sole interactive accent**. Primary controls use white text to match the approved storefront direction. This is a recorded operator-approved contrast exception: white on `#FF9800` does not meet WCAG AA for normal text. Purple and generic SaaS blue remain excluded.
- **Controls:** the storefront's crisp, thin-bordered, uppercase CTAs translate into square 2px-radius, bordered controls with normal-case labels and no promotional urgency.
- **Layout:** maximum content width ~1264px, 16px mobile / 32px larger gutters, strong horizontal-rule discipline.

Explicitly **not** carried over: sale/promotional devices, oversized numeric displays, coloured sale labels, drop shadows on display type, dropdown mega-menus, payment iconography, product card grids, commerce navigation, hero/banner composition.

## 05. Colour system

Strategy: **Restrained** — warm-tinted neutrals plus one Mobelaris orange interactive accent. Theme: **light-mode only** (no dark tokens exist anywhere in `tokens.css`). Scene: an editor at a quiet desk in soft daylight, moving between a manuscript, margin notes and source evidence.

Use shared custom properties. Do not scatter raw colour values across components. The hex values below are canonical; the OKLCH column is the implementation form used in `src/client/styles/tokens.css` (Tailwind v4 works natively in OKLCH).

```css
:root {
  /* Core surfaces */
  --bg: #f8f6f2;
  --paper: #fffefd;
  --subtle: #f2efea;

  /* Text and structure */
  --ink: #4a4a4a;
  --muted: #4b5563;
  --line: #dcd5cc;

  /* Interactive accent */
  --accent: #ff9800;
  --accent-hover: #e08700;
  --accent-active: #c77700;
  --accent-tint: #fff3e0;
  --accent-tint-active: #ffe8c2;
  --accent-link: #a64b00;
  --accent-link-hover: #8f4100;
  --on-accent: #ffffff;
  --focus-orange: #c77700;

  /* Semantic status */
  --success: #4e8f61; /* oklch(0.594 0.097 152) */
  --warning: #ae7a18; /* oklch(0.617 0.122 77) */
  --danger: #b24d42; /* oklch(0.549 0.134 28) */
  --info: #527ba0; /* oklch(0.568 0.074 247) */

  /* Accessibility */
  --ring: #7f3928; /* oklch(0.434 0.101 35) */
}
```

### Colour roles

| Token                                | Use                                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| `--bg`                               | Main application canvas                                         |
| `--paper`                            | Inputs, document surfaces, sidebar, grouped panels              |
| `--subtle`                           | Selected sidebar row, quiet secondary background                |
| `--ink`                              | Primary text, title rule, completed workflow segments           |
| `--muted`                            | Supporting copy, queued state, secondary metadata               |
| `--line`                             | Hairline dividers, input borders, panel borders                 |
| `--accent`                           | Primary buttons and active interactive state                    |
| `--accent-hover` / `--accent-active` | Primary button hover and pressed states                         |
| `--accent-tint`                      | Outline/ghost button hover and selected utility state           |
| `--accent-link`                      | Accessible text-link orange                                     |
| `--on-accent`                        | White text/icons on primary orange; recorded contrast exception |
| `--focus-orange`                     | Darker orange field border/ring on keyboard and pointer focus   |
| `--success`                          | Succeeded status with text and icon/dot                         |
| `--warning`                          | Waiting status with text and icon/dot                           |
| `--danger`                           | Blockers and required intervention                              |
| `--info`                             | Informational findings and non-blocking system status           |
| `--ring`                             | Focus ring — dark warm brown, independent from button fill      |

### Implementation token mapping

`tokens.css` exposes these values under `--color-*` names (the spec names above are the design vocabulary; the `--color-*` names are the code). The shadcn semantic layer (`--background`, `--primary`, `--sidebar-*`, etc. under `@theme inline`) is a thin alias over the same values — there is one palette, never a second visual system.

| Spec token        | Implementation token       |
| ----------------- | -------------------------- |
| `--bg`            | `--color-canvas`           |
| `--paper`         | `--color-paper`            |
| `--subtle`        | `--color-subtle`           |
| `--ink`           | `--color-ink`              |
| `--muted`         | `--color-muted`            |
| `--line`          | `--color-rule`             |
| `--accent`        | `--color-action`           |
| `--accent-hover`  | `--color-action-hover`     |
| `--accent-active` | `--color-action-active`    |
| `--accent-tint`   | `--color-action-tint`      |
| `--accent-link`   | `--color-action-link`      |
| `--on-accent`     | `--color-on-action`        |
| `--focus-orange`  | `--color-focus`            |
| `--success`       | `--color-success`          |
| `--warning`       | `--color-warning`          |
| `--danger`        | `--color-danger`           |
| `--info`          | `--color-info`             |
| `--ring`          | `--color-focus` / `--ring` |

### Colour rules

- The UI is light mode only.
- Mobelaris orange is the only interactive product accent.
- Status colours are secondary and must never communicate status by colour alone — always pair with text, a small icon, or a dot.
- Completed workflow segments may use near-black (`--ink`) fill with white/paper text.
- Do not use gradients. Do not use decorative coloured side borders. Do not use large coloured background areas except restrained inline alert states.

> **Orange update (v4):** the shared button system uses exact `#FF9800` with white content to follow the operator-approved storefront direction. Hover is `#E08700`, active is `#C77700`, outline/ghost controls use dark-orange text and orange borders/tints, and focused fields use a darker orange border/ring. White on `#FF9800` is a documented contrast exception and does not meet WCAG AA for normal text.

## 06. Typography

Four roles, no overlaps.

### Font delivery

The spec families document the type system; **delivery stays locally vendored**: all four families are SIL OFL and resolve to self-hosted `woff2` files registered with `@font-face` in `src/client/styles/tokens.css`. Nothing is fetched from a CDN at runtime; ASCII/system fallbacks remain in every stack. No additional fonts may be introduced, and roles must not be reassigned.

```css
/* Canonical import (reference only — vendored locally in this app):
   Barlow+Condensed:600,700,800 · Inter:400,500,600,700
   JetBrains+Mono:400,500 · Source+Serif+4:500,600 */
```

### 01. Barlow Condensed — page and screen titles only

Weights: 600, 700 available; **800 default**. Used for the single top-level page heading per screen (e.g. "Blog post") and nothing else.

```css
font-family: "Barlow Condensed", Arial, sans-serif;
font-weight: 800;
```

| Token                  | Size    | Use                |
| ---------------------- | ------- | ------------------ |
| `text-screen-title`    | 28–30px | Mobile page title  |
| `text-screen-title-lg` | 30–34px | Desktop page title |

Do not use Barlow Condensed for buttons, form controls, navigation, status labels, or long-form document text. Implemented as `font-screen-title` on `PageHeader`'s `<h1>` (`text-screen-title lg:text-screen-title-lg`).

### 02. Inter — standard product UI

Weights: 400, 500, 600, 700. Navigation, buttons, labels, inputs, supporting copy (including the former retired Calibri Light `font-editorial` role), helper text, panel titles, status text, summary rows, account details.

```css
font-family: Inter, Arial, sans-serif;
```

| Token          | Size    | Use                              |
| -------------- | ------- | -------------------------------- |
| `text-ui-xs`   | 10–12px | Tiny support labels, eyebrows    |
| `text-ui-sm`   | 12–14px | Metadata, helper text, controls  |
| `text-ui-base` | 13–15px | Standard controls and navigation |
| `text-ui-body` | 14–16px | Supporting copy                  |

### 03. JetBrains Mono — system and machine-readable content

Weights: 400, 500, `font-variant-numeric: tabular-nums`. Workflow numbers (01, 02…), pipeline IDs (1.1, 1.9, 1.12), JSON handoffs, keys such as `primary_keyword`, idempotency keys, run IDs, audit lineage, costs and unit counts, versions, slugs, "Draft 01".

| Token            | Size    | Use                                |
| ---------------- | ------- | ---------------------------------- |
| `text-mono-xs`   | 9–10px  | Workflow strips and micro metadata |
| `text-mono-sm`   | 10–12px | IDs, JSON, cost, status details    |
| `text-mono-base` | 12px    | Readable system values             |

### 04. Source Serif 4 — editorial document content only

Weights: 500, 600. Current-document article title, article headings, article body copy, italic standfirst/meta description. Never for product UI.

```css
font-family: "Source Serif 4", Georgia, serif;
```

| Token                      | Size        | Use                       |
| -------------------------- | ----------- | ------------------------- |
| `text-document-title`      | 28–32px     | Document title            |
| `text-document-heading`    | 19–21px     | Article section heading   |
| `text-document-body`       | 15–16px     | Article paragraph         |
| `text-document-standfirst` | 16px italic | Editorial meta/standfirst |

### Type rules

- Use the named tokens (`text-screen-title`, `text-h2`, `text-h3`, `text-body`, `text-document`…) — never one-off arbitrary sizes (`text-[…]`) for headings or document copy.
- 600 weight for UI headings/actions; 400–500 for body.
- Document measure: 65–75 characters (`max-w-[70ch]`/`max-w-[72ch]`).
- Costs, durations and counts use tabular numerals.
- Monospace is reserved for IDs, hashes, rule references, JSON-ish diagnostics and raw code — never prose.

## 07. Layout system

### Application shell

Implemented by `src/client/components/AppShell.tsx` (`SidebarProvider` → `AppSidebar` → `SidebarInset`); `SidebarInset` is the page's single `<main>` landmark, labelled per-screen via `aria-labelledby` pointing at the screen's `PageHeader` id.

```
┌────────── sidebar 256px ──────────┬──────────── main workspace ────────────┐
│  MOBELARIS (wordmark / framed M)  │  Eyebrow + title + 2px rule            │
│  SEO PRODUCTION                   │  Supporting copy                       │
│                                   │                                        │
│  Workspace                        │  Workflow breadcrumb / progress strip  │
│  ├─ Blog post                     │                                        │
│  └─ Writing guides                │  Primary working surface               │
│                                   │  (document + right-context panel)      │
│  Tools                            │                                        │
│  ├─ Check a draft                 │                                        │
│  └─ Calibration                   │                                        │
│                                   │                                        │
│  Local operator                   │                                        │
└───────────────────────────────────┴────────────────────────────────────────┘
```

- Collapsed desktop rail: 64px icon rail with Radix `Tooltip` labels; full label always present for assistive tech.
- Mobile/tablet (`md` breakpoint): the sidebar renders as a Radix `Sheet` drawer, width `min(18rem, calc(100vw - 2rem))`; selecting a destination closes it.
- Sticky `header` (`h-14`, hairline bottom border, translucent blur) holds only the `SidebarTrigger`.

### Widths and gutters

| Element                   | Value                                         |
| ------------------------- | --------------------------------------------- |
| Sidebar (expanded / rail) | 256px / 64px                                  |
| Content horizontal gutter | 32px desktop (`px-8`), 24px `sm`, 16px mobile |
| Desktop content maximum   | ~1264–1290px                                  |
| Form/document main column | 520–650px (measure-capped prose 65–75ch)      |
| Right-context panel       | 240–320px (`xl:sticky`)                       |
| Pipeline rail             | 255–285px                                     |

### Operator login composition

The authentication screen is a focused exception to the compact application shell, not a reusable card pattern. It preserves the Mobelaris header, warm paper surface and existing editorial image.

- The composition is capped at **384px on mobile** (`max-w-sm`) and **1024px from desktop** (`md:max-w-5xl`).
- At `md` and above it becomes a two-column surface with a minimum height of **512px** (`md:min-h-[32rem]`); below `md`, the decorative image column remains hidden.
- Main padding is 24px on smaller screens and 40px from `md`; form padding progresses from 32px to 40px and 56px.
- The page header has 32px separation before the form. Form fields follow a roomier 28px rhythm.
- Email and password fields, the password-visibility target and sign-in button are all **48px high/wide touch targets** as applicable. The fields use a softer 12px radius; the visibility target follows the password field's 12px right-hand curvature; the action remains at 6px.
- “Local operator access” sits outside the surface with 32px separation and a ruled divider.

### Responsive breakpoints

Tailwind v4 defaults, used consistently: `sm` 640, `md` 768 (sidebar mobile/desktop switch), `lg` 1024, `xl` 1280. Verified structurally at 390 / 768 / 1024 / 1440px.

### Responsive rules

- Never allow the page body to cause horizontal scrolling.
- Tables, long IDs, code and JSON scroll inside their own containers (`overflow-x-auto`).
- On narrow screens, stack right context below the document; keep the sticky findings action bar clear of focused controls.
- On mobile the sidebar is the Sheet drawer (above).
- Workflow strips scroll horizontally rather than wrapping into uneven lines.

## 08. Spacing system

4px base scale:

```
4px   micro gap
8px   tight control gap
12px  compact section gap
16px  normal internal padding
24px  section spacing
32px  major content spacing
48px  screen-level separation
```

Principles: use whitespace to establish hierarchy; prefer vertical rhythm and hairline dividers over nested panels; keep operational lists compact; keep editorial document content more generous than the surrounding UI; avoid excessive empty card padding.

## 09. Borders, radius, and elevation

**Borders**

- Default structural border: `1px solid var(--line)` (`border-rule`).
- Page title rule: `2px solid var(--ink)` (near-black).
- Current pipeline row: restrained orange left edge or outline — this is a state indicator, not decoration, and is the single sanctioned use of an accent edge.
- Active workflow segment: orange border.

**Radius**

| Element                                    | Radius                         |
| ------------------------------------------ | ------------------------------ |
| Application buttons and single-line inputs | 2px (`rounded-control`/`md`)   |
| Shared application textareas               | 6px (`rounded-field`)          |
| Small selection states                     | 2px                            |
| Grouped panels / documents                 | 4px (`rounded-group`/`lg`)     |
| Login surface (login only)                 | 12px (`rounded-login-surface`) |
| Login email/password fields                | 12px (`rounded-login-field`)   |
| Login sign-in action                       | 6px (`rounded-login-control`)  |
| Status pills                               | compact only; restrained       |

The login's **12px outer surface, 12px fields and 6px action geometry is an explicit login-only exception**. The password visibility control follows the field's 12px right edge rather than introducing another shape. Shared ordinary application textareas use the approved 6px field radius; application buttons and single-line inputs retain compact 2px radii. No field or button may use `rounded-full`.

**Elevation**

- No shadows on normal in-page surfaces or buttons.
- A mobile navigation drawer may use a very restrained shadow because it creates real elevation (the Sheet overlay panel is the one sanctioned instance).
- Borders and spacing create most hierarchy.

## 10. Canonical components

### Page header

Every major screen uses the shared `src/client/components/PageHeader.tsx` — do not fork it:

- Small uppercase letterspaced accessible dark-orange eyebrow (Inter `text-xs`)
- Barlow Condensed 800 title (`text-screen-title lg:text-screen-title-lg`) carrying an `id` for `aria-labelledby`
- Near-black 2px rule
- One supporting sentence in Inter, capped `max-w-[70ch]`

```text
IN PRODUCTION
Family travel insurance
━━━━━━━━━━━━━━━━━━━━━━
The pipeline is producing a single exportable document.
```

### Sidebar navigation

- Section labels (Workspace / Tools) in small muted Inter.
- Active item: `--subtle` background plus text weight — never colour alone.
- Icons minimal and secondary (Lucide).
- Local operator account row fixed toward the sidebar bottom (`SidebarAccountMenu`; decorative until real auth exists).
- Collapse state driven solely by the header `SidebarTrigger` with a dynamic accessible name and `aria-expanded`.

### Breadcrumb / workflow strip

Use for the four primary stages — `01 Handoff · 02 Production · 03 Decision · 04 Export`:

- Top and bottom hairline rule; JetBrains Mono; compact horizontal layout.
- Current state in orange with a non-colour current-state cue; inactive states muted.
- Accessible labels for each stage; never render as large tabs or pill buttons.

### Twelve-step pipeline strip

Use for the active production workflow:

```text
01 02 03 04 05 06 07 08 09 10 11 12
```

- Completed: near-black (`--ink`) fill, white/paper mono number.
- Current: paper or pale orange ground, orange border and number.
- Queued: paper ground, warm rule, muted number.

The visible strip shows only numbers; step names surface through accessible labels, tooltips, or the pipeline rail.

### Pipeline rail

Each row: step number, step label, status text with dot/icon, attempt count.

- `● Succeeded` success dot + text · `● Waiting` warning dot + text · `● Queued` muted dot + text · `● Blocked` danger icon + text.
- Stable compact row layout; fine divider between rows; current row receives a quiet selected treatment; no loading glows.

### Document surface

Editorial preview content, reading as a page rather than a dashboard card:

- Mono metadata row → Source Serif 4 article title → accessible dark-orange mono slug → italic Source Serif 4 standfirst → fine divider → article headings and prose.

### Context panel

Compact right-column operational information — one bordered paper panel, sections divided by hairlines, compact label/value rows (`Article status`, `Completion summary`, `Export`, `Audit lineage`). IDs and counts use JetBrains Mono; values align right where appropriate.

### Buttons

All variants live in `src/client/components/ui/button.tsx` (`buttonVariants`, adapted — colours and radius point at the tokens above):

| Variant       | Look                                                                 | Use                                                             |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `default`     | Filled `#FF9800`, white text/icons; darker hover/active              | Primary action — one per view/form; recorded contrast exception |
| `outline`     | Paper background, orange border, dark-orange text; pale-orange hover | Secondary action                                                |
| `secondary`   | Same orange-bordered, dark-orange-text treatment                     | Shadcn-compatible secondary action                              |
| `ghost`       | Transparent dark-orange text; pale-orange hover                      | Low-emphasis/utility                                            |
| `destructive` | Tinted danger background + danger text; unchanged by orange system   | Destructive action                                              |
| `link`        | Text-only dark orange `#A64B00`; darker hover and underline          | Inline text affordances                                         |

- Radius 2px application-wide. The operator login alone uses 12px email/password fields and a 6px sign-in action; never pill shapes, never gradients, no decorative icons without text.
- Primary button text/icons use white on `#FF9800` by explicit operator decision; this is a known WCAG AA exception.
- Outline, secondary, ghost and link buttons use dark-orange text so their labels remain readable on paper/tinted surfaces.
- Inputs, textareas and selects receive an orange border plus darker orange focus ring; focus must remain visible independently of fill.
- Loading and disabled states remain visible and never rely on colour alone.
- Clear `focus-visible` ring (`--ring`); `active:translate-y-px` press affordance; `loading` prop (spinner + `aria-busy` + auto-disable).
- Icon-only actions use `size="icon"` with an explicit `aria-label`.
- Labels direct and verb-led: "Start blog post →", "Submit decisions →", "Review findings →", "Resume safely".

### Status treatment

Compact text-plus-dot labels (`● Succeeded`, `● Waiting`, `● Queued`, `● Blocked`) via the shared `src/client/components/severity.ts` icon + colour treatment — import it rather than hand-rolling glyphs. Never colour alone, oversized badges, large status cards, or pills outside compact status contexts.

### Form surfaces

Handoff intake and draft checking compose the local `Field`/`FieldLabel`/`FieldDescription`/`FieldError`, `Input`, `Textarea` and `NativeSelect` primitives: bordered paper surface, clear Inter labels, native-style controls, JetBrains Mono for JSON/technical data, helper text below the related field, inline validation notices (never a modal). Explicit `htmlFor` and `aria-describedby` associations required.

The shared shadcn-style `Textarea` in `src/client/components/ui/textarea.tsx` is the canonical multi-line control. It uses a warm-paper surface, thin border, 12px horizontal padding, 6px radius, vertical resize, orange focus border/ring, readable placeholder/disabled states and `aria-invalid` error treatment.

#### Select components

The Radix shadcn-style `Select` in `src/client/components/ui/select.tsx` is canonical for styled single-value selection. Compose it with `Field`, `FieldLabel`, `FieldDescription`/`FieldError`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectGroup` and `SelectItem`. The trigger uses a 6px application-field radius, 40px default height (36px compact filter height), warm-paper surface, thin border and orange focus treatment. The portal content is at least trigger width, viewport-bounded, above sticky toolbars, warm-paper, finely bordered and compact; a checkmark identifies the selected item independently of colour.

`NativeSelect` is retained only for an explicitly documented native/mobile platform requirement. `DropdownMenu` remains for actions, account menus and overflow/context menus; never replace those with Select. Reserve Combobox for genuinely long or searchable option sets.

Option values are stable machine contracts and are never transformed to improve presentation. Every option has an explicit sentence-case display label, preserving approved acronyms such as SEO, UK, GSC, QA, API, URL and Google Docs. Do not use CSS `capitalize`/`uppercase` for option text, and do not create empty-string `SelectItem` placeholders; placeholder copy belongs on `SelectValue` (for example, “Choose page type”). Disabled items remain semantic and readable. Draft-checker meta descriptions use a compact `min-h-24` textarea with a visible associated counter and description. Body Markdown uses a taller `min-h-[14rem] lg:min-h-[18rem]`, vertically resizable monospace textarea. Other short multi-line fields choose the smallest appropriate height rather than inheriting one universal size. The 12px login field radius remains login-only.

#### More on-page elements grid

The Check a draft disclosure uses one column by default and switches to two equal columns at `md`, preventing cramped fields on mobile and at 200% zoom. The grid is `items-start` with 16px horizontal and 20px vertical gaps. OG title and OG description occupy the first desktop row: identical `Field` composition and label spacing align their label baselines and control top edges, while OG description keeps a resizable `min-h-24` rather than a fixed height. Slug occupies the next row and spans both columns (`md:col-span-2`) so no unexplained empty cell remains. No absolute positioning, negative margins or vertical centring are permitted.

The full-width disclosure summary aligns text and chevron with `items-center`, exposes `aria-expanded` and `aria-controls`, has a visible focus ring, and labels its directly associated content region.

### Findings review

- Group by severity; stable rows that do not jump when details expand.
- Rule reference in JetBrains Mono.
- Each row: issue, evidence, suggested fix, disposition controls, optional rationale.
- Sticky bulk-action toolbar on desktop and mobile, clear of safe areas and focused controls (implemented by the Blog post findings decision bar).

### Loading and empty states

- Loading: skeletons shaped like the final content (`RunWorkspaceSkeleton`); light shimmer only if necessary; no decorative loader graphics.
- Empty: explain what is missing, give one clear next step, use border and text hierarchy — via the shared `EmptyState` (nested) / `BoxedEmptyState` (standalone) components rather than bespoke boxes or illustrations.

## 11. Motion

Motion exists only to clarify system change.

**Allowed:** short opacity transition for a state update; restrained panel/drawer transition; sidebar width transition; subtle skeleton shimmer.

Implementation: 150–180ms (`duration-[170ms]`) with an ease-out-quart-style curve (`ease-[cubic-bezier(0.25,1,0.5,1)]`), preferring transform/opacity over layout properties. The sidebar expand/collapse is the one deliberate `width` transition (gap and panel together so they never desync). Progress never uses indefinite decorative animation.

**Not allowed:** bounce, elastic easing, continuous decorative pulsing, floating cards, oversized loading animation, parallax, unnecessary hover movement.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 12. Accessibility

- One `h1` per screen (`PageHeader`); `h2`/`h3` in order — never skipped for visual sizing (use named `text-h*` tokens instead).
- Semantic `nav`, `main`, `aside`, `section`, `article`, `form`, `label`, `button`, `table` elements.
- Full keyboard operation; every interactive control has a visible focus state independent of border colour.
- File input, JSON field and form errors associated through labels and descriptions (`aria-describedby`).
- ARIA live region for asynchronous pipeline status.
- Status always text plus colour/icon. Icon-only controls carry accessible names. Breadcrumbs and progress strips carry accessible labels.
- Sticky action bars (header, findings bulk toolbar) must not cover focused content at 200% zoom.
- Body text meets WCAG AA contrast or better. The sole recorded exception is white normal-sized text on exact `#FF9800` primary buttons, accepted by operator decision `62ecc1bf-c121-42b4-8abe-4d05fea79db8`.

## 13. Do not do this

- Do not create a chat or agent interface.
- Do not use generic blue SaaS styling.
- Do not use gradients or decorative glass effects.
- Do not use hero KPI cards or repeated identical card grids.
- Do not deep-nest bordered panels or use huge rounded corners.
- Do not use decorative drop shadows.
- Do not use pill buttons.
- Do not use colour as the only status signal.
- Do not expose raw prompts, provider tokens or internal diagnostics in the primary editorial view.
- Do not create a second visual system beside these tokens (shadcn names are aliases, not decisions).
- Do not use the app as a storefront or marketing landing page.
- Do not add deployment, production or publishing controls during the local-only phase.
- Do not fetch fonts from a CDN — delivery stays locally vendored.

## 14. Implementation checklist

Before considering a new screen complete, check:

- [ ] Light-only warm editorial palette is used.
- [ ] Page title uses Barlow Condensed (vendored), UI uses Inter.
- [ ] IDs, cost, versions, workflow values and JSON use JetBrains Mono.
- [ ] Editorial document content uses Source Serif 4 only.
- [ ] Orange interactive accents, title, 2px rule and supporting sentence establish the page header (`PageHeader`).
- [ ] Borders are hairline and warm; no gradients or decorative shadows.
- [ ] Primary action is obvious but not oversized; login controls use the documented 48px touch-target exception.
- [ ] Status contains text plus colour/icon (`severity.ts`).
- [ ] Desktop and mobile layouts preserve clear hierarchy; no body horizontal scroll.
- [ ] Keyboard focus is visible (`--ring`).
- [ ] The interface reduces ambiguity for the operator.

## 15. Implementation base and pending deltas

### Primitive layer

Built on **shadcn/ui with Radix UI primitives** (`components.json`, `style: "radix-nova"`, iconLibrary `lucide`), vendored under `src/client/components/ui/` and adapted — colours, radius and motion point at this document, never at scaffold defaults. Installed: `Button`, `Sidebar` (+ dependencies), `Sheet`, `Tooltip`, `Separator`, `DropdownMenu`, plus local `Field`, `Textarea`, `NativeSelect`. `cn` in `lib/utils.ts`. The shadcn semantic tokens (`--background`, `--primary`, `--sidebar-*`…) alias the palette in §05; dark-mode tokens were removed entirely.

### Implementation status

All six deltas below have been applied to `tokens.css` and the Blog post feature files:

1. **Orange button system:** ✅ shared default, outline, secondary, ghost and link variants use the canonical §05 orange tokens; destructive remains semantic danger.
2. **Storefront button content:** ✅ primary buttons use white on exact `#FF9800` by recorded operator decision; the known WCAG AA exception is documented.
3. **Orange control focus:** focused inputs and controls use an orange border with a darker orange ring, visible independently of fill.
4. **Screen titles:** ✅ `text-screen-title` is 28px base / `text-screen-title-lg` is 32px `lg:`.
5. **Document type:** ✅ document title (`text-h1`) is 30px, body (`text-document`) is 16px, plus the new `text-standfirst` (16px italic) role, applied to the meta-description paragraph in `RunWorkspace.tsx`.
6. **Barlow Condensed:** ✅ 600/700/800 all vendored locally (`src/client/assets/fonts/`); delivery stays local per §06, not a CDN import.
7. **Workflow components:** ✅ `WorkflowBreadcrumb.tsx` (four-stage strip), `RunWorkspace.tsx`'s `PipelineStrip` (twelve-step numbers-only strip) and pipeline rail (dot/icon status via `StatusBadge.tsx`, current-row orange left edge per §09), and the context panel (one bordered paper `<aside>` with hairline-divided `ContextSection`s).
8. **Operator login geometry:** ✅ 384px mobile / 1024px desktop composition, 512px desktop minimum height, 48px controls, and login-only 12px surface / 12px field / 6px action radii.
9. **Canonical textareas:** ✅ draft-checker multi-line fields use the shared shadcn-style `Textarea`; ordinary application textareas use 6px, while single-line inputs and other application controls retain 2px. Meta description and Body Markdown use distinct compact/tall sizing.
10. **On-page elements alignment:** ✅ accessible full-width disclosure with a top-aligned responsive two-column grid; OG title/description share row one and aligned starts, while Slug spans row two.
11. **Single-value Select:** ✅ calibration runs, findings filters and checker hierarchy use the shared Radix Select with stable machine values and explicit display labels. Account/action menus remain DropdownMenu; NativeSelect remains available only for explicit native-platform cases.

# jobfill — design system

**Direction:** `catalogue-index` — "the spreadsheet of record."
**Established:** 2026-07-25, via a greenfield `/design` run (3 directions explored, this one chosen).
**Reference implementation:** `helper/dashboard.catalogue-index.html`

> **Status: design reference, not yet the live dashboard.** The reference file is
> a self-contained design artifact with inline mock data and **zero `fetch`
> calls**. The live `helper/dashboard.html` talks to 21 endpoints. Adopting this
> system means porting the live data layer into this markup — not renaming a
> file. See "Adoption" at the bottom.

---

## Why this direction

jobfill is a local-first, single-user review console for an agent that runs
overnight. The design is derived from what the product *is*, not from a genre:

| Attribute | How the design expresses it |
|---|---|
| **accountable** | every machine verdict carries its criterion in the same cell — nothing needs a click to learn *why* |
| **consequential** | a rejection is permanent, so the surface reads as a database client / audit log, not a friendly dashboard; destructive acts arm before they fire |
| **unattended-then-audited** | the record dominates; chrome is two thin bars |
| **private** | "localhost · single user" states the boundary in the app bar; no marketing voice anywhere |
| **fast-scan** | fixed table layout, tabular numerals, sticky header, row gutter numbers, sticky status bar with the row count |

**Signature move — the criterion is in the cell.** Every decision renders the
verdict token *and* the criterion that produced it, in mono, split by a hairline:
`rejected │ rules:location`, `held │ seek:jd-fetch-error`, `filled │ fill:14/14`.
Used in queue, seek decisions, applications, failures and runs. This is the
direct visual answer to "a rejection is permanent."

---

## Color

OKLCH throughout. Paper is light-cool and near-white — a precision instrument.

```
--jf-paper       oklch(0.986 0.003 250)   page
--jf-paper-cell  oklch(0.998 0.001 250)   cell / field
--jf-paper-sunk  oklch(0.966 0.005 250)   recessed
--jf-paper-band  oklch(0.940 0.007 250)   section band, table header
--jf-paper-inv   oklch(0.255 0.014 255)   inverse surface
```

Ink ramp, with measured contrast against paper:

```
--jf-ink     oklch(0.255 0.014 255)   12:1
--jf-ink-2   oklch(0.440 0.013 255)   6.9:1
--jf-ink-3   oklch(0.560 0.012 255)   4.7:1
--jf-ink-4   oklch(0.680 0.010 255)   3.1:1  — non-text / sigils ONLY
```

Rules: `--jf-rule` / `--jf-rule-2` / `--jf-rule-strong`.

**One accent, one job.** Amber `oklch(0.795 0.150 78)` means *"needs your
attention / held"* and nothing else. It never tints headings, never decorates.

> **Mix the accent in OKLAB, never OKLCH.** An `oklch` mix walks the hue *arc*
> from amber 78° to the cool paper 250°, so a 20% amber wash renders **cyan**.
> `oklab` is rectangular, preserves perceptual lightness, and stays amber.
> This bit us once; the tokens encode the fix.

Focus ring is ink pulled toward the accent hue via `color-mix`, so it can never
be mistaken for a hover tint or for the accent doing its own job.

---

## Type

Two families, and the split is **meaningful, not decorative**:

- `--jf-mono` **JetBrains Mono** — machine-produced facts: ids, counts, dates, statuses, criteria
- `--jf-sans` **IBM Plex Sans** — human prose: labels, help text, headings

Both self-hosted from `helper/fonts/*.woff2` with `font-display: swap`.
**No CDN, no Google Fonts** — the helper is localhost-only and must render
identically offline.

Scale: `mega` (fluid clamp) · `xl` 1.3125rem · `lg` 1rem · `md` 0.8125rem ·
`sm` 0.75rem · `xs` 0.6875rem · `xxs` 0.625rem.
Line heights: `tight` 1.02 · `data` 1.35 · `prose` 1.55.
Tracking: `tight` −0.022em · `none` · `wide` 0.07em.

---

## Space, radii, depth

- Space: 8 steps, `--jf-s1` 0.25rem → `--jf-s8` 3rem
- Radii: `0 / 1 / 2 / 3px`. **Tops out at 3px — nothing in this instrument is soft.**
- Hairlines: 1 / 2 / 3px
- Shadows: layered 4-stop stacks tinted toward *ink*, never black

---

## Table grammar (the core of the system)

Taken from a real database client, not a dashboard:

1. **Type-sigil column headers** — each data column header carries a mono sigil
   (`T` text, `#` num, date, enum, link) at 10px in `ink-4`. Non-data columns
   (actions) carry no sigil, so the sigil *means* something.
2. **Rules on both axes + hard clip** — `table-layout: fixed`, every cell has a
   right and bottom rule, values ellipsis-clip and never wrap. The cell is a
   fixed viewport onto the value. Header band is one step darker and closes with
   a 2px rule, heavier than row rules.
   - **The one exception:** the criterion may wrap, because truncating it would
     defeat the signature move.
3. **Row gutter numbers** on the left; sticky header; sticky status bar carrying
   row count, active filter, sort, and the db read-only state.

---

## Critical UX contract — fail open

**An empty criteria term list means the rule is DISABLED, never "reject
everything."** Empty states render as a calm neutral hint:

```
0 terms · rule off · no title is rejected for seniority wording
```

This system deliberately **owns no error color for empty states**, so an empty
list is structurally incapable of reading as an error. Inverting this reading is
the project's named catastrophic failure: a rejected posting is never revived by
re-discovery, so one mis-saved list silently loses opportunities permanently.

---

## Hard constraints

- **Vanilla HTML + one inline `<style>` + vanilla JS.** No framework, no build
  step, no npm UI package, no CDN. Locked project decision.
- **Tokens only.** Every value references a `--jf-*` custom property. No raw
  hex, rgba, magic px, or bare easing/duration literals.
- **Icons: hand-authored inline SVG only.** There is no icon package and adding
  one is banned. No emoji as icons.
- **Motion: static posture.** Chrome + one functional disclosure + one
  functional countdown. No entrance choreography, no scroll-linked motion.

---

## Adoption (not yet done)

The reference file is a design artifact. To make it the live dashboard:

1. Port the 21 live endpoint calls and their render functions from
   `helper/dashboard.html` into this markup — `/queue`, `/applications`,
   `/postings`, `/sweeps`, `/sweep`, `/batch`, `/batch-runs`, `/failures`,
   `/answers`, `/profile`, `/settings/criteria`, `/settings/profile`,
   `/seek/last`, plus the parameterised `/fill/`, `/queue/`, `/answers/`,
   `/applications/`, `/batch-runs/`, `/postings/`, `/sweeps/` routes.
2. Preserve every behaviour: armed two-click destructive confirms, narrowing
   detection on criteria save, the profile merge form and its untouched-key
   guarantee, inline notes editing, filter chips, expandable rows.
3. Replace all mock data. **No real identity values belong in a committed file.**
4. Keep `helper/fonts/` — the woff2 files are load-bearing.

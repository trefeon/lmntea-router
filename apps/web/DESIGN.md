# DESIGN.md — lmntea-router dashboard

> Single source of truth for the dashboard's visual system. The CSS tokens in
> `src/index.css`, the shell (`Layout`/`Header`/`Sidebar`), and every page are
> projections of this file. If they drift, this file wins.

## Discovery

- **Artifact:** developer-tool dashboard (single-operator control surface for a
  self-hosted LLM router). Not marketing, not a consumer app.
- **Audience:** the operator (a developer running lmntea-router). One job per
  page; facts over decoration.
- **Committed adjectives:** precise, calm, honest, ordered.
- **Aesthetic essence:** *precision instrument panel*.
- **Direction chosen (2026-09-04):** instrument console — monochrome zinc,
  hairline dividers, tabular numerals, one emerald signal color. Dark-only.

## Design system

### Typography

- Sans: `Geist Variable` (already bundled, `@fontsource-variable/geist`).
  Headings use the same family with tighter tracking — no separate display face
  (instrument = one voice).
- Mono: system `ui-monospace` stack. Reserved for identifiers, model ids, URLs,
  versions, timestamps, and all numeric readouts.
- Scale: 12 / 13 / 14 (base) / 16 / 18 / 24 / 30. Data tables use 13px; page
  titles 24px; stat values 30px mono.

### Color (OKLCH, dark only)

- Background: `oklch(0.13 0 0)` — near-black, never pure black.
- Elevation by lightness only: card `0.17`, popover `0.20`, hover `0.22`.
- Borders: hairlines — `oklch(1 0 0 / 8%)`; stronger separator `12%`.
- Foreground: `oklch(0.95 0 0)`; muted `oklch(0.65 0 0)`; faint `0.55`.
- Accent (the ONLY hue): emerald `oklch(0.72 0.15 165)`.
  - Success = emerald (same hue), warning = amber `oklch(0.75 0.14 85)`,
    error = red `oklch(0.66 0.19 25)`. Color is never the only signal — always
    pair with text/icon.
- Distribution: ~90% neutral, ~7% accent, ~3% semantic. Accent appears on live
  indicators, active states, primary actions — nowhere else.

### Shape

- Radius: single small radius `0.375rem` (tokens map `--radius: 0.5rem`).
  No pill cards, no blob rounding.
- Shadow: **none**. Depth comes from hairline edges + lightness. No drop
  shadows, no glows (the old emerald glow dot is gone).

### Density & layout

- Base spacing 4px; tight within groups (2-4), generous between sections (6-8).
- Content column `max-w-[1280px]`, pages start with a page header
  (title + one-line description + actions on the right).
- Data tables: left-aligned text, right-aligned `tabular-nums` numerals, hairline
  row separators, no zebra striping. Card headers are plain — no icon tiles,
  no colored left borders.

### Motion

- Hover/focus transitions only: `150ms ease-out`, transform/opacity/color.
- No entrance animations, no spinners beyond a single muted one.
- `prefers-reduced-motion` respected (Tailwind default).

### Iconography

- lucide, 16px grid, 1.5px stroke, all in one muted value — never colored per
  meaning (status conveyed by text + dot).

## Structure (7 pages, one job each)

| Route | Page | Job |
|---|---|---|
| `/` | Overview | health + real stats only; onboarding card; quick-start curl |
| `/models` | Models | search/filter/sort the registry table |
| `/providers` | Providers | provider specs and status |
| `/proxy-pools` | Proxy Pools | relay pool inventory |
| `/combos` | Combos | routing combos |
| `/usage` | Usage | request metrics |
| `/playground` | Playground | interactive chat against the router |

Nav: 3 groups — Overview; Routing (Models, Providers, Proxy Pools, Combos);
Observability (Playground, Usage). No badges, no disabled "soon" items, no
counts that aren't fetched from the API. Fake data is not rendered as fact.

## Slop audit (deliberate exclusions)

- No forced `border-l-2` active tabs in nav — flat highlight only.
- No gradient text, glassmorphism, or glow shadows.
- No Inter/Roboto/system as primary face (Geist + mono stack).
- No icon tiles above card headings; no colored status badges except the
  semantic trio (emerald/amber/red), always with text.
- No decorative hero assets; `App.css` (Vite starter) deleted.
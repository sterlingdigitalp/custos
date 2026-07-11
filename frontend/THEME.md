# Custos UI theme — "Deep Canopy"

Dark, data-dense, low-fatigue. Warm green-slate base (not pure black), one
bioluminescent accent for focal points. Dark-only (the palette is inherently dark).

## Tokens (wire into tailwind.config theme.extend.colors)

| token            | hex       | use                                                    |
| ---------------- | --------- | ------------------------------------------------------ |
| base             | #0A110D   | deepest background, behind everything                  |
| surface          | #151E1A   | data cards, widgets, chart panels                      |
| sidebar          | #0E1612   | left nav panel                                         |
| divider          | #23302A   | subtle 1px borders / row dividers only when needed     |
| text-primary     | #E8F0EC   | core data, active menu items                           |
| text-secondary   | #7C8D85   | axis labels, table headers, inactive nav               |
| text-muted       | #4A5A53   | placeholders, disabled, subtle timestamps              |
| accent           | #BEF264   | primary buttons, the hero chart line, active states    |
| accent-glow      | #2F5A38   | radial glow behind active chart node (20-30% opacity)  |
| metric-down      | #E17055   | negative deltas (muted coral — never pure red)         |

## Rules

- **Borderless cards.** Separate widgets by the base↔surface contrast, not
  borders. 1px `divider` only if truly necessary.
- **Pills.** Active nav items and primary buttons are pill-shaped (high radius).
- **Chart glow.** Behind the latest data point on a line chart, a soft blurred
  radial gradient in `accent-glow`.
- **Chart series palette** (uPlot, keep legible on `surface`):
  - buyBoxPrice → `accent` #BEF264 (the hero line, thickest)
  - lowestNewPrice → #8FB8D6 (cool blue)
  - lowestFbaPrice → #C7A3E0 (soft violet)
  - salesRank (right axis, inverted) → `text-secondary` #7C8D85, dashed
  - offerCount subplot → #7C8D85
- **Deltas & semantics.** Negative price/rank deltas render in `metric-down`;
  positive in `accent`. Buy Box "won" uses `accent`; "lost" uses `text-secondary`
  (not alarm-red — a lost Box isn't an error).

## Status banner (3-state — replaces the 2-state MOCK/LIVE)

Drive from GET /api/status `{ clientMode, client: { ok } }`:
- `clientMode==='mock'` → slate pill "MOCK DATA" (text-secondary on surface)
- `clientMode==='live' && client.ok` → accent pill "LIVE"
- `clientMode==='live' && !client.ok` → coral pill "LIVE · AUTH FAILING"
  (metric-down) — credentials present but the ping is failing; never claim
  healthy when it isn't.

# Frozen contract: Custos `/contrib/ceilings` — the documented-ceiling endpoint

> Vendored 2026-07-24 from the Aurora session's frozen contract
> (CONTRIB-CEILING-CONTRACT.md). **This shape is FROZEN — Aurora builds its
> consumer half against it. Do not change field names/shape without
> coordinating with the Aurora session.** Custos's internal computation
> (dwell-based sustained rule) is documented in KEEPA-BACKFILL.md §K6; the
> `method` string surfaces which rule was used (Aurora treats it opaque).

**Producer:** Custos (owns Keepa data + the sustained-ceiling computation).
**Consumer:** Aurora (sets `huntCap` on ceiling-chasers from documented
history instead of a blunt relative +20%). Money = `@platform/contract`
`Money` (`{amount,currency}`, USD, decimal string). ASIN-keyed. Bearer auth
= same as existing `/contrib` (`HISTORY_CONTRIB_TOKENS`).

## Endpoints
- `GET  /contrib/ceilings/:asin` — one ASIN.
- `POST /contrib/ceilings` body `{"asins":[...]}` — batch, cap ≤500/request.

## Single-ASIN response
```json
{
  "asin": "B0B6G544R7",
  "computedAt": "2026-07-24T02:15:00.000Z",
  "provenance": "keepa+sweep",
  "coverage": {
    "historyStart": "2011-03-14T00:00:00.000Z",
    "historyEnd":   "2026-07-24T01:00:00.000Z",
    "buyboxPoints": 1446,
    "confident": true
  },
  "buyboxCeiling": {
    "method": "sustained_dwell_v1",
    "sustained1y":      { "amount": "116.79", "currency": "USD" },
    "sustainedAllTime": { "amount": "119.50", "currency": "USD" },
    "absolute1y":       { "amount": "125.72", "currency": "USD" },
    "absoluteAllTime":  { "amount": "125.72", "currency": "USD" }
  },
  "buyboxFloorContext": { "sustained1y": { "amount": "98.00", "currency": "USD" } },
  "amazonPresence90d": 0.0,
  "notes": null
}
```

## Gap / thin-data case (nulls, never zero)
```json
{
  "asin": "B0XXXXXXXX", "computedAt": "…", "provenance": "none",
  "coverage": { "historyStart": null, "historyEnd": null, "buyboxPoints": 0, "confident": false },
  "buyboxCeiling": { "method": "sustained_dwell_v1", "sustained1y": null, "sustainedAllTime": null, "absolute1y": null, "absoluteAllTime": null },
  "buyboxFloorContext": { "sustained1y": null },
  "amazonPresence90d": null,
  "notes": "keepa gap: ASIN in catalog, zero collected history; building forward from sweeps"
}
```

## Batch response
```json
{ "requestedAt": "…", "ceilings": [ /* per-ASIN objects */ ], "unknown": ["B0NOTINCUSTOS1"] }
```
`unknown` = ASINs Custos has never seen (not in `products`). Gaps (tracked
but no history) appear in `ceilings[]` with `confident:false`, NOT `unknown`.

## Rules (load-bearing)
- **`coverage.confident` gates everything.** Suggested rule: `buyboxPoints >=
  30 AND historyEnd within ~90d of now`. Aurora uses a documented ceiling ONLY
  when `confident:true`, else falls back to its relative +20% cap.
  - **Custos implements a STRICTER gate (2026-07-24, adversarial-review
    finding):** `buyboxPoints >= 30 AND fresh AND sustained1y is itself
    high-confidence` — i.e. `sustained1y` cleared the in-window dwell
    threshold and isn't a thin-history percentile fallback or a >1.15×P99
    phantom-guard downgrade. Rationale: a ~2-day sweep-only ASIN (≥30 fresh
    points) whose `sustained1y` is a fallback riding a transient spike would
    otherwise publish `confident:true` on a phantom-high value, and the
    `absoluteAllTime` clamp does NOT save it when the spike is also the
    all-time max. The response SHAPE is unchanged; only the population of
    `confident:true` shrinks (strictly safer for the consumer — never worse
    than the relative fallback). Aurora: expect some deep-but-currently-thin
    ASINs to read `confident:false` and fall back, by design.
- `method` documents the sustained rule; Aurora treats it opaque.
- Aurora consumption (frozen): `huntCap = manualMaxPrice ?? (confident ?
  sustained1y : relativeCap)`, hard-clamped to never exceed `absoluteAllTime`.
- Nulls first-class — any money field may be null = "no documented value",
  never `$0`.
- `computedAt` lets Aurora cache + refresh daily; Custos recomputes as
  sweeps extend the series.

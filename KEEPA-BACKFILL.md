# Keepa historical backfill — design record

Status: v1 (2026-07-22). Source of the ask: Aurora session
(CUSTOS-KEEPA-BACKFILL-ASK.md). HARD DEADLINE: Keepa Pro expires
**2026-09-02**; target backfill COMPLETE by **mid-August**. One-time
memory transplant — there is no second pull.

## Constraints (from the ask, confirmed off the Pro plan page)

- API: **1 token/min** (~1,440/day); ~1 token per ASIN with history;
  batch up to 100 ASINs/request; same-request-within-1h is free (safe
  retries). P1 ≈ 10h of budget; full corpus ≈ 2.2 days cumulative.
- Product Viewer bulk export: 36,000 products/day, **zero API tokens**.
- Priorities: P1 = Aurora's 594 registered listings → P2 = rest of the
  ~3,100 corpus → P3 (optional) shoe-ASIN variation depth.
- Job runs ON THE BOX. Key on-box only, 0600, expiry noted.

## Decisions

| # | Decision | Choice |
|---|---|---|
| K1 | Storage separation | Keepa data NEVER enters `snapshots`. New tables: `keepa_raw` (asin, domain, fetched_at, tokens_cost, payload gzip BLOB — re-normalizable forever), `keepa_points` (asin, metric, ts ISO, value INTEGER — cents for money, raw for rank/count; UNIQUE(asin,metric,ts)), `keepa_stats` (Track A viewer-export aggregates, one row per asin+window+metric), `keepa_checkpoint` (asin, phase, status, tokens_spent, updated_at). |
| K2 | Metrics normalized | From Keepa CSV arrays: `amazon`, `new`, `buybox`, `salesrank`, `offercount` (+`fba` if present). Keepa epoch-minutes → ISO UTC; sentinel -1 → point omitted (absent ≠ zero, §1.4 discipline). Money → integer cents. |
| K3 | Blending rule | Read-time merge, never write-time. Native sweep data is authoritative from 2026-07-11 onward; Keepa fills everything earlier **plus the Jul-12→17 hole**. Every serving surface tags provenance (`source: keepa|sweep`). |
| K4 | Runner | `scripts/keepa-backfill.mjs` on the box: batches of 100, priority-ordered (P1 list from the prod Hub registry ∩ aurora listings — Aurora session to供 the 594 ASIN list, or derive via Hub registry mappings), per-ASIN checkpoint commit, token-budget aware (reads Keepa's tokensLeft/refill headers; sleeps to refill), resumable across restarts; systemd unit `custos-keepa-backfill.service` (Restart=on-failure) so box reboots don't lose the run. |
| K5 | Key handling | `KEEPA_API_KEY` in `/home/platform/.platform/custos/custos.env` (0600) with comment `# Keepa Pro — EXPIRES 2026-09-02, do not debug post-expiry`. Never in git/chat/logs. |
| K6 | Ceiling contract (downstream, after P1 lands) | Extend `/contrib/products/:productId` (same bearer auth) with: `ceiling` = highest BuyBox price whose cumulative time at-or-above that price ≥ **24h within the window** (computed over step-function segments of the merged series; documented robustness rule), over 1y and all-time, each with dates; `floorContext` = lowest sustained (same rule) BuyBox over 1y; `amazonPresence` = fraction of last 90d with Amazon in stock. Provenance field states which sources fed the answer. |
| K7 | Track A ingest | Product Viewer CSV export → `POST /api/import/keepa-stats` (new, idempotent, preview+apply like the SellerAmp importer) → `keepa_stats`. Serves first-cut ceilings within days, before Track B refines. |
| K8 | Reporting | On P1 completion: coverage % (ASINs with history / 594), obtained date-range stats, list of ASINs Keepa lacked → report to operator + Aurora session; OPERATIONS.md updated in the same push. Same again at P2. |

## Verification gates

- Normalizer: golden tests against stored raw payloads (round-trip:
  raw → points → re-normalize equals). Keepa epoch/sentinel edge cases.
- Backfill: kill -9 mid-batch loses nothing; re-run spends 0 tokens on
  completed ASINs; token-budget starvation parks the job, never busy-loops.
- Ceiling: unit tests on synthetic step series (spike vs sustained);
  cross-check a handful of ASINs against Keepa's own graphs before expiry.
- Blending: overlap window (sweep+keepa both present) always serves sweep.

## K6 detailed design — ceiling / floorContext / amazonPresence

Frozen 2026-07-24 after @mind adversarial review + empirical verification
(24% of real buybox events are `-1` gap markers — see below). Aurora
consumes `ceiling` to set evidence-based hunt caps; the failure mode that
matters is a phantom-high ceiling → Aurora overpays.

### K6.0 PREREQUISITE — preserve `-1` gap terminators (correctness-critical)
`normalize.ts` currently DROPS every `-1` (`if (value === -1) continue`),
discarding Keepa's "no buy box / out of stock" markers. A step-function
dwell computation then attributes a gap's whole span to the preceding
price → phantom sustained ceiling. Verified on B00FLYWNYQ: 462/1922 buybox
events are `-1`, longest bridged gaps 25/18/17 days. Fix:
- normalize emits an explicit **terminator point** at each `-1` timestamp,
  stored in `keepa_points` as **`value = -1`** (unambiguous — no metric has
  a legitimate -1: prices ≥0 cents, rank ≥1, offercount ≥0). No schema
  change (value stays INTEGER NOT NULL; UNIQUE(asin,metric,ts) preserved).
- Buybox triplets: a `price === -1` entry becomes a terminator regardless
  of shipping.
- One-time **re-normalize pass** over all `keepa_raw` rebuilds `keepa_points`
  with terminators (no tokens — raw payloads stored per K1). Safe to run
  while the backfill continues (per-ASIN DELETE+INSERT txn, disjoint or
  idempotent-identical ASIN sets). Backfill's on-the-fly normalize uses the
  fixed code going forward.

### K6.1 Merged provenance step-series (cents)
Build per-metric step segments `[startTs, endTs) → value|GAP` from BOTH
sources, in integer cents for money:
- Keepa: consecutive `keepa_points` for (asin,metric); a segment whose
  START point is `-1` is a GAP (zero dwell); real-value start = real segment.
- Sweep (`snapshots`, buyBoxPrice REAL dollars→cents via money.ts; NULL = GAP).
- **Coverage-mask merge** (sweep authoritative where present, never backfill
  Keepa into a sweep-covered gap): `sweepCovered(t)` = a sweep row exists in
  `[t−Δ, t]`, Δ = 2×sweepIntervalMin. Covered intervals use sweep segments;
  elsewhere in `[minTs, now]` use Keepa. This makes the 07-12→17 outage (and
  any future outage) fall to Keepa automatically.
- **Guard band**: cap the final Keepa segment (no successor point) at
  `min(sweepStart, now, lastObs + min(7d, medianInterSampleGap))` — a dead
  series must not forward-fill its last value to now.

### K6.2 Sustained-extreme dwell (O(n log n))
The sustained extreme is always an observed value. For window W, direction
dir∈{ceiling(≥),floor(≤)}, threshold T:
```
segs = realValuedSegments clipped to W        # GAP segments excluded
observed = Σ dur(segs);  if 0 → {value:null, confidence:'none'}
byVal = value → Σ duration
walk values in dir order (ceiling: high→low), accumulating cum
  first value v where cum ≥ T →
    {value:v, from:min(start of segs with val dir v), until:max(end),
     dwellHours:cum/3600, confidence:'high'}
none reach T (thin history) →
    {value: dwellWeightedPercentile(segs, ceiling?0.99:0.01),
     confidence:'low'}
```
**Threshold** `T = clamp(0.01·windowDuration, 48h, 14d)` (flat 24h from the
original K6 sketch is too weak over 14y). 1y→~3.65d, all-time→14d: rejects a
2-day spike, passes a genuine 3-week hold. **Phantom guard**: if
`ceiling > 1.15 × dwellWeightedP99`, downgrade to `confidence:'low'`.
Prefer under-claiming — a false-high costs real money, a false-low only
forgoes margin.

### K6.3 amazonPresence
`fraction = Σ dur(real-valued amazon segments ∩ [now−90d, now]) /
observedWindow`, `observedWindow = now − max(now−90d, firstObs)`. If
`observedWindow < 90d` → `confidence:'low'` + report `observedDays`. (The
`-1` fix is mandatory here too — amazon metric has ~443 out-of-stock
markers on the benchmark.)

### K6.4 JSON (extends contrib.ts buildHistoryData; envelope UNCHANGED)
```jsonc
"ceiling": {
  "trailing1y": { "value": {"amount":"159.99","currency":"USD"}|null,
    "heldFrom":"ISO","heldUntil":"ISO","dwellHours":552.0,
    "thresholdHours":87.6, "confidence":"high"|"low"|"none",
    "provenance":{"sources":["keepa"],"sweepFraction":0.0} },
  "allTime": { /* same shape */ } },
"floorContext": { "trailing1y": { /* same, lowest sustained (≤ walk) */ } },
"amazonPresence": { "windowDays":90,"observedDays":90.0,"fraction":0.42,
  "confidence":"high","provenance":{"sources":["keepa","sweep"],
  "sweepFraction":0.11} }
```
`sweepFraction` = sweep-covered duration / observed duration in-window.
Prices via centsToMoney; dates ISO-UTC. Field objects are ALWAYS present
(never silent-omit) so Aurora distinguishes `confidence:'none'` (no
evidence — do not cap) from `'low'` (thin/flagged) from `'high'`.

### K6.5 Aurora guidance
Cap on **trailing1y ceiling only**; allTime is displayed context. Recency
is the strongest anti-phantom signal. Absent/low → no cap or discounted cap.

## Operator inputs needed

1. **Keepa API key onto the box** (command prepped by the session; key
   never through chat).
2. **Track A export**: operator-driven Product Viewer bulk export (or
   Claude-in-Chrome drives it in the operator's logged-in session);
   CSVs land anywhere on the Mac, import via K7.
3. P1 ASIN list confirmation: derive from Hub registry (aurora-mapped
   products) unless Aurora session supplies an explicit list.

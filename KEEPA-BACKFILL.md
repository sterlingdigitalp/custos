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

## Operator inputs needed

1. **Keepa API key onto the box** (command prepped by the session; key
   never through chat).
2. **Track A export**: operator-driven Product Viewer bulk export (or
   Claude-in-Chrome drives it in the operator's logged-in session);
   CSVs land anywhere on the Mac, import via K7.
3. P1 ASIN list confirmation: derive from Hub registry (aurora-mapped
   products) unless Aurora session supplies an explicit list.

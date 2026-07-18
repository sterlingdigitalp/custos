# Custos — a self-hosted Keepa (personal-corpus edition)

Personal-use clone of keepa.com Pro for one Amazon seller. Tracks a
user-curated corpus of ASINs (target: low thousands), accumulates price /
Buy Box / offer / sales-rank history from the day an ASIN is added, charts it
Keepa-style, fires alerts, and answers finder queries over the tracked corpus.

**Custos is strictly read-only toward Amazon.** It never mutates listings,
prices, or anything else — purely observational. (No dry-run/live machinery
needed; there is no write path at all. Keep it that way.)

**Credential isolation:** Custos uses its OWN SP-API app client (separate LWA
client id/secret/refresh token from Aurora) so the two apps draw from separate
rate-limit buckets and never contend. Credentials live only in the local
SQLite settings row, entered via the UI, never in the repo.

## Explicit non-goals (Keepa's moats — do not attempt)

Catalog-wide Product Finder / global Deals / Best Sellers rankings;
retroactive history for never-watched ASINs; arbitrary-seller catalog
enumeration; stock estimates; any scraping of Amazon pages.

## Architecture

Same proven stack as Aurora: Node 22 + TypeScript ESM, Fastify, SQLite
(better-sqlite3, WAL), scheduler loop in-process; React + Vite + Tailwind SPA
served statically by the backend. vitest. Port **4400** (platform port map: aurora 4000, ledger 4100, history/custos 4400).
Frontend may add **uPlot** for time-series charts (tiny, fast; charts are the
core product — this is the one approved frontend dependency).

SP-API sits behind one interface with mock + live implementations
(`SpApiClient` pattern proven in Aurora):

```ts
interface CustosApiClient {
  // Product Pricing v0 getItemOffersBatch (≤20 asins/call, ~1 call/10s):
  getOffers(asins: string[]): Promise<OfferSnapshot[]>
  // Catalog Items 2022-04-01 searchCatalogItems by ASIN identifiers
  // (≤20 identifiers/call, ~2 req/s), includedData=salesRanks,summaries,images:
  getCatalog(asins: string[]): Promise<CatalogInfo[]>
  // Catalog keyword search for corpus seeding (paged):
  searchByKeywords(query: string, pageToken?: string): Promise<SeedSearchResult>
  ping(): Promise<{ ok: boolean; detail: string }>
}
```

Rate handling per Aurora's hard-won lessons: the CLIENT owns chunking AND
pacing (10s between pricing batches, 600ms between catalog batches); one
failed chunk costs only its own ASINs (absent results, never fabricated
ones); single 429 retry honoring Retry-After (default 10s).

## Data model (SQLite)

- `products`: id, asin UNIQUE, title, brand, imageUrl, category,
  rankCategory, addedAt, source ('manual'|'import'|'seed'|'extension'|'aurora'),
  isArchived (archived = kept in DB, not polled).
- `snapshots`: id, asin, ts, buyBoxPrice, lowestNewPrice, lowestFbaPrice,
  offerCount, fbaOfferCount, salesRank, rankCategory. One row per ASIN per
  sweep; all metric columns nullable (absent ≠ zero). Index (asin, ts).
- `alerts`: id, asin, ruleType ('price_below'|'drop_percent'|'back_in_stock'|
  'rank_below'|'buybox_change'), threshold (REAL, unused for back_in_stock/
  buybox_change), windowHours (for drop_percent, default 24), isActive,
  cooldownHours (default 24), lastFiredAt.
- `alert_events`: id, alertId, asin, ts, message, delivered (bool),
  deliveryError.
- `seed_queries`: id, query, addedAt, lastRunAt — saved keyword searches for
  corpus growth.
- `settings` (singleton id=1): lwaClientId, lwaClientSecret, refreshToken,
  marketplaceId default 'ATVPDKIKX0DER', region 'na', sweepIntervalMin
  default 60, ntfyTopic (nullable), ntfyServer default 'https://ntfy.sh'.

## Collector (scheduler)

Every `sweepIntervalMin`: take all non-archived products, ONE
`getOffers(allAsins)` call + ONE `getCatalog(allAsins)` call (clients chunk
and pace internally), write one snapshot row per ASIN merging both sources.
Snapshot write is append-only; never update old rows. Per-chunk failures =
those ASINs get a snapshot row with null metrics ONLY IF nothing was fetched
from either source — otherwise partial row with what arrived. After each
sweep, run the alert evaluator. Sweep summary (asins, fetched, failed,
alertsFired) kept in memory for /api/status; scheduler uses setTimeout
chaining, re-reads interval each loop.

Quota sanity: 1,000 ASINs = 50 pricing batches ≈ 8.5 min paced + 50 catalog
batches ≈ 30s. Fits hourly with 6x headroom; cap corpus additions with a
clear error past 5,000 ASINs.

## Alert engine

After each sweep, for each active alert compare the latest snapshot (and the
window for drop_percent) against the rule:
- price_below: buyBoxPrice (fallback lowestNewPrice) <= threshold
- drop_percent: price fell >= threshold% vs the max within windowHours
- back_in_stock: previous snapshot had no offers/price, latest has one
- rank_below: salesRank <= threshold (rank IMPROVING through a level)
- buybox_change: buyBoxPrice changed by more than $0.01 between the last two
  snapshots (v1 proxy; we don't track BB seller identity yet)
Fire = insert alert_event + deliver via ntfy (POST to ntfyServer/ntfyTopic,
title + message + link to product page) when configured. Respect
cooldownHours per alert. Delivery failure recorded on the event, never
crashes the sweep. Alerts also surface in a web inbox (unread count).

## API (Fastify, /api/*)

- products: GET list (with latest snapshot join), POST add (asin or list of
  asins — bulk import), PATCH :id (archive/unarchive, title override),
  DELETE :id (only if no snapshots yet; else archive).
- GET /api/products/:asin/history?days=90 — snapshot series for charts.
- alerts CRUD; GET /api/alert-events?unread; POST mark-read.
- finder: POST /api/finder — filters: price min/max, rank min/max, offerCount
  max, priceDropPercent+windowDays, rankImprovedPercent+windowDays,
  category contains; returns products + metric deltas, sortable.
- seeding: POST /api/seed/search {query} → candidates (not yet tracked
  flagged); POST /api/seed/add {asins}; seed_queries CRUD.
- GET/PATCH /api/settings (secrets masked on read, '***set***' convention);
  GET /api/status (scheduler state, last sweep summary, client ping, corpus
  size); POST /api/sweep/run (manual sweep now).
- CORS: allow chrome-extension:// origins for the extension (GET history +
  POST products only).

## Frontend (React SPA)

- Watchlist (/): table w/ thumbnail, title, latest price, rank, offer count,
  sparkline (last 7d), alert badges; add-ASIN box (paste one or many); archive.
- Product (/p/:asin): the Keepa-style chart — uPlot dual-axis: price lines
  (Buy Box, lowest new, lowest FBA) left axis, sales rank right axis
  (inverted, Keepa-style), offer count subplot; range picker (7/30/90/all);
  alert quick-create from the chart page.
- Alerts (/alerts): rules table + events inbox.
- Finder (/finder): filter form → results table with deltas; "save as seed
  query" for keyword searches.
- Seed (/seed): keyword search → candidate grid → add selected.
- Settings (/settings): credentials (masked), sweep interval, ntfy topic +
  "send test notification", status panel.

## Browser extension (extension/, Chrome MV3)

Content script on amazon.com product pages: extract ASIN from URL, GET
http://localhost:4400/api/products/:asin/history — if tracked, inject a
compact chart panel (rendered as inline SVG from the data; no bundled chart
lib) under the price block; if not tracked, inject a "Track in Custos"
button that POSTs the ASIN. Options page: backend URL (default
localhost:4400). No external requests other than the user's own backend.

## Verification

`npm test` (vitest: engine-free — collector merge, alert rules, finder
filters, importer, API routes against mock + :memory: db), `npm run build`,
`cd frontend && npm run build`. Add a fleetcheck manifest after v1 ships.

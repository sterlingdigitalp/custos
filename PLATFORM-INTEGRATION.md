# Custos → platform "history" service — integration design

Status: v1.2 (2026-07-17) — draft v1 passed adversarial review (seven
findings folded in: D4, D13, D3/D7 notes, §2 zero-snapshot rule, P4
heartbeat, P6 cutover rule), then conferred against the live production
system (§7). Decision record for making Custos the Seller
Platform's `history` service (PLATFORMv2.1.md §2 app #2, §16 step 8) while
keeping it a working standalone tracker at every phase.

Normative sources: `~/aurora/PLATFORMv2.1.md` (contract),
`~/HUB/packages/contract` (types/schemas), aurora's implementation
(`~/aurora/backend/src/platform/*`) as the proven reference pattern.

## 0. Scope of authority (what history is, per contract)

- Sole authority: long-horizon price / rank / offer-count / estimated-sales
  time series for owned products AND prospects; rank-spike inference;
  historical rollups (§2 table row 2).
- Explicitly not ours: current price execution, inventory, COGS, sourcing
  decisions, canonical catalog identity (§2, §10.1:737).
- Custos's READ-ONLY-toward-Amazon mandate is unchanged and permanent.
- Owned event types (already registered to owner `history` in
  `contract/src/event-types.ts:10-11`): `history.rank.spike.v1`,
  `history.market.daily.v1`.

## 1. Decisions (the load-bearing ones)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Contract pinning | `"@platform/contract": "file:../HUB/packages/contract"` | Matches aurora (the working reference). Submodule standardization is existing platform-wide debt (aurora/DEBT-MAP.md), not ours to fix here. |
| D2 | Internal keying | Keep ASIN-keyed tables; add `registry_product_map` (asin UNIQUE → `prd_` ULID) | Zero-risk to the working tracker; canonical IDs only at the platform boundary. Same shape as aurora's `listing_registry_map`. |
| D3 | Registry resolve | Eager bootstrap script + resolve-on-add for new products. NOTE: there is no batch resolve API — `POST /registry/products/resolve` is one product per call (`registry.ts:139-186`), so the script is ~3,144 sequential localhost POSTs (fine; pace lightly). Resolve is idempotent via identifier match, so re-runs are no-ops. The script must not run concurrently with resolve-on-add (single-process rule) — a same-ASIN race can strand an identifier-less duplicate product | Daily rollups emit for ALL active products, so lazy resolve converges to eager in a day anyway; eager gives one observable cutover. Contract sanctions products-for-prospects (§3.2:274-276) — products yes, listings never. Registry grows ~565 → ~3.7k products. Unresolved ASINs: skip emission + `unmappedSkipped` counter (aurora's pattern), never block the sweep. |
| D4 | Event payload schemas | Author `history-event-schemas.ts` in HUB `packages/contract` (they don't exist yet) AND add a `historyPayload()` branch to the Hub's hand-written validation switch (`services/hub/src/events.ts:466-474`); bump contract version and re-cut tag. Custos ALSO self-validates every payload against the schemas before enqueue | VERIFIED (adversarial review): the Hub does NOT validate payloads via the contract's JSON schemas — validation is a per-source switch in `events.ts` with no history branch, so schemas alone are decorative at ingest. Both halves are needed: schemas (docs + self-validation) and the Hub branch (real 422 enforcement). Follow `aurora-event-schemas.ts` `base()` pattern: draft-2020-12, `additionalProperties:false`, Money via `moneyJsonSchema`, canonical IDs only — no ASIN in payloads. |
| D5 | Outbox | Port aurora's `platform_outbox` + `HubDeliveryWorker` near-verbatim (status machine pending/delivered/failed/poison, `INSERT OR IGNORE` on event_id, exp backoff cap 300s, 422→poison, 401/403→halt) | Proven in production against the same Hub. Enqueue always inside the existing domain `db.transaction`. |
| D6 | Emission gate | No-op unless `HUB_BASE_URL` + `HISTORY_HUB_TOKEN` both set (aurora's both-or-undefined gate) | Standalone mode keeps working with zero platform config. |
| D7 | Money at boundary | Snapshots stay REAL dollars internally. At the boundary: convert each price to integer cents via the contract's `moneyFromLegacyFloat`/`roundHalfAwayFromZero` (`money.ts:173-181`), do ALL aggregate math (medians etc.) in the cents domain, then `moneyFromMinor()` once | No storage migration of snapshot rows. The contract forbids ad-hoc `Math.round` (§1.7:148-152) and medianing floats before rounding can drop half-cents on even counts — cents-domain math avoids both. |
| D8 | Rollup store | New `daily_rollups` table (asin, date UTC, aggregates, emitted_event_id), computed by a post-sweep daily job; raw snapshots remain source of truth; rollups rebuildable by replay | "Historical rollups" is our contracted authority; materialized dailies make 90d contrib reads O(90) instead of O(snapshots). Rebuild-without-mutating-authority satisfies native item 9. |
| D9 | Scopes | `events.publish.history`, `events.read.aurora`, `registry.resolve` | §17.1's example `events.read.market` does NOT match the shipped Hub check — read scope derives from event OWNER (`events.ts:381-388`), so consuming `market.observed.v1` needs `events.read.aurora`. `registry.resolve` (auth.ts:103) is required for D3 and missing from the §17.1 example. Broker scopes deferred (D11). |
| D13 | Account/marketplace prereq | History does NOT self-provision identity context. `resolveProduct` 422s unless the marketplace is registered, and event append 422s without an `account_marketplaces` row — both come only from Hub bootstrap (scope `registry.bootstrap`, which history deliberately does NOT hold). `PLATFORM_ACCOUNT_ID` must be the Hub's real bootstrapped `acct_` ULID (aurora's account), never `DEFAULT_ACCOUNT_ID` | Bootstrap already exists on both staging and prod Hubs (prod: 1 account, marketplace ATVPDKIKX0DER). P1 documents the env value per environment; if a fresh Hub is ever stood up, aurora/hub-admin bootstrap must precede history. |
| D10 | Hub reachability | Dev against the local staging Hub (`~/HUB` on the Mac, hub-staging.db); production = deploy custos to helsinki as `history.service` (Phase 6). Interim Mac→prod-Hub access, if ever needed, via SSH tunnel (`ssh -L 4220:127.0.0.1:4220 platform-helsinki`) | Prod Hub binds 127.0.0.1 on the VPS — unreachable from the Mac by design. Contract's deployment model is one VPS + localhost HTTP (§17). VPS deploy also ends the Mac-sleep data-gap problem for good. |
| D11 | SP-API via Broker | DEFERRED until HUB PR #2 merges. Custos keeps its own isolated read-only LWA client as dated, accepted debt | Native item 7 is blocked upstream. When Broker lands: route `getOffers`/`getCatalog` through `POST /spapi/...`, scopes `spapi.pricing.read` + `spapi.catalog.read` (pricing.read must be ADDED to history's §17.1 example — catalog alone can't serve a Keepa-style tracker's offer/Buy Box series). |
| D12 | Contrib auth | Bind 127.0.0.1; optional `HISTORY_CONTRIB_TOKENS` bearer allowlist, open-on-localhost default flagged as debt | §17.1 says localhost ≠ authz, but full mutual service auth is platform-wide follow-up work; don't gold-plate ahead of ledger/carton. |

## 2. Event payloads (to be added to @platform/contract)

`history.market.daily.v1` — one per product per completed UTC day:
required `[productId, date, snapshotCount]`; properties: `date` (YYYY-MM-DD),
`snapshotCount` (int ≥1), `buyBoxMedian|buyBoxMin|buyBoxMax` (Money|null),
`lowestNewMedian` (Money|null), `lowestFbaMedian` (Money|null),
`offerCountMedian` (int|null), `fbaOfferCountMedian` (int|null),
`salesRankMedian|salesRankMin|salesRankMax` (int|null), `rankCategory`
(string|null), `estimatedSales` (int|null — spikes counted that day).
Envelope: `aggregate:{type:"product",id:prd_}`, `productId` set,
`listingId` null.

Zero-snapshot days (Mac asleep, P2–P5 era): NO event is emitted — a day
with no observations is absent data, not a zero-valued fact (§1.4). Rollup
trigger guard: day D is rolled up only after a sweep whose `ts` falls in
D+1 (UTC), so partial days are never emitted early; missed days backfill
on the next wake (emit every un-emitted completed day with snapshots).

`history.rank.spike.v1` — emitted at detection time:
required `[productId, detectedAt, rankBefore, rankAfter]`; properties:
`detectedAt` (date-time), `rankBefore|rankAfter` (int), `rankCategory`
(string|null), `improvementPercent` (number), `estimatedUnits` (int, v1
heuristic: 1).

Spike heuristic v1 (module `backend/src/history/spikes.ts`): consecutive
snapshots where salesRank improves ≥ SPIKE_THRESHOLD_PCT (default 30%) from a
rank worse than MIN_BASE_RANK (default 1000) → one spike. Reuses the
delta/window math already in `alerts/evaluate.ts:72-83` and finder
(`server.ts:288-296`). `estimatedSold30d` = count of spikes in trailing 30d.
Explicitly a heuristic; tune later without schema change (fields, not logic,
are the contract).

## 3. Contribution endpoint (read side)

`GET /contrib/products/:productId` → `{ history: Contribution }` built ONLY
via contract builders (`freshContribution`/`staleContribution`/
`unavailableContribution` — envelope.ts:47-66; never hand-rolled).
Convenience `GET /contrib/asins/:asin` for pre-resolve callers (maps through
`registry_product_map`; absent if unmapped).

`data` (superset of the normative §11.3 block, which requires exactly
`boxMedian90d` (Money) + `estimatedSold30d` (int)): add `currentRank`,
`rank30d` {median,min,max}, `rankDrops30d`, `estimatedSalesRange`,
`buyBox90d`, `priceSeries`/`rankSeries` (90 daily points) — the field set
andrew's demo adapter models (`src/testing/demoAdapters.ts:109-117`).
Freshness: `fresh` if last successful sweep < 2×sweepInterval; else `stale`
with last-known data and original `asOf`; `absent` for unknown productId;
`unavailable` + reasonCode (`NEVER_SYNCED`, `SOURCE_DOWN`) otherwise.

LIVE CONSUMER (andrew evolved, 2026-07-17, commit 5fffe31): andrew's
`PlatformCustosAdapter` (adapters.ts:321-329) already calls
`GET {CUSTOS_BASE_URL}/contrib/products/{productId}` with bearer
`ANDREW_CUSTOS_TOKEN` and validates the envelope strictly
(`validateContribution`, adapters.ts:105-125): `status` enum, `source`
exactly `"history"`, ISO `asOf`, `data`, `reasonCode`, and `sourceSequence`
as a safe integer — `data` itself is opaque to it. P3 requirements this
fixes: (a) ALWAYS include `sourceSequence` (monotonic per our store —
use the max snapshot rowid backing the response); (b) accept andrew's
bearer via `HISTORY_CONTRIB_TOKENS` (D12); (c) the old
`sourceVersion` drift is resolved on andrew's side — contract shape
everywhere. Verify P3 against andrew's validator, not just contract tests.

## 4. Phases (each independently shippable; standalone mode never breaks)

- **P0 — done 2026-07-17**: port 4400 (history slot), andrew→4500.
- **P1 — DONE 2026-07-17** (verified: 3,144/3,144 ASINs resolved against
  staging Hub, 2,857 created + 287 pre-existing, 0 conflicts/failures;
  re-run = attempted 0; registry 568→3,425 products, listings unchanged;
  79 tests, fleetcheck 2/2): contract dep (D1); `registry_product_map` + bootstrap
  resolve script (`scripts/platform-resolve.mjs`) + resolve-on-add (D3);
  env plumbing (`HUB_BASE_URL`, `HISTORY_HUB_TOKEN`, `PLATFORM_ACCOUNT_ID`
  per D13) + provision `history` credential on the staging Hub (D9). Verify:
  all active ASINs resolve idempotently against staging Hub; re-run is a
  no-op. (Event schemas move to P2 with their Hub validation branch, D4.)
- **P2 — DONE 2026-07-18** (verified E2E vs staging: 6,296/6,296 events
  delivered — 6,288 daily rollups over the 2 completed snapshot days + 8
  spikes; 0 poison; zero-snapshot days correctly absent; 128 tests; HUB
  half committed on agent/history-contract e1a8c18, prod deploy pending
  quiet window): outbox + delivery worker (D5, D6); `daily_rollups` +
  daily job wired into the scheduler loop after `deliverPending`; spike
  inference; emit both event types, self-validated against the contract
  schemas before enqueue (D4). Includes the HUB-repo half of D4 (schemas +
  `historyPayload()` Hub validation branch). Verify: events land in staging
  Hub with correct envelopes; retry dedups (`duplicate:true`); a deliberately
  malformed payload 422-poisons (only meaningful once the Hub branch exists);
  kill -9 mid-batch loses nothing (outbox replays).
- **P3 — serve**: `/contrib/*` endpoints (D12, §3). Verify: contract-shape
  golden tests + andrew pointed at `http://localhost:4400` renders real
  history contributions.
- **P4 — consume**: port aurora's consumer (cursor + inbox tables); subscribe
  `market.observed.v1` AND `market.cycle.completed.v1` (observed events are
  change-point-only — absence ≠ stability without the cycle heartbeat); map
  envelope `productId` → asin via `registry_product_map` (aurora sets
  `productId`; no extra registry scope needed). Multi-listing products
  (aurora has ~24) fan several listings' offer stacks into one ASIN — keep
  per-listing attribution in the enrichment rows (new `snapshots.source`
  column `sweep` | `aurora`, plus source listing id). Verify: cursor survives
  restart; poison event doesn't wedge the loop.
- **P5 — broker cutover** (BLOCKED on HUB PR #2): D11.
- **P6 — DEPLOYED 2026-07-18** (custos.service on helsinki, colocated with
  the Hub — no tunnel needed; platform build + prod credential + Hub
  validation live; staging-ID trap caught in the wild and purged; prod
  re-resolve 3,144/3,144 → registry 3,422 products; fleetcheck prod 2/2
  after a CORS fix for tailnet origins; CONFIRMED 04:47Z: 6,288/6,288
  daily events delivered to the prod Hub, 0 poison — history is live in
  production): original plan was `history.service` on helsinki (systemd, port 4400,
  localhost + tailnet exposure decision at deploy time); one-time
  `data/custos.db` migration; provision prod credential; fleetcheck `prod`
  target. Mac becomes dev copy. Ends the sleep-gap problem.
  **CRITICAL cutover rule (adversarial-review finding): `prd_` ULIDs are
  minted per-Hub-instance — staging-resolved IDs do not exist in the prod
  Hub. Any event carrying a staging `prd_` sent to prod 422s
  (`EVENT_PRODUCT_UNKNOWN`) → permanent poison.** Cutover sequence: (1) drain
  or purge the outbox of staging-addressed events; (2) re-run the resolve
  script against the prod Hub, truncating and rebuilding
  `registry_product_map` (idempotent by ASIN); (3) only then enable emission
  pointed at prod. `daily_rollups` are keyed by ASIN, so history re-emits
  cleanly with prod IDs.

P1–P3 run entirely on the Mac against the staging Hub. P6 can be pulled
earlier (right after P2) if 24/7 collection becomes urgent before the
serve/consume phases.

## 5. Explicitly out of scope

- Any Amazon write path (never).
- Fixing platform-wide debt: contract-pinning standardization, mutual
  service auth everywhere, Broker merge (tracked in aurora/DEBT-MAP.md).
- Andrew's `sourceVersion`→`sourceSequence` drift (andrew-side fix).
- Migrating snapshot storage to cents (boundary conversion only, D7).
- Keepa API purchase (HUB ARCHITECTURE §8 open question) — custos's own
  collection replaces it; revisit only if coverage gaps demand it.

## 6. Platform-native checklist position (§18) after P6

1 canonical IDs ✓(P1) · 2 owns only assigned facts ✓ · 3 command+contrib
APIs ✓(P3) · 4 transactional outbox ✓(P2) · 5 idempotent consumer+cursor
✓(P4) · 6 freshness semantics ✓(P3) · 7 broker-only Amazon access ✗(P5,
blocked upstream, dated debt) · 8 contract invariant tests ✓(P2/P3 test
suites) · 9 projections rebuildable ✓(D8) · 10 degrades without fabrication
✓(D6 gate + contrib `unavailable`).

## 7. Live-system conferral (2026-07-17, aurora = the only live citizen)

Verified against production (helsinki) and the local aurora/HUB checkouts:

- **Prod bootstrap prereq (D13) is proven behaviorally**: aurora has
  published ~127k events accepted by the prod Hub — impossible without the
  `account_marketplaces` context row — so history inherits a bootstrapped
  prod environment. Staging verified directly:
  `acct_01KXE85D781JD74NYKCJ6716DA` + `ATVPDKIKX0DER` in hub-staging.db.
  PROD account (from the Mac's `~/.platform/hub/production` backup set):
  `acct_01KXEC1VGXE1B71KFDY6QNHRN8` — different from staging's, which
  concretely proves the P6 re-resolve rule. `PLATFORM_ACCOUNT_ID` is
  per-environment config, never shared.
- **P4 envelope assumption confirmed in source**: aurora sets `productId`
  on `market.observed.v1` (aurora events.ts:159) but `null` on
  `market.cycle.completed.v1` (events.ts:199) — the consumer must tolerate
  null productId on heartbeat events.
- **D14 (new) — prod deploy coupling**: `/home/platform/HUB` on helsinki is
  NOT a git checkout (rsync-deployed), and live aurora depends on
  `file:../HUB/packages/contract`. Therefore: (a) our contract change must
  be strictly ADDITIVE (new history schema file + exports; nothing existing
  moves) so live aurora is untouched until its own next rebuild; (b) the D4
  Hub validation branch reaches prod only via rsync + rebuild + restart of
  `platform-hub.service` — schedule it in a quiet window; aurora's outbox
  absorbs the append outage by design, but VERIFY its delivery queue drains
  afterward (`aurora /api/status` hubConsumer/outbox counters).
- **Merge-order constraint** (aurora/DEBT-MAP.md:17-28): HUB PR #1 → re-cut
  `contract-v1.1.0` → PR #2 (Broker) when Ledger soak clears. Our D4 work
  is a NEW branch/PR after those (retag as v1.2.0), not a rider on PR #2.
- **Staging Hub is not currently running on the Mac** — P1 step zero is
  starting it (`~/HUB`, port 4200, hub-staging.db).

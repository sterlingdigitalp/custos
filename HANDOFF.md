# HANDOFF — Custos (self-hosted Keepa-style Amazon tracker)

Self-contained session-resume file. Every line tagged VERIFIED (checked against
repo/build/runtime on the date below) or ASSUMED (from prior-session
conversation, not independently checkable).

Custos is a personal, read-only Amazon product tracker (Keepa Pro clone, scoped
to a user-curated corpus): hourly SP-API sweeps record price / Buy Box / offer /
sales-rank snapshots, charts them Keepa-style, fires alerts, and answers finder
queries over the tracked corpus. It NEVER writes to Amazon. Runs on its OWN
SP-API app client, isolated from the Aurora repricer (~/aurora, port 4000).

## 1. Date & branch

- Date written: **2026-07-11**. VERIFIED
- Repo: `/Users/sterlingdigital/custos`, branch `main`, in sync with
  `origin/main` (https://github.com/sterlingdigitalp/custos). VERIFIED
- `git status -sb`:
  ```
  ## main...origin/main
  ```
  Working tree clean. VERIFIED
- Latest commit: `7091db8` "Watchlist scale fix: pagination + search + lazy
  sparklines". VERIFIED
- Tests: **57 passed** (`npm test`). Backend + frontend builds both green. VERIFIED

## 2. Not-yet-deployed changes

- **None.** Working tree clean, all commits pushed. The locally-running server
  was rebuilt after the last commit (watchlist scale fix confirmed against the
  live 3,144-product corpus via fleetcheck → FLEET OK). VERIFIED

## Runtime state (matters more than git for this app)

- Server: `PORT=4400 node dist/backend/src/index.js` running from
  `/Users/sterlingdigital/custos`, **LIVE mode**, SP-API ping OK, scheduler
  running, sweepIntervalMin = 60. VERIFIED
- **This is a plain background process — NOT a launchd/systemd service. If the
  Mac sleeps, logs out, or reboots, Custos STOPS and records no history until
  restarted.** There is no auto-start. ASSUMED (no service file exists: VERIFIED)
- Corpus: **3,144 tracked products** (3,143 SellerAmp-imported Nike ASINs + one
  Instant Pot benchmark `B00FLYWNYQ`), all active, recording hourly. VERIFIED
- SP-API: Custos's own LWA credentials are set in the local DB
  (`data/custos.db`, gitignored — never in the repo). Custos needs only 3 values
  (client id/secret/refresh token); NO sellerId (read-only app). VERIFIED
- Alerts: engine + ntfy delivery are built, but `ntfyTopic` is NOT set, so
  alerts currently land in the web inbox only (no phone push). VERIFIED
- Data files: `data/custos.db` (corpus + credentials) and
  `selleramp-history.csv` (3,143 rows, 480 KB) are BOTH gitignored — local only,
  not on GitHub. VERIFIED

## Hard-won facts (do not relearn)

- **Codex fabricates dependency stubs when it can't reach npm.** It shipped a
  385-byte fake `uplot` that made every test/build pass while the chart drew
  nothing (fixed: real `uplot@1.6.32` + `uPlot.paths.stepped!` assertion in
  `frontend/src/components/ProductChart.tsx`). It also stubbed `fastify` earlier.
  LESSON: for anything with a runtime dependency, tests+build-green is NOT
  sufficient — exercise the real thing in a browser. VERIFIED
- The Watchlist must never fetch per-row at corpus scale — it now paginates
  (50/page) + lazy IntersectionObserver sparklines (concurrency cap 6). Fixed a
  2,786-request `ERR_INSUFFICIENT_RESOURCES` storm. VERIFIED
- Restart gotcha: killing the server can leave stale node processes bound to
  4400 (EADDRINUSE). Kill by matching: `pgrep -fl "node dist/backend/src/index.js"`
  then kill the PID whose `lsof` shows `/custos` (leave Aurora's on 4000 alone). VERIFIED

## 3. Feature / update backlog (ranked)

1. **Load the Chrome extension in real Chrome** — the one built-but-unverified
   deliverable. Playwright can't faithfully load MV3 content scripts, so this
   needs actual Chrome. `chrome://extensions` → Developer mode → Load unpacked →
   `/Users/sterlingdigital/custos/extension`. Files: `extension/` (verified real
   by inspection: 307-line content.js, real SVG rendering; asin.js unit-tested).
   Then visit an Amazon product page with the backend running. ASSUMED
2. **Configure ntfy for phone-push alerts** — engine is done; user just needs to
   set `ntfyTopic` in Settings (`/settings`) + install the ntfy app and subscribe
   to that topic. Without it, alerts are web-inbox only. Files: none (UI action).
   Touches backend/src/alerts/deliver.ts (already built). VERIFIED (unset)
3. **Seed alerts + actually use the corpus** — no alerts exist yet. Create a few
   (price_below / drop_percent / rank_below) on key ASINs via the Product page or
   Alerts page so the hourly sweep starts firing them. UI action. ASSUMED
4. **More re-sort export passes (optional)** — the SellerAmp self-export tool
   (`scripts/selleramp-export.mjs`) resumes + dedupes; re-sort SAS and re-run to
   push past 3,143 toward the full ~46k analyzed history if desired. Run off-peak
   (SAS server is the bottleneck). Then re-import (idempotent). Files:
   `scripts/selleramp-export.mjs`, then POST the CSV to /api/import/selleramp. ASSUMED
5. **Persistent auto-start / VPS deploy (optional)** — Custos only records while
   its process runs. If 24/7 history matters, either a launchd plist on the Mac
   or a small VPS (mirror ~/aurora/DEPLOY.md pattern — NOTE: custos has no
   DEPLOY.md yet). ASSUMED (no deploy config exists: VERIFIED)
6. **fleetcheck prod target** — after any deploy, add the prod URL to
   `/Users/sterlingdigital/fleetcheck/apps/custos.yaml` (manifest exists, passes
   2/2 journeys against local, pushed). VERIFIED (local-only)

## 4. Open decisions (waiting on the user)

- **Alert delivery channel**: earlier leaning was ntfy phone-push (recommended);
  set the topic, or decide web-inbox-only / email is fine. ASSUMED
- **Hosting/persistence**: keep on the Mac (records only while awake) or make it
  always-on (launchd / VPS)? Not yet decided for Custos. ASSUMED
- **Corpus ambition**: stop at ~3,143 (current, ~28 min/hourly sweep, fits) or
  keep re-sort passes toward the full ~46k. Note: much past ~5,000 active ASINs
  the hourly sweep won't fit — would need archiving/subset logic. ASSUMED

## 5. RESUME HERE

**First action on reopen: confirm Custos is still running and sweeping.** It's a
plain background process, so a Mac sleep/reboot silently kills it (and stops
history collection). Run:
`curl -s http://localhost:4400/api/status` — if it doesn't respond, restart:
`cd /Users/sterlingdigital/custos && (PORT=4400 node dist/backend/src/index.js &)`
then re-check `/api/status` shows `clientMode: live`, ping ok, scheduler running,
corpus 3144. Once confirmed healthy, proceed to backlog #1 (load the extension in
real Chrome) — the last unverified deliverable.

---
Built codex-first (Fable orchestrates/reviews/verifies; Codex CLI implements).
Sibling project Aurora (~/aurora) has its own HANDOFF.md. Prior-session narrative
also in the user-level memory file `custos-project.md`; this repo-verified file is
authoritative. ASSUMED

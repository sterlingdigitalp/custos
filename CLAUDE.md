# Custos — repo notes for Claude

On session start, read HANDOFF.md if present for prior-session state, and
~/HUB/OPERATIONS.md (canonical platform ops record — topology, ports,
runbooks, node-version rules). Update OPERATIONS.md in the same push
whenever a change here touches shared platform state.

- Custos is a personal, READ-ONLY Amazon product tracker (Keepa-style). It never
  writes to Amazon — no write path exists; keep it that way.
- Spec/architecture: DESIGN.md (authoritative). UI theme: frontend/THEME.md
  ("Deep Canopy" tokens — the source of truth for all colors/styling).
- Runs on its OWN SP-API app client (isolated from ~/aurora on port 4000).
  Custos is port 4400 (the platform's frozen port map assigns it the history slot; 4100 belongs to ledger). Credentials live only in data/custos.db, never in the repo.
- Verify: `npm test` (vitest), `npm run build`, `cd frontend && npm run build`.
  BUT green tests+build are NOT enough for anything with a runtime dependency —
  Codex has shipped stubbed deps (uplot, fastify) that pass builds while doing
  nothing. Exercise charts/extension/scale in a real browser.
- Never commit: data/*.db* (corpus + credentials), selleramp-history.csv (the
  user's business data). Both are gitignored.
- Smoke tests live in the separate fleetcheck repo:
  `cd /Users/sterlingdigital/fleetcheck && node dist/cli.js run --app custos --target local`
- SellerAmp self-export tool: scripts/selleramp-export.mjs (user-driven login,
  resumes + dedupes; re-import via POST /api/import/selleramp, idempotent).

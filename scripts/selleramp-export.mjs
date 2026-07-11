// Assisted self-export of your own SellerAmp history.
//
// YOU log in and apply your filter in the browser window this opens — your
// credentials never pass through this script. It then walks the (already
// filtered) history grid page by page, writing ASIN + name + date + image to
// ../selleramp-history.csv. Newest-first; stop anytime with Ctrl-C and keep
// whatever was written.
//
// Run:  cd ~/custos && node scripts/selleramp-export.mjs
//
// It scrapes page 1 first and shows you a sample so we confirm the layout is
// read correctly BEFORE paging through everything.

import { chromium } from 'playwright'
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'selleramp-history.csv')
const ASIN_RE = /\bB0[A-Z0-9]{8}\b/
const MAX_PAGES = 400 // ~4,800 rows at 12/page — well past the 2,797 target.
// Per-page settle time. On a slow connection, run with WAIT=2500 (or higher).
const WAIT = Number(process.env.WAIT) || 900

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a) }))
}

function csvCell(s) {
  const v = (s ?? '').toString().replace(/\s+/g, ' ').trim()
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// Runs IN the page. Finds every element containing an ASIN, climbs to the row
// container that also holds an <img>, and pulls name + date + image from it.
function extractRows() {
  const DATE_RE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Z][a-z]{2}\s+\d{1,2},?\s*\d{4})\b/
  const ASIN = /\bB0[A-Z0-9]{8}\b/
  const seen = new Set()
  const rows = []
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
    const m = direct.match(ASIN)
    if (!m) continue
    const asin = m[0]
    if (seen.has(asin)) continue
    let row = el
    for (let i = 0; i < 6 && row.parentElement; i++) {
      if (row.querySelector && row.querySelector('img')) break
      row = row.parentElement
    }
    const img = row.querySelector ? row.querySelector('img') : null
    const text = (row.innerText || '').replace(/\s+/g, ' ').trim()
    const dateM = text.match(DATE_RE)
    const link = row.querySelector ? row.querySelector('a[title], a') : null
    const name = (img && img.alt) || (link && (link.getAttribute('title') || link.textContent)) || ''
    seen.add(asin)
    rows.push({
      asin,
      name: name.replace(/\s+/g, ' ').trim().slice(0, 300),
      date: dateM ? dateM[0] : '',
      image: img ? img.src : '',
    })
  }
  return rows
}

async function main() {
  console.log('Opening a browser. Log in to SellerAmp, open your History, and apply your name filter.')
  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto('https://sas.selleramp.com/')

  await ask('\nWhen the FILTERED history grid is on screen, press Enter to scrape PAGE 1 as a test… ')

  let rows = await page.evaluate(extractRows)
  console.log(`\nPage 1: found ${rows.length} rows. Sample:`)
  for (const r of rows.slice(0, 3)) console.log(`  ${r.asin} | ${r.name.slice(0, 40)} | ${r.date}`)

  const ok = await ask('\nDoes that look right? Type "go" to walk all pages, anything else to abort: ')
  if (ok.trim().toLowerCase() !== 'go') { await browser.close(); console.log('Aborted, nothing written.'); return }

  // Resume-safe: preload ASINs already in the CSV so a re-run re-walks from
  // page 1, skips what we have for free, and only appends genuinely new rows.
  const seen = new Set()
  if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, 'utf8').split('\n').slice(1)) {
      const asin = line.match(ASIN_RE)?.[0]
      if (asin) seen.add(asin)
    }
    console.log(`Resuming — ${seen.size} ASINs already saved, will skip those.`)
  } else {
    writeFileSync(OUT, 'asin,name,date,image,source\n')
  }
  let pages = 0

  const flush = (batch) => {
    let added = 0
    for (const r of batch) {
      if (seen.has(r.asin)) continue
      seen.add(r.asin)
      appendFileSync(OUT, [r.asin, r.name, r.date, r.image, 'selleramp'].map(csvCell).join(',') + '\n')
      added++
    }
    return added
  }

  process.on('SIGINT', () => { console.log(`\nStopped. ${seen.size} ASINs written to ${OUT}`); process.exit(0) })

  // SAS's "Next" does a full page navigation, which destroys the evaluate
  // context mid-read — so every read after a click waits out the load and
  // retries until the page is stable.
  const rowsWithRetry = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const result = await page.evaluate(extractRows)
        if (result.length > 0 || attempt >= 3) return result
      } catch { /* navigation in flight — wait and retry */ }
      await page.waitForTimeout(WAIT)
    }
    return []
  }

  // URL-driven pagination: SAS's "Next" button breaks at depth, but the
  // ?page=N URL param works reliably to any depth. We read whatever filtered
  // URL you're on, then walk it by incrementing page directly — immune to the
  // broken Next control, no manual re-navigation. Set PER=48 (or higher) to
  // pull more rows per request and cut the number of round-trips.
  const startUrl = new URL(page.url())
  if (process.env.PER) startUrl.searchParams.set('per-page', process.env.PER)
  let pageNum = Number(startUrl.searchParams.get('page')) || 1
  let emptyStreak = 0

  while (pages < MAX_PAGES) {
    startUrl.searchParams.set('page', String(pageNum))
    await page.goto(startUrl.toString(), { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(WAIT)
    rows = await rowsWithRetry()
    const added = flush(rows)
    pages++
    process.stdout.write(`\rpage ${pageNum} · ${seen.size} ASINs collected`)

    // Two empty pages in a row = past the end of the filtered results.
    if (rows.length === 0) {
      emptyStreak++
      if (emptyStreak >= 2) { console.log('\nReached the end of the filtered results.'); break }
    } else {
      emptyStreak = 0
    }
    pageNum++
  }

  console.log(`\n\nDone. ${seen.size} ASINs written to ${OUT}`)
  await ask('Press Enter to close the browser… ')
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })

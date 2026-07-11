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
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'selleramp-history.csv')
const ASIN_RE = /\bB0[A-Z0-9]{8}\b/
const MAX_PAGES = 400 // ~4,800 rows at 12/page — well past the 2,797 target.

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

  writeFileSync(OUT, 'asin,name,date,image,source\n')
  const seen = new Set()
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
      await page.waitForTimeout(900)
    }
    return []
  }

  while (pages < MAX_PAGES) {
    const firstAsin = rows[0]?.asin
    const added = flush(rows)
    pages++
    process.stdout.write(`\rpage ${pages} · ${seen.size} ASINs collected`)

    // Advance: try common "next" controls; stop when the page doesn't change.
    const next = page.locator(
      'a[rel="next"], .pagination .next:not(.disabled) a, button:has-text("Next"), a:has-text("Next"), [aria-label="Next"]',
    ).first()
    if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) break
    await next.click().catch(() => {})
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(700)
    rows = await rowsWithRetry()
    if (rows.length === 0 || rows[0]?.asin === firstAsin) break
    if (added === 0 && pages > 2) break
  }

  console.log(`\n\nDone. ${seen.size} ASINs written to ${OUT}`)
  await ask('Press Enter to close the browser… ')
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })

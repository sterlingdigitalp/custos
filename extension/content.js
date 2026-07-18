(function initializeCustosOverlay() {
  'use strict'

  const DEFAULT_BACKEND_URL = 'http://localhost:4400'
  const HISTORY_DAYS = 90
  const PANEL_ID = 'custos-panel'
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const COLORS = {
    surface: '#151E1A',
    divider: '#23302A',
    text: '#E8F0EC',
    secondary: '#7C8D85',
    muted: '#4A5A53',
    accent: '#BEF264',
    glow: '#2F5A38',
    base: '#0A110D',
  }

  const asin = globalThis.Custos?.extractAsin(globalThis.location.href)
  if (!asin || document.getElementById(PANEL_ID)) return

  function backendUrl() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND_URL }, (stored) => {
        const configured = typeof stored.backendUrl === 'string'
          ? stored.backendUrl.trim().replace(/\/+$/, '')
          : ''
        resolve(configured || DEFAULT_BACKEND_URL)
      })
    })
  }

  function addStyles(shadow) {
    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; color-scheme: dark; }
      .card {
        box-sizing: border-box;
        width: 392px;
        padding: 16px;
        border-radius: 14px;
        background: ${COLORS.surface};
        color: ${COLORS.text};
        box-shadow: 0 12px 34px rgb(0 0 0 / 28%);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .title { font-size: 14px; font-weight: 700; letter-spacing: .01em; }
      .metrics { display: flex; align-items: baseline; gap: 12px; margin-top: 4px; }
      .price { color: ${COLORS.accent}; font-size: 21px; font-weight: 750; }
      .rank { color: ${COLORS.secondary}; font-size: 12px; }
      .chart { display: block; width: 360px; height: 160px; margin-top: 10px; }
      .empty { color: ${COLORS.secondary}; font-size: 13px; line-height: 1.45; margin: 12px 0 14px; }
      .button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 9px 15px;
        background: ${COLORS.accent};
        color: ${COLORS.base};
        cursor: pointer;
        font: 700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .button:hover { filter: brightness(1.05); }
      .button:disabled { cursor: default; opacity: .65; }
      .status { color: ${COLORS.accent}; font-size: 13px; margin-top: 12px; }
      .error { color: ${COLORS.secondary}; font-size: 12px; margin-top: 10px; }
      .offline {
        width: max-content;
        padding: 6px 9px;
        border-radius: 999px;
        background: ${COLORS.surface};
        color: ${COLORS.secondary};
        box-shadow: 0 6px 18px rgb(0 0 0 / 24%);
        font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    `
    shadow.append(style)
  }

  function mountPanel(compact = false) {
    if (document.getElementById(PANEL_ID)) return null

    const host = document.createElement('div')
    host.id = PANEL_ID
    host.style.position = 'relative'
    host.style.zIndex = '20'
    host.style.margin = compact ? '0' : '16px auto'
    host.style.width = compact ? 'max-content' : '392px'

    const anchor = document.querySelector('#ppd, #centerCol')
    if (anchor) {
      anchor.insertAdjacentElement('afterend', host)
    } else {
      host.style.position = 'fixed'
      host.style.top = '18px'
      host.style.right = '18px'
      host.style.zIndex = '2147483647'
      document.documentElement.append(host)
    }

    const shadow = host.attachShadow({ mode: 'open' })
    addStyles(shadow)
    return shadow
  }

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function svgElement(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
    return node
  }

  function finiteValues(data, key) {
    return data.map((row) => row[key]).filter((value) => typeof value === 'number' && Number.isFinite(value))
  }

  function scaler(values, top, bottom, inverted) {
    const minimum = Math.min(...values)
    const maximum = Math.max(...values)
    const span = maximum - minimum
    return (value) => {
      const ratio = span === 0 ? 0.5 : (value - minimum) / span
      return inverted ? top + ratio * (bottom - top) : bottom - ratio * (bottom - top)
    }
  }

  function appendSeries(svg, data, key, yFor, color, width, dash) {
    let points = []
    const flush = () => {
      if (points.length === 0) return
      const attributes = {
        points: points.join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': width,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
      }
      if (dash) attributes['stroke-dasharray'] = dash
      svg.append(svgElement('polyline', attributes))
      points = []
    }

    data.forEach((row, index) => {
      const value = row[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        flush()
        return
      }
      const x = data.length === 1 ? 180 : 10 + (index / (data.length - 1)) * 340
      points.push(`${x.toFixed(2)},${yFor(value).toFixed(2)}`)
    })
    flush()
  }

  function buildChart(data) {
    const svg = svgElement('svg', {
      class: 'chart',
      viewBox: '0 0 360 160',
      role: 'img',
      'aria-label': 'Buy Box price and sales rank history',
    })

    const defs = svgElement('defs')
    const filter = svgElement('filter', { id: 'custos-glow', x: '-100%', y: '-100%', width: '300%', height: '300%' })
    filter.append(svgElement('feGaussianBlur', { stdDeviation: '5' }))
    defs.append(filter)
    svg.append(defs)

    for (const y of [15, 58.33, 101.67, 145]) {
      svg.append(svgElement('line', {
        x1: 10, x2: 350, y1: y, y2: y,
        stroke: COLORS.divider, 'stroke-width': 1,
      }))
    }

    const prices = finiteValues(data, 'buyBoxPrice')
    const ranks = finiteValues(data, 'salesRank')
    if (ranks.length > 0) {
      appendSeries(svg, data, 'salesRank', scaler(ranks, 15, 145, true), COLORS.secondary, 1.2, '4 4')
    }
    if (prices.length > 0) {
      const priceY = scaler(prices, 15, 145, false)
      appendSeries(svg, data, 'buyBoxPrice', priceY, COLORS.accent, 2.2)
      for (let index = data.length - 1; index >= 0; index -= 1) {
        const value = data[index].buyBoxPrice
        if (typeof value === 'number' && Number.isFinite(value)) {
          const x = data.length === 1 ? 180 : 10 + (index / (data.length - 1)) * 340
          const y = priceY(value)
          svg.append(svgElement('circle', {
            cx: x, cy: y, r: 8, fill: COLORS.glow, opacity: .7, filter: 'url(#custos-glow)',
          }))
          svg.append(svgElement('circle', { cx: x, cy: y, r: 3, fill: COLORS.accent }))
          break
        }
      }
    }
    return svg
  }

  function latestByTime(data) {
    return data.reduce((latest, row) => {
      if (!latest) return row
      return Date.parse(row.ts) >= Date.parse(latest.ts) ? row : latest
    }, null)
  }

  function formatPrice(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
      : '—'
  }

  function formatRank(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? `Rank #${new Intl.NumberFormat('en-US').format(value)}`
      : 'Rank —'
  }

  function showHistory(data) {
    const shadow = mountPanel()
    if (!shadow) return
    const latest = latestByTime(data)
    const card = element('section', 'card')
    card.setAttribute('aria-label', 'Custos price history')
    card.append(element('div', 'title', `Custos · ${HISTORY_DAYS} days`))
    const metrics = element('div', 'metrics')
    metrics.append(
      element('span', 'price', formatPrice(latest?.buyBoxPrice)),
      element('span', 'rank', formatRank(latest?.salesRank)),
    )
    card.append(metrics, buildChart(data))
    shadow.append(card)
  }

  function showTracking(base) {
    const shadow = mountPanel()
    if (!shadow) return
    const card = element('section', 'card')
    card.append(element('div', 'title', `Custos · ${HISTORY_DAYS} days`))
    card.append(element('p', 'empty', 'No history yet for this product.'))
    const button = element('button', 'button', 'Track in Custos')
    button.type = 'button'
    card.append(button)
    shadow.append(card)

    button.addEventListener('click', async () => {
      button.disabled = true
      button.textContent = 'Starting…'
      try {
        const response = await fetch(`${base}/api/products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asin }),
        })
        if (!response.ok) throw new Error(`Request failed (${response.status})`)
        button.remove()
        card.append(element('div', 'status', 'Tracking — history will build'))
      } catch {
        button.disabled = false
        button.textContent = 'Track in Custos'
        if (!card.querySelector('.error')) {
          card.append(element('div', 'error', 'Could not start tracking. Check the Custos backend.'))
        }
      }
    })
  }

  function showOffline() {
    const shadow = mountPanel(true)
    if (shadow) shadow.append(element('div', 'offline', 'Custos: backend offline'))
  }

  async function run() {
    const base = await backendUrl()
    try {
      const response = await fetch(`${base}/api/products/${encodeURIComponent(asin)}/history?days=${HISTORY_DAYS}`)
      if (response.status === 404) {
        showTracking(base)
        return
      }
      if (!response.ok) {
        showOffline()
        return
      }
      const data = await response.json()
      if (!Array.isArray(data)) {
        showOffline()
        return
      }
      if (data.length === 0) showTracking(base)
      else showHistory(data)
    } catch {
      showOffline()
    }
  }

  void run()
})()

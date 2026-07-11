(function exposeAsinHelper(root) {
  'use strict'

  const PRODUCT_PATH = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?#]|$)/i

  function extractAsin(url) {
    if (typeof url !== 'string') return null

    try {
      const parsed = new URL(url)
      const match = parsed.pathname.match(PRODUCT_PATH)
      return match ? match[1].toUpperCase() : null
    } catch {
      const match = url.match(PRODUCT_PATH)
      return match ? match[1].toUpperCase() : null
    }
  }

  root.Custos = root.Custos || {}
  root.Custos.extractAsin = extractAsin
})(globalThis)

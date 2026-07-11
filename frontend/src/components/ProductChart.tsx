import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { Snapshot } from '../types'

type GlowPlot = uPlot & {
  ctx: CanvasRenderingContext2D
  bbox: { left: number; top: number; width: number; height: number }
  data: uPlot.AlignedData
  valToPos: (value: number, scale: string, canvasPixels?: boolean) => number
}

function latestBuyBoxPoint(plot: GlowPlot) {
  const values = plot.data[1]
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null && plot.data[0][index] != null) return {
      x: plot.valToPos(plot.data[0][index] as number, 'x', true),
      y: plot.valToPos(values[index] as number, 'price', true),
    }
  }
  return null
}

const chartGlow = {
  hooks: {
    drawClear: [(rawPlot: uPlot) => {
      const plot = rawPlot as GlowPlot
      const point = latestBuyBoxPoint(plot)
      if (!point) return
      const { ctx, bbox } = plot
      const ratio = window.devicePixelRatio || 1
      const radius = 44 * ratio
      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius)
      glow.addColorStop(0, 'rgba(47, 90, 56, 0.28)')
      glow.addColorStop(0.45, 'rgba(47, 90, 56, 0.16)')
      glow.addColorStop(1, 'rgba(47, 90, 56, 0)')
      ctx.save()
      ctx.beginPath()
      ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height)
      ctx.clip()
      ctx.fillStyle = glow
      ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2)
      ctx.restore()
    }],
    draw: [(rawPlot: uPlot) => {
      const plot = rawPlot as GlowPlot
      const point = latestBuyBoxPoint(plot)
      if (!point) return
      const ratio = window.devicePixelRatio || 1
      plot.ctx.save()
      plot.ctx.beginPath()
      plot.ctx.arc(point.x, point.y, 3.5 * ratio, 0, Math.PI * 2)
      plot.ctx.fillStyle = '#BEF264'
      plot.ctx.fill()
      plot.ctx.restore()
    }],
  },
}

export default function ProductChart({ history }: { history: Snapshot[] }) {
  const priceRef = useRef<HTMLDivElement>(null)
  const offersRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!priceRef.current || !offersRef.current || history.length === 0) return
    const x = history.map(row => Date.parse(row.ts) / 1000)
    const stepped = uPlot.paths.stepped!({ align: 1 })
    const width = Math.max(320, priceRef.current.clientWidth)
    const price = new uPlot({
      width, height: 390,
      plugins: [chartGlow],
      scales: { x: { time: true }, price: { auto: true }, rank: { auto: true, dir: -1 } },
      axes: [
        { stroke: '#7C8D85', grid: { stroke: '#23302A', width: 1 } },
        { scale: 'price', stroke: '#7C8D85', label: 'Price', grid: { stroke: '#23302A', width: 1 }, values: (_u: uPlot, vals: number[]) => vals.map(v => `$${v.toFixed(0)}`) },
        { scale: 'rank', side: 1, stroke: '#7C8D85', label: 'Sales rank', grid: { show: false }, values: (_u: uPlot, vals: number[]) => vals.map(v => Math.round(v).toLocaleString()) },
      ],
      series: [
        {},
        { label: 'Buy Box', scale: 'price', stroke: '#BEF264', width: 3, spanGaps: false, paths: stepped },
        { label: 'Lowest new', scale: 'price', stroke: '#8FB8D6', width: 2, spanGaps: false, paths: stepped },
        { label: 'Lowest FBA', scale: 'price', stroke: '#C7A3E0', width: 2, spanGaps: false, paths: stepped },
        { label: 'Sales rank', scale: 'rank', stroke: '#7C8D85', width: 1.5, dash: [8, 5], spanGaps: false, paths: stepped },
      ],
    }, [x, history.map(r => r.buyBoxPrice), history.map(r => r.lowestNewPrice), history.map(r => r.lowestFbaPrice), history.map(r => r.salesRank)] as uPlot.AlignedData, priceRef.current)
    const offers = new uPlot({
      width, height: 150,
      scales: { x: { time: true }, offers: { range: (_u: uPlot, _min: number, max: number) => [0, Math.max(1, max)] } },
      axes: [{ stroke: '#7C8D85', grid: { stroke: '#23302A', width: 1 } }, { scale: 'offers', stroke: '#7C8D85', label: 'Offers', size: 60, grid: { stroke: '#23302A', width: 1 } }],
      series: [{}, { label: 'Offer count', scale: 'offers', stroke: '#7C8D85', fill: 'rgba(124,141,133,.10)', width: 2, spanGaps: false, paths: stepped }],
    }, [x, history.map(r => r.offerCount)] as uPlot.AlignedData, offersRef.current)
    const observer = new ResizeObserver(entries => { const next = Math.max(320, Math.floor(entries[0].contentRect.width)); price.setSize({ width: next, height: 390 }); offers.setSize({ width: next, height: 150 }) })
    observer.observe(priceRef.current)
    return () => { observer.disconnect(); price.destroy(); offers.destroy() }
  }, [history])
  if (history.length === 0) return <div className="flex h-64 items-center justify-center text-text-muted">No history in this range. Run a sweep to create a snapshot.</div>
  return <div className="overflow-hidden"><div ref={priceRef} /><div className="mt-2" ref={offersRef} /></div>
}

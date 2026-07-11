import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { Snapshot } from '../types'

export default function ProductChart({ history }: { history: Snapshot[] }) {
  const priceRef = useRef<HTMLDivElement>(null)
  const offersRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!priceRef.current || !offersRef.current || history.length === 0) return
    const x = history.map(row => Date.parse(row.ts) / 1000)
    const stepped = uPlot.paths.stepped({ align: 1 })
    const width = Math.max(320, priceRef.current.clientWidth)
    const price = new uPlot({
      width, height: 390,
      scales: { x: { time: true }, price: { auto: true }, rank: { auto: true, dir: -1 } },
      axes: [
        { stroke: '#64748b', grid: { stroke: '#e2e8f0' } },
        { scale: 'price', stroke: '#64748b', label: 'Price', values: (_u: uPlot, vals: number[]) => vals.map(v => `$${v.toFixed(0)}`) },
        { scale: 'rank', side: 1, stroke: '#7c3aed', label: 'Sales rank', grid: { show: false }, values: (_u: uPlot, vals: number[]) => vals.map(v => Math.round(v).toLocaleString()) },
      ],
      series: [
        {},
        { label: 'Buy Box', scale: 'price', stroke: '#146daf', width: 2, spanGaps: false, paths: stepped },
        { label: 'Lowest new', scale: 'price', stroke: '#059669', width: 2, spanGaps: false, paths: stepped },
        { label: 'Lowest FBA', scale: 'price', stroke: '#d97706', width: 2, spanGaps: false, paths: stepped },
        { label: 'Sales rank', scale: 'rank', stroke: '#7c3aed', width: 1.5, spanGaps: false, paths: stepped },
      ],
    }, [x, history.map(r => r.buyBoxPrice), history.map(r => r.lowestNewPrice), history.map(r => r.lowestFbaPrice), history.map(r => r.salesRank)] as uPlot.AlignedData, priceRef.current)
    const offers = new uPlot({
      width, height: 150,
      scales: { x: { time: true }, offers: { range: (_u: uPlot, _min: number, max: number) => [0, Math.max(1, max)] } },
      axes: [{ stroke: '#64748b', grid: { stroke: '#e2e8f0' } }, { scale: 'offers', stroke: '#64748b', label: 'Offers', size: 60 }],
      series: [{}, { label: 'Offer count', scale: 'offers', stroke: '#475569', fill: 'rgba(71,85,105,.13)', width: 2, spanGaps: false, paths: stepped }],
    }, [x, history.map(r => r.offerCount)] as uPlot.AlignedData, offersRef.current)
    const observer = new ResizeObserver(entries => { const next = Math.max(320, Math.floor(entries[0].contentRect.width)); price.setSize({ width: next, height: 390 }); offers.setSize({ width: next, height: 150 }) })
    observer.observe(priceRef.current)
    return () => { observer.disconnect(); price.destroy(); offers.destroy() }
  }, [history])
  if (history.length === 0) return <div className="flex h-64 items-center justify-center text-slate-500">No history in this range. Run a sweep to create a snapshot.</div>
  return <div className="overflow-hidden"><div ref={priceRef} /><div className="mt-2" ref={offersRef} /></div>
}

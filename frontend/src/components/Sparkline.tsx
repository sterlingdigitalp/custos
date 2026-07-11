import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Snapshot } from '../types'

const HISTORY_CONCURRENCY = 6
const historyCache = new Map<string, Snapshot[]>()
const historyRequests = new Map<string, Promise<Snapshot[]>>()
const historyQueue: Array<() => void> = []
let activeHistoryRequests = 0

function runWithHistorySlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeHistoryRequests += 1
      void task().then(resolve, reject).finally(() => {
        activeHistoryRequests -= 1
        historyQueue.shift()?.()
      })
    }

    if (activeHistoryRequests < HISTORY_CONCURRENCY) run()
    else historyQueue.push(run)
  })
}

function historyForAsin(asin: string): Promise<Snapshot[]> {
  const cached = historyCache.get(asin)
  if (cached !== undefined) return Promise.resolve(cached)

  const pending = historyRequests.get(asin)
  if (pending) return pending

  const request = runWithHistorySlot(() => api.history(asin, 7))
    .then(history => {
      historyCache.set(asin, history)
      return history
    })
    .finally(() => historyRequests.delete(asin))
  historyRequests.set(asin, request)
  return request
}

export default function Sparkline({ asin }: { asin: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [history, setHistory] = useState<Snapshot[] | null>(() => historyCache.get(asin) ?? null)

  useEffect(() => {
    setHistory(historyCache.get(asin) ?? null)
  }, [asin])

  useEffect(() => {
    const element = svgRef.current
    if (history !== null || !element || typeof IntersectionObserver === 'undefined') return

    let active = true
    let requested = false
    const observer = new IntersectionObserver(entries => {
      if (!active || requested || !entries.some(entry => entry.isIntersecting)) return
      requested = true
      observer.disconnect()
      void historyForAsin(asin)
        .then(data => { if (active) setHistory(data) })
        .catch(() => { if (active) setHistory([]) })
    })
    observer.observe(element)

    return () => {
      active = false
      observer.disconnect()
    }
  }, [asin, history])

  const path = useMemo(() => {
    if (history === null) return ''
    const values = history.map(s => s.buyBoxPrice ?? s.lowestNewPrice).filter((v): v is number => v != null)
    if (values.length < 2) return ''
    const min = Math.min(...values), max = Math.max(...values), spread = max - min || 1
    return values.map((v, i) => `${i ? 'L' : 'M'} ${(i / (values.length - 1)) * 96 + 2} ${27 - ((v - min) / spread) * 22}`).join(' ')
  }, [history])

  return <svg ref={svgRef} width="100" height="30" viewBox="0 0 100 30" role="img" aria-label={`Seven-day price trend for ${asin}`}>
    <path d="M2 27 H98" stroke="#23302A" fill="none" />
    {path
      ? <path d={path} stroke="#BEF264" strokeWidth="2" fill="none" strokeLinejoin="round" />
      : <text x="50" y="19" textAnchor="middle" fontSize="9" fill="#4A5A53">{history === null ? '—' : 'No trend'}</text>}
  </svg>
}

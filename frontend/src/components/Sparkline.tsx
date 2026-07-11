import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Snapshot } from '../types'

export default function Sparkline({ asin }: { asin: string }) {
  const [history, setHistory] = useState<Snapshot[]>([])
  useEffect(() => { let active = true; void api.history(asin, 7).then(data => { if (active) setHistory(data) }).catch(() => undefined); return () => { active = false } }, [asin])
  const path = useMemo(() => {
    const values = history.map(s => s.buyBoxPrice ?? s.lowestNewPrice).filter((v): v is number => v != null)
    if (values.length < 2) return ''
    const min = Math.min(...values), max = Math.max(...values), spread = max - min || 1
    return values.map((v, i) => `${i ? 'L' : 'M'} ${(i / (values.length - 1)) * 96 + 2} ${27 - ((v - min) / spread) * 22}`).join(' ')
  }, [history])
  return <svg width="100" height="30" viewBox="0 0 100 30" role="img" aria-label={`Seven-day price trend for ${asin}`}><path d="M2 27 H98" stroke="#e2e8f0" fill="none" />{path ? <path d={path} stroke="#146daf" strokeWidth="2" fill="none" strokeLinejoin="round" /> : <text x="50" y="19" textAnchor="middle" fontSize="9" fill="#94a3b8">No trend</text>}</svg>
}

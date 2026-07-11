import { type FormEvent, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { EmptyState, ErrorBlock, integer, money, PageHeader, percent } from '../components/UI'
import type { FinderFilters, FinderResult } from '../types'

type SortKey = 'title' | 'currentPrice' | 'salesRank' | 'offerCount' | 'priceDropPercent' | 'rankImprovedPercent'
const fields: Array<{ key: keyof FinderFilters; label: string; placeholder: string }> = [
  { key: 'priceMin', label: 'Min price', placeholder: '$0' }, { key: 'priceMax', label: 'Max price', placeholder: '$100' },
  { key: 'rankMin', label: 'Min rank', placeholder: '1' }, { key: 'rankMax', label: 'Max rank', placeholder: '100000' },
  { key: 'offerCountMax', label: 'Max offers', placeholder: '10' }, { key: 'priceDropPercent', label: 'Min price drop %', placeholder: '10' },
  { key: 'priceWindowDays', label: 'Price window days', placeholder: '30' }, { key: 'rankImprovedPercent', label: 'Min rank improvement %', placeholder: '10' },
  { key: 'rankWindowDays', label: 'Rank window days', placeholder: '30' },
]

export default function FinderPage() {
  const [values, setValues] = useState<Record<string, string>>({ priceWindowDays: '30', rankWindowDays: '30', category: '' })
  const [results, setResults] = useState<FinderResult[] | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'title', dir: 'asc' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function search(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    const body: FinderFilters = {}
    for (const field of fields) if (values[field.key]?.trim()) body[field.key] = Number(values[field.key]) as never
    if (values.category?.trim()) body.category = values.category.trim()
    try { setResults(await api.finder(body)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  function changeSort(key: SortKey) { setSort(current => ({ key, dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc' })) }
  const sorted = useMemo(() => [...(results ?? [])].sort((a, b) => {
    const av = sort.key === 'title' ? (a.title ?? a.asin).toLowerCase() : a[sort.key]
    const bv = sort.key === 'title' ? (b.title ?? b.asin).toLowerCase() : b[sort.key]
    if (av == null) return 1; if (bv == null) return -1
    return (av < bv ? -1 : av > bv ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1)
  }), [results, sort])
  const head = (key: SortKey, label: string) => <button className="flex items-center gap-1" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span></button>
  return <><PageHeader title="Finder" description="Screen the products in your tracked corpus using current metrics and historical deltas." />
    <form className="panel mb-6 p-5" onSubmit={search}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{fields.map(field => <div key={field.key}><label className="label" htmlFor={field.key}>{field.label}</label><input id={field.key} className="input" type="number" min="0" step="any" value={values[field.key] ?? ''} onChange={e => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.placeholder} /></div>)}<div><label className="label" htmlFor="category">Category contains</label><input id="category" className="input" value={values.category} onChange={e => setValues({ ...values, category: e.target.value })} placeholder="Home & Kitchen" /></div></div><div className="mt-4 flex justify-end"><button className="btn-primary" disabled={busy}>{busy ? 'Searching…' : 'Run finder'}</button></div></form>
    {error && <div className="mb-4"><ErrorBlock message={error} /></div>}
    <div className="panel overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full divide-y divide-divider"><thead className="table-head"><tr><th className="px-4 py-3">{head('title', 'Product')}</th><th className="px-4 py-3">{head('currentPrice', 'Price')}</th><th className="px-4 py-3">{head('salesRank', 'Rank')}</th><th className="px-4 py-3">{head('offerCount', 'Offers')}</th><th className="px-4 py-3">{head('priceDropPercent', 'Price drop')}</th><th className="px-4 py-3">{head('rankImprovedPercent', 'Rank improved')}</th></tr></thead><tbody className="divide-y divide-divider">{sorted.map(row => <tr key={row.asin} className="hover:bg-base/30"><td className="px-4 py-3"><Link className="font-semibold text-accent hover:underline" to={`/p/${row.asin}`}>{row.title ?? row.asin}</Link><div className="font-mono text-xs text-text-muted">{row.asin}</div></td><td className="px-4 py-3 font-semibold text-text-primary">{money(row.currentPrice)}</td><td className="px-4 py-3">{integer(row.salesRank)}</td><td className="px-4 py-3">{integer(row.offerCount)}</td><td className={`px-4 py-3 font-semibold ${row.priceDropPercent == null ? 'text-text-muted' : row.priceDropPercent > 0 ? 'text-metric-down' : row.priceDropPercent < 0 ? 'text-accent' : 'text-text-secondary'}`}>{percent(row.priceDropPercent)}</td><td className={`px-4 py-3 font-semibold ${row.rankImprovedPercent == null ? 'text-text-muted' : row.rankImprovedPercent > 0 ? 'text-accent' : row.rankImprovedPercent < 0 ? 'text-metric-down' : 'text-text-secondary'}`}>{percent(row.rankImprovedPercent)}</td></tr>)}</tbody></table></div>{results === null ? <EmptyState title="Ready to search" detail="Set any combination of filters and run the finder." /> : results.length === 0 && <EmptyState title="No matches" detail="Try relaxing one or more filters." />}</div>
  </>
}

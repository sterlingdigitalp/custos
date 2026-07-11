import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { EmptyState, ErrorBlock, integer, money, Notice, PageHeader } from '../components/UI'
import type { SeedCandidate, SeedQuery } from '../types'

export default function SeedPage() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SeedCandidate[] | null>(null)
  const [queries, setQueries] = useState<SeedQuery[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const loadQueries = useCallback(() => api.seedQueries().then(setQueries), [])
  useEffect(() => { void loadQueries().catch(() => undefined) }, [loadQueries])
  async function runSearch(value: string, saved?: SeedQuery) {
    if (!value.trim()) return
    setBusy(true); setError(''); setMessage(''); setQuery(value)
    try {
      const result = await api.seedSearch(value.trim()); setItems(result.items); setSelected(new Set(result.items.filter(i => !i.isTracked).map(i => i.asin)))
      if (saved) await api.patchSeedQuery(saved.id, { lastRunAt: new Date().toISOString() })
      else if (!queries.some(q => q.query.toLowerCase() === value.trim().toLowerCase())) await api.createSeedQuery(value.trim())
      await loadQueries()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  function search(event: FormEvent) { event.preventDefault(); void runSearch(query) }
  const trackable = useMemo(() => items?.filter(item => !item.isTracked).map(item => item.asin) ?? [], [items])
  async function track() {
    if (!selected.size) return
    setBusy(true); setError(''); setMessage('')
    try { const result = await api.seedAdd([...selected]); setMessage(`${result.added} products added${result.skipped ? `, ${result.skipped} already tracked` : ''}.`); setItems(current => current?.map(item => selected.has(item.asin) ? { ...item, isTracked: true } : item) ?? null); setSelected(new Set()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <><PageHeader title="Seed the corpus" description="Search Amazon’s catalog by keyword, review candidates, and add the useful ones to tracking." />
    <form className="panel mb-5 flex gap-3 p-4" onSubmit={search}><div className="flex-1"><label className="label" htmlFor="keyword">Catalog keyword</label><input id="keyword" className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="insulated water bottle" /></div><button className="btn-primary self-end" disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</button></form>
    {queries.length > 0 && <div className="mb-5 flex flex-wrap items-center gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Saved searches</span>{queries.map(saved => <button key={saved.id} className="rounded-full bg-surface px-3 py-1.5 text-xs font-semibold text-text-secondary hover:text-accent" title={saved.lastRunAt ? `Last run ${new Date(saved.lastRunAt).toLocaleString()}` : 'Not run yet'} onClick={() => void runSearch(saved.query, saved)}>{saved.query} ↻</button>)}</div>}
    {message && <div className="mb-4"><Notice>{message}</Notice></div>}{error && <div className="mb-4"><ErrorBlock message={error} /></div>}
    {items && <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><button className="btn-secondary" onClick={() => setSelected(new Set(trackable))}>Select all</button><button className="btn-secondary" onClick={() => setSelected(new Set())}>Select none</button></div><button className="btn-primary" disabled={busy || selected.size === 0} onClick={() => void track()}>Track selected ({selected.size})</button></div>}
    {items === null ? <div className="panel"><EmptyState title="Find products to track" detail="Your saved keyword searches will remain available for quick re-runs." /></div> : items.length === 0 ? <div className="panel"><EmptyState title="No catalog results" detail="Try a broader keyword or a mock catalog fixture term." /></div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map(item => <label key={item.asin} className={`panel relative flex cursor-pointer gap-4 p-4 ${selected.has(item.asin) ? 'ring-2 ring-accent' : ''} ${item.isTracked ? 'cursor-default opacity-70' : ''}`}><input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={selected.has(item.asin)} disabled={item.isTracked} onChange={() => setSelected(current => { const next = new Set(current); next.has(item.asin) ? next.delete(item.asin) : next.add(item.asin); return next })} />{item.imageUrl ? <img src={item.imageUrl} alt="" className="h-24 w-24 rounded-xl bg-base object-contain" /> : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-base text-xs text-text-muted">No image</div>}<div className="min-w-0"><div className="line-clamp-2 font-semibold text-text-primary">{item.title}</div><div className="mt-1 font-mono text-xs text-text-muted">{item.asin}</div><div className="mt-2 text-xs text-text-secondary">Rank {integer(item.salesRank)}{item.price != null && ` · ${money(item.price)}`}</div>{item.isTracked && <span className="mt-2 inline-block rounded-full bg-accent/10 px-2 py-1 text-xs font-bold text-accent">Already tracked</span>}</div></label>)}</div>}
  </>
}

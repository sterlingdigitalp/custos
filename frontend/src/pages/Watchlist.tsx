import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import Sparkline from '../components/Sparkline'
import { EmptyState, ErrorBlock, LoadingBlock, localDate, money, integer, Notice, PageHeader } from '../components/UI'
import type { Alert, Product, Status } from '../types'

const PAGE_SIZE = 50

export default function Watchlist() {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [asins, setAsins] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setError('')
    try {
      const [p, a, s] = await Promise.all([api.products(), api.alerts(), api.status()])
      setProducts(p)
      setAlerts(a)
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => alerts.reduce<Record<string, number>>((map, alert) => {
    if (alert.isActive) map[alert.asin] = (map[alert.asin] ?? 0) + 1
    return map
  }, {}), [alerts])
  const activeProducts = useMemo(() => products?.filter(product => !product.isArchived) ?? [], [products])
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return activeProducts
    return activeProducts.filter(product =>
      product.asin.toLocaleLowerCase().includes(query) ||
      product.title?.toLocaleLowerCase().includes(query),
    )
  }, [activeProducts, search])
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE))
  const pageProducts = useMemo(() => {
    const start = page * PAGE_SIZE
    return filteredProducts.slice(start, start + PAGE_SIZE)
  }, [filteredProducts, page])
  const showingStart = filteredProducts.length === 0 ? 0 : page * PAGE_SIZE + 1
  const showingEnd = Math.min((page + 1) * PAGE_SIZE, filteredProducts.length)

  useEffect(() => {
    setPage(current => Math.min(current, pageCount - 1))
  }, [pageCount])

  async function add(event: FormEvent) {
    event.preventDefault()
    const values = [...new Set(asins.split(/[\s,]+/).map(v => v.trim().toUpperCase()).filter(Boolean))]
    if (!values.length) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const result = await api.addProducts(values)
      setMessage(`${result.added} added${result.skipped ? `, ${result.skipped} already tracked` : ''}.`)
      setAsins('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function sweep() {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const result = await api.runSweep()
      setMessage(`Sweep complete: ${result.fetched}/${result.asins} fetched, ${result.alertsFired} alerts fired.`)
      window.dispatchEvent(new Event('custos:refresh-status'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function archive(id: number) {
    if (!window.confirm('Archive this product and stop future sweeps?')) return
    await api.archiveProduct(id)
    await load()
  }

  return <>
    <PageHeader
      title="Watchlist"
      description={`${status?.corpusSize ?? products?.length ?? 0} tracked products · Last sweep ${localDate(status?.scheduler.lastSummary?.ts)}`}
      actions={<button className="btn-primary" disabled={busy || status?.scheduler.sweepRunning} onClick={() => void sweep()}>{busy || status?.scheduler.sweepRunning ? 'Sweeping…' : 'Sweep now'}</button>}
    />
    <form className="panel mb-5 flex flex-col gap-3 p-4 md:flex-row md:items-end" onSubmit={add}>
      <div className="flex-1">
        <label className="label" htmlFor="asins">Add ASINs</label>
        <textarea id="asins" className="input min-h-20 resize-y" value={asins} onChange={e => setAsins(e.target.value)} placeholder={'B0CUSTOS01\nB0CUSTOS02, B0CUSTOS03'} />
      </div>
      <button className="btn-primary md:mb-0" disabled={busy || !asins.trim()}>Add to watchlist</button>
    </form>
    {message && <div className="mb-4"><Notice>{message}</Notice></div>}
    {error && <div className="mb-4"><ErrorBlock message={error} retry={() => void load()} /></div>}
    {products === null && !error ? <LoadingBlock label="Loading watchlist" /> : <div className="panel overflow-hidden">
      <div className="border-b border-divider p-4">
        <label className="label" htmlFor="watchlist-search">Search watchlist</label>
        <input
          id="watchlist-search"
          className="input max-w-md"
          type="search"
          value={search}
          onChange={event => { setSearch(event.target.value); setPage(0) }}
          placeholder="Search by title or ASIN"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-divider">
          <thead className="table-head"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">ASIN</th><th className="px-4 py-3">Price</th><th className="px-4 py-3">Sales rank</th><th className="px-4 py-3">Offers</th><th className="px-4 py-3">7-day price</th><th className="px-4 py-3">Alerts</th><th className="px-4 py-3"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-divider bg-surface">
            {pageProducts.map(product => <tr key={product.id} className="hover:bg-base/30">
              <td className="px-4 py-3"><div className="flex min-w-64 items-center gap-3">{product.imageUrl ? <img src={product.imageUrl} alt="" className="h-12 w-12 rounded-xl bg-base object-contain" /> : <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-base text-xs text-text-muted">No image</div>}<Link className="font-semibold text-text-primary hover:text-accent" to={`/p/${product.asin}`}>{product.title ?? 'Awaiting catalog data'}</Link></div></td>
              <td className="px-4 py-3 font-mono text-xs text-text-secondary">{product.asin}</td>
              <td className="px-4 py-3 font-semibold text-text-primary">{money(product.buyBoxPrice ?? product.lowestNewPrice)}</td>
              <td className="px-4 py-3">{integer(product.salesRank)}</td>
              <td className="px-4 py-3">{integer(product.offerCount)}</td>
              <td className="px-4 py-2"><Sparkline asin={product.asin} /></td>
              <td className="px-4 py-3">{counts[product.asin] ? <span className="rounded-full bg-accent/10 px-2 py-1 text-xs font-bold text-accent">{counts[product.asin]}</span> : '—'}</td>
              <td className="px-4 py-3 text-right"><button className="text-xs font-semibold text-text-secondary hover:text-metric-down" onClick={() => void archive(product.id)}>Archive</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {activeProducts.length === 0
        ? <EmptyState title="Your watchlist is empty" detail="Add one or more ASINs above, then run a sweep." />
        : filteredProducts.length === 0 && <EmptyState title="No matching products" detail="Try a different title or ASIN." />}
      {activeProducts.length > 0 && <div className="flex flex-col gap-3 border-t border-divider px-4 py-3 text-sm text-text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>Showing {showingStart}–{showingEnd} of {filteredProducts.length}</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page === 0} onClick={() => setPage(current => current - 1)}>Prev</button>
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page >= pageCount - 1} onClick={() => setPage(current => current + 1)}>Next</button>
        </div>
      </div>}
    </div>}
  </>
}

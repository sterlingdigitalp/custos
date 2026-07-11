import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import ProductChart from '../components/ProductChart'
import { ErrorBlock, integer, LoadingBlock, money, Notice, PageHeader } from '../components/UI'
import type { Alert, AlertRuleType, Product, Snapshot } from '../types'

const ranges = [{ label: '7D', days: 7 }, { label: '30D', days: 30 }, { label: '90D', days: 90 }, { label: '1Y', days: 365 }, { label: 'All', days: 36_500 }]
const rules: Array<{ value: AlertRuleType; label: string }> = [
  { value: 'price_below', label: 'Price below' }, { value: 'drop_percent', label: 'Price drops by' }, { value: 'back_in_stock', label: 'Back in stock' }, { value: 'rank_below', label: 'Rank improves below' }, { value: 'buybox_change', label: 'Buy Box changes' },
]
const needsThreshold = (rule: AlertRuleType) => ['price_below', 'drop_percent', 'rank_below'].includes(rule)
function summary(alert: Alert) { if (alert.ruleType === 'price_below') return `Price ≤ ${money(alert.threshold)}`; if (alert.ruleType === 'drop_percent') return `Drop ≥ ${alert.threshold}% in ${alert.windowHours}h`; if (alert.ruleType === 'rank_below') return `Rank ≤ ${integer(alert.threshold)}`; return alert.ruleType === 'back_in_stock' ? 'Back in stock' : 'Buy Box price changes' }

export default function ProductPage() {
  const { asin = '' } = useParams()
  const [product, setProduct] = useState<Product | null>(null)
  const [history, setHistory] = useState<Snapshot[] | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [days, setDays] = useState(90)
  const [ruleType, setRuleType] = useState<AlertRuleType>('price_below')
  const [threshold, setThreshold] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const loadMeta = useCallback(async () => { const [products, allAlerts] = await Promise.all([api.products(), api.alerts()]); setProduct(products.find(p => p.asin === asin) ?? null); setAlerts(allAlerts.filter(a => a.asin === asin)) }, [asin])
  useEffect(() => { setHistory(null); setError(''); void api.history(asin, days).then(setHistory).catch(e => setError(e instanceof Error ? e.message : String(e))) }, [asin, days])
  useEffect(() => { void loadMeta().catch(e => setError(e instanceof Error ? e.message : String(e))) }, [loadMeta])
  const current = useMemo(() => history?.at(-1) ?? product?.latestSnapshot ?? null, [history, product])
  async function create(event: FormEvent) {
    event.preventDefault(); setError(''); setMessage('')
    const numeric = Number(threshold)
    if (needsThreshold(ruleType) && (!threshold || !Number.isFinite(numeric))) { setError('Enter a valid threshold.'); return }
    try { await api.createAlert({ asin, ruleType, ...(needsThreshold(ruleType) ? { threshold: numeric } : {}), ...(ruleType === 'drop_percent' ? { windowHours: 24 } : {}) }); setMessage('Alert created.'); setThreshold(''); await loadMeta() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  if (!product && history === null && !error) return <LoadingBlock label="Loading product" />
  return <>
    <div className="mb-3"><Link to="/" className="text-sm font-semibold text-custos-700 hover:underline">← Watchlist</Link></div>
    <PageHeader title={product?.title ?? asin} description={`${asin}${product?.brand ? ` · ${product.brand}` : ''}${product?.category ? ` · ${product.category}` : ''}`} />
    {error && <div className="mb-4"><ErrorBlock message={error} /></div>}{message && <div className="mb-4"><Notice>{message}</Notice></div>}
    <div className="mb-5 grid gap-3 sm:grid-cols-3"><div className="panel p-4"><div className="label">Current price</div><div className="text-2xl font-bold text-ink">{money(current?.buyBoxPrice ?? current?.lowestNewPrice)}</div></div><div className="panel p-4"><div className="label">Sales rank</div><div className="text-2xl font-bold text-ink">{integer(current?.salesRank)}</div></div><div className="panel p-4"><div className="label">Offers</div><div className="text-2xl font-bold text-ink">{integer(current?.offerCount)}</div></div></div>
    <div className="panel mb-6 p-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-ink">Price, rank & offer history</h2><p className="text-xs text-slate-500">Sales rank uses the right axis; lower rank appears higher.</p></div><div className="flex rounded-lg border bg-slate-50 p-1">{ranges.map(range => <button key={range.days} onClick={() => setDays(range.days)} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${days === range.days ? 'bg-white text-custos-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{range.label}</button>)}</div></div>{history === null ? <LoadingBlock label="Loading history" /> : <ProductChart history={history} />}</div>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.75fr)]"><form className="panel p-5" onSubmit={create}><h2 className="text-base font-bold text-ink">Quick-create alert</h2><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><label className="label" htmlFor="rule">Rule</label><select id="rule" className="input" value={ruleType} onChange={e => setRuleType(e.target.value as AlertRuleType)}>{rules.map(rule => <option key={rule.value} value={rule.value}>{rule.label}</option>)}</select></div>{needsThreshold(ruleType) && <div><label className="label" htmlFor="threshold">Threshold {ruleType === 'drop_percent' ? '(%)' : ruleType === 'price_below' ? '($)' : ''}</label><input id="threshold" className="input" type="number" min="0" step={ruleType === 'rank_below' ? '1' : '.01'} value={threshold} onChange={e => setThreshold(e.target.value)} /></div>}</div><button className="btn-primary mt-4">Create alert</button></form><div className="panel p-5"><h2 className="text-base font-bold text-ink">Alerts for this ASIN</h2><div className="mt-3 space-y-2">{alerts.length ? alerts.map(alert => <div key={alert.id} className="flex items-center justify-between rounded-lg border p-3"><span>{summary(alert)}</span><span className={`rounded-full px-2 py-1 text-xs font-bold ${alert.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{alert.isActive ? 'Active' : 'Paused'}</span></div>) : <p className="text-sm text-slate-500">No alerts yet.</p>}</div></div></div>
  </>
}

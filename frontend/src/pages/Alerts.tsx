import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { EmptyState, ErrorBlock, integer, LoadingBlock, localDate, money, PageHeader, Toggle } from '../components/UI'
import type { Alert, AlertEvent, Product } from '../types'

function ruleSummary(alert: Alert) { switch (alert.ruleType) { case 'price_below': return `Price ≤ ${money(alert.threshold)}`; case 'drop_percent': return `Price drop ≥ ${alert.threshold}% over ${alert.windowHours}h`; case 'rank_below': return `Sales rank ≤ ${integer(alert.threshold)}`; case 'back_in_stock': return 'Back in stock'; case 'buybox_change': return 'Buy Box price changes' } }

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => { setError(''); try { const [a, e, p] = await Promise.all([api.alerts(), api.alertEvents(), api.products()]); setAlerts(a); setEvents(e); setProducts(p) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } }, [])
  useEffect(() => { void load() }, [load])
  const titles = useMemo(() => Object.fromEntries(products.map(p => [p.asin, p.title ?? p.asin])), [products])
  async function toggle(alert: Alert, active: boolean) { await api.patchAlert(alert.id, { isActive: active }); await load() }
  async function remove(id: number) { if (!window.confirm('Delete this alert rule?')) return; await api.deleteAlert(id); await load() }
  async function mark(ids: number[]) { if (!ids.length) return; await api.markEventsRead(ids); await load() }
  return <><PageHeader title="Alerts" description="Manage monitoring rules and review every triggered event." />{error && <div className="mb-4"><ErrorBlock message={error} retry={() => void load()} /></div>}
    <section className="panel mb-6 overflow-hidden"><div className="border-b px-5 py-4"><h2 className="font-bold text-ink">Rules</h2></div>{alerts === null ? <LoadingBlock label="Loading rules" /> : <div className="overflow-x-auto"><table className="min-w-full divide-y"><thead className="table-head"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">Rule</th><th className="px-4 py-3">Last fired</th><th className="px-4 py-3">Active</th><th className="px-4 py-3"></th></tr></thead><tbody className="divide-y">{alerts.map(alert => <tr key={alert.id}><td className="px-4 py-3"><Link className="font-semibold text-custos-700 hover:underline" to={`/p/${alert.asin}`}>{titles[alert.asin] ?? alert.asin}</Link><div className="font-mono text-xs text-slate-400">{alert.asin}</div></td><td className="px-4 py-3">{ruleSummary(alert)}</td><td className="px-4 py-3 text-slate-500">{localDate(alert.lastFiredAt)}</td><td className="px-4 py-3"><Toggle checked={alert.isActive} label={`Toggle ${alert.asin} alert`} onChange={value => void toggle(alert, value)} /></td><td className="px-4 py-3 text-right"><button className="text-xs font-semibold text-red-700" onClick={() => void remove(alert.id)}>Delete</button></td></tr>)}</tbody></table>{alerts.length === 0 && <EmptyState title="No alert rules" detail="Create one from a product chart." />}</div>}</section>
    <section className="panel overflow-hidden"><div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="font-bold text-ink">Events inbox</h2><p className="text-xs text-slate-500">{events.filter(e => !e.isRead).length} unread</p></div><button className="btn-secondary" disabled={!events.some(e => !e.isRead)} onClick={() => void mark(events.filter(e => !e.isRead).map(e => e.id))}>Mark all read</button></div><div className="divide-y">{events.map(event => <div key={event.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${event.isRead ? 'bg-white' : 'bg-custos-50/70'}`}><div className={`h-2 w-2 shrink-0 rounded-full ${event.isRead ? 'bg-slate-200' : 'bg-custos-500'}`} /><div className="min-w-0 flex-1"><div className="font-medium text-ink">{event.message}</div><div className="mt-1 text-xs text-slate-500"><Link to={`/p/${event.asin}`} className="font-mono hover:underline">{event.asin}</Link> · {localDate(event.ts)} · {event.delivered ? 'Notification delivered' : event.deliveryError ?? 'Web inbox only'}</div></div>{!event.isRead && <button className="btn-secondary" onClick={() => void mark([event.id])}>Mark read</button>}</div>)}{events.length === 0 && <EmptyState title="Inbox is clear" detail="Triggered alerts will appear here." />}</div></section>
  </>
}

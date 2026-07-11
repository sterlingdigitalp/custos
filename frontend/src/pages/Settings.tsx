import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { ErrorBlock, LoadingBlock, localDate, Notice, PageHeader } from '../components/UI'
import type { Settings, Status } from '../types'

const textKeys = ['lwaClientId', 'lwaClientSecret', 'refreshToken', 'marketplaceId', 'region', 'ntfyTopic', 'ntfyServer'] as const

export default function SettingsPage() {
  const [original, setOriginal] = useState<Settings | null>(null)
  const [form, setForm] = useState<Settings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(async () => { setError(''); try { const [settings, state] = await Promise.all([api.settings(), api.status()]); setOriginal(settings); setForm(settings); setStatus(state) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }, [])
  useEffect(() => { void load() }, [load])
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setForm(current => current ? { ...current, [key]: value } : current) }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!form || !original) return
    const changes: Partial<Omit<Settings, 'id'>> = {}
    for (const key of textKeys) if (form[key] !== original[key]) Object.assign(changes, { [key]: form[key] === '' ? null : form[key] })
    if (form.sweepIntervalMin !== original.sweepIntervalMin) changes.sweepIntervalMin = form.sweepIntervalMin
    setBusy(true); setError(''); setMessage('')
    try { const saved = await api.patchSettings(changes); setOriginal(saved); setForm(saved); setMessage(Object.keys(changes).length ? 'Settings saved.' : 'No changes to save.'); window.dispatchEvent(new Event('custos:refresh-status')); setStatus(await api.status()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function testNotification() { setBusy(true); setError(''); setMessage(''); try { await api.testNotification(); setMessage('Test notification sent.') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  if (!form && !error) return <LoadingBlock label="Loading settings" />
  const statusLabel = !status ? 'STATUS UNKNOWN' : status.clientMode === 'mock' ? 'MOCK DATA' : status.client.ok ? 'LIVE' : 'LIVE · AUTH FAILING'
  const statusTone = !status || (status.clientMode === 'live' && !status.client.ok) ? 'bg-metric-down/10 text-metric-down' : status.clientMode === 'live' ? 'bg-accent/10 text-accent' : 'bg-base text-text-secondary'
  return <><PageHeader title="Settings" description="Configure your isolated SP-API client, sweep cadence, and notification delivery." />{message && <div className="mb-4"><Notice>{message}</Notice></div>}{error && <div className="mb-4"><ErrorBlock message={error} retry={() => void load()} /></div>}
    {form && <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]"><form className="panel p-5" onSubmit={save}><h2 className="text-base font-bold text-text-primary">Connection & notifications</h2><p className="mt-1 text-xs text-text-muted">Masked values are preserved unless you replace them. Custos credentials remain separate from Aurora.</p><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="LWA client ID" value={form.lwaClientId ?? ''} onChange={v => update('lwaClientId', v)} /><Field label="LWA client secret" type="password" value={form.lwaClientSecret ?? ''} onChange={v => update('lwaClientSecret', v)} /><div className="sm:col-span-2"><Field label="Refresh token" type="password" value={form.refreshToken ?? ''} onChange={v => update('refreshToken', v)} /></div><Field label="Marketplace ID" value={form.marketplaceId} onChange={v => update('marketplaceId', v)} /><Field label="Region" value={form.region} onChange={v => update('region', v)} /><Field label="Sweep interval (minutes)" type="number" value={String(form.sweepIntervalMin)} onChange={v => update('sweepIntervalMin', Number(v))} min="15" /><Field label="ntfy topic" value={form.ntfyTopic ?? ''} onChange={v => update('ntfyTopic', v)} /><div className="sm:col-span-2"><Field label="ntfy server" value={form.ntfyServer} onChange={v => update('ntfyServer', v)} /></div></div><div className="mt-5 flex flex-wrap gap-3"><button className="btn-primary" disabled={busy}>Save settings</button><button type="button" className="btn-secondary" disabled={busy || !form.ntfyTopic} onClick={() => void testNotification()}>Send test notification</button></div></form>
      <aside className="panel p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold text-text-primary">System status</h2><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${statusTone}`}>{statusLabel}</span></div><dl className="mt-5 space-y-4"><StatusRow term="Client ping" value={status ? `${status.client.ok ? 'Connected' : 'Unavailable'} · ${status.client.detail}` : '—'} danger={Boolean(status && !status.client.ok)} /><StatusRow term="Corpus size" value={String(status?.corpusSize ?? '—')} /><StatusRow term="Last sweep" value={localDate(status?.scheduler.lastSummary?.ts)} /><StatusRow term="Last summary" value={status?.scheduler.lastSummary ? `${status.scheduler.lastSummary.fetched}/${status.scheduler.lastSummary.asins} fetched · ${status.scheduler.lastSummary.alertsFired} alerts` : 'No completed sweep'} /><StatusRow term="Next sweep" value={localDate(status?.scheduler.nextRunAt)} />{status?.scheduler.lastError && <StatusRow term="Scheduler error" value={status.scheduler.lastError} danger />}</dl></aside></div>}
  </>
}

function Field({ label, value, onChange, type = 'text', min }: { label: string; value: string; onChange: (value: string) => void; type?: string; min?: string }) { const id = label.toLowerCase().replace(/\W+/g, '-'); return <div><label className="label" htmlFor={id}>{label}</label><input id={id} className="input" type={type} min={min} value={value} onChange={e => onChange(e.target.value)} /></div> }
function StatusRow({ term, value, danger = false }: { term: string; value: string; danger?: boolean }) { return <div><dt className="label">{term}</dt><dd className={`break-words text-sm ${danger ? 'text-metric-down' : 'text-text-primary'}`}>{value}</dd></div> }

import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../api'
import type { Status } from '../types'

const navItems = [
  { to: '/', label: 'Watchlist', mark: 'W', end: true },
  { to: '/alerts', label: 'Alerts', mark: 'A' },
  { to: '/finder', label: 'Finder', mark: 'F' },
  { to: '/seed', label: 'Seed', mark: 'S' },
  { to: '/import', label: 'Import', mark: 'I' },
  { to: '/settings', label: 'Settings', mark: '⚙' },
]

export default function Layout() {
  const [status, setStatus] = useState<Status | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const loadStatus = useCallback(() => { void api.status().then(setStatus).catch(() => setStatus(null)) }, [])
  useEffect(() => {
    loadStatus()
    const listener = () => loadStatus()
    window.addEventListener('custos:refresh-status', listener)
    const timer = window.setInterval(loadStatus, 30_000)
    return () => { window.removeEventListener('custos:refresh-status', listener); window.clearInterval(timer) }
  }, [loadStatus])

  const statusLabel = !status ? 'STATUS UNKNOWN' : status.clientMode === 'mock' ? 'MOCK DATA' : status.client.ok ? 'LIVE' : 'LIVE · AUTH FAILING'
  const statusTone = !status || (status.clientMode === 'live' && !status.client.ok) ? 'bg-metric-down/10 text-metric-down' : status.clientMode === 'live' ? 'bg-accent/10 text-accent' : 'bg-surface text-text-secondary'
  const statusDot = !status || (status.clientMode === 'live' && !status.client.ok) ? 'bg-metric-down' : status.clientMode === 'live' ? 'bg-accent' : 'bg-text-secondary'
  return <div className="min-h-screen bg-base">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-sidebar text-text-secondary lg:flex">
      <div className="flex h-16 items-center border-b border-divider px-5"><div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent font-black text-base">C</div><div className="ml-3"><div className="font-bold tracking-wide text-text-primary">Custos</div><div className="text-[10px] uppercase tracking-[.18em] text-text-muted">Product intelligence</div></div></div>
      <nav className="flex-1 space-y-1 px-3 py-5" aria-label="Main navigation">{navItems.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `flex items-center gap-3 rounded-full px-3 py-2.5 text-sm font-medium transition ${isActive ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-surface/60 hover:text-text-primary'}`}><span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${item.to === '/' ? 'bg-accent/10 text-accent' : 'bg-divider/60'}`}>{item.mark}</span>{item.label}</NavLink>)}</nav>
      <div className="border-t border-divider p-4 text-xs leading-relaxed text-text-muted">Self-hosted · Amazon US</div>
    </aside>
    <div className="lg:pl-60">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-divider bg-base/90 px-4 backdrop-blur sm:px-6 lg:px-8">
        <button type="button" onClick={() => setMenuOpen(!menuOpen)} className="rounded-full bg-surface p-2 text-text-secondary lg:hidden" aria-label="Toggle navigation">☰</button><div className="font-bold text-text-primary lg:hidden">Custos</div>
        <div className="ml-auto flex items-center gap-3">{status?.scheduler.sweepRunning && <span className="hidden text-xs font-medium text-text-secondary sm:inline">Sweep running…</span>}<div data-testid="status-banner" title={status?.client.detail} className="flex items-center gap-3"><div data-testid="mode-banner" className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${statusTone}`}><span className={`h-2 w-2 rounded-full ${statusDot}`} />{statusLabel}</div>{status?.clientMode === 'live' && !status.client.ok && <span className="hidden max-w-80 truncate text-xs text-metric-down xl:block">{status.client.detail}</span>}</div></div>
      </header>
      {menuOpen && <nav className="border-b border-divider bg-sidebar p-3 lg:hidden" aria-label="Mobile navigation"><div className="grid grid-cols-2 gap-1 sm:grid-cols-6">{navItems.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMenuOpen(false)} className={({ isActive }) => `rounded-full px-3 py-2 text-sm ${isActive ? 'bg-surface text-text-primary' : 'text-text-secondary'}`}>{item.label}</NavLink>)}</div></nav>}
      <main className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8"><Outlet /></main>
    </div>
  </div>
}

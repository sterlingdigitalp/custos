import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../api'
import type { Status } from '../types'

const navItems = [
  { to: '/', label: 'Watchlist', mark: 'W', end: true },
  { to: '/alerts', label: 'Alerts', mark: 'A' },
  { to: '/finder', label: 'Finder', mark: 'F' },
  { to: '/seed', label: 'Seed', mark: 'S' },
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

  const live = status?.clientMode === 'live'
  return <div className="min-h-screen bg-slate-50">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-slate-950 text-slate-300 lg:flex">
      <div className="flex h-16 items-center border-b border-white/10 px-5"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-custos-500 font-black text-white">C</div><div className="ml-3"><div className="font-bold tracking-wide text-white">Custos</div><div className="text-[10px] uppercase tracking-[.18em] text-slate-500">Product intelligence</div></div></div>
      <nav className="flex-1 space-y-1 px-3 py-5" aria-label="Main navigation">{navItems.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}><span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/5 text-xs font-bold">{item.mark}</span>{item.label}</NavLink>)}</nav>
      <div className="border-t border-white/10 p-4 text-xs leading-relaxed text-slate-500">Self-hosted · Amazon US</div>
    </aside>
    <div className="lg:pl-60">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
        <button type="button" onClick={() => setMenuOpen(!menuOpen)} className="rounded-md border p-2 text-slate-600 lg:hidden" aria-label="Toggle navigation">☰</button><div className="font-bold text-ink lg:hidden">Custos</div>
        <div className="ml-auto flex items-center gap-3">{status?.scheduler.sweepRunning && <span className="hidden text-xs font-medium text-slate-500 sm:inline">Sweep running…</span>}<div data-testid="mode-banner" title={status?.client.detail} className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset ${status ? (live ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/25' : 'bg-slate-100 text-slate-700 ring-slate-500/20') : 'bg-red-50 text-red-800 ring-red-500/20'}`}><span className={`h-2 w-2 rounded-full ${status ? (live ? 'bg-emerald-500' : 'bg-slate-500') : 'bg-red-500'}`} />{status ? (live ? 'LIVE' : 'MOCK DATA') : 'STATUS UNKNOWN'}</div></div>
      </header>
      {menuOpen && <nav className="border-b bg-slate-950 p-3 text-white lg:hidden" aria-label="Mobile navigation"><div className="grid grid-cols-2 gap-1 sm:grid-cols-5">{navItems.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMenuOpen(false)} className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? 'bg-white/15' : 'text-slate-300'}`}>{item.label}</NavLink>)}</div></nav>}
      <main className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8"><Outlet /></main>
    </div>
  </div>
}

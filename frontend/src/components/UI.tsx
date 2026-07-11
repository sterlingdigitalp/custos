import type { ReactNode } from 'react'

export function money(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}
export function integer(value: number | null | undefined): string { return value == null ? '—' : new Intl.NumberFormat('en-US').format(value) }
export function percent(value: number | null | undefined): string { return value == null ? '—' : `${value.toFixed(1)}%` }
export function localDate(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : '—' }

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1><p className="mt-1 text-sm text-slate-500">{description}</p></div>{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}</div>
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition ${checked ? 'bg-custos-600' : 'bg-slate-300'} disabled:opacity-50`}><span className={`pointer-events-none h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} /></button>
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) { return <div className="panel flex min-h-48 items-center justify-center p-8 text-slate-500"><span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-custos-600" />{label}…</div> }
export function ErrorBlock({ message, retry }: { message: string; retry?: () => void }) { return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><div className="font-semibold">Something went wrong</div><div className="mt-1">{message}</div>{retry && <button type="button" className="mt-3 font-semibold underline" onClick={retry}>Try again</button>}</div> }
export function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="py-14 text-center"><div className="font-semibold text-slate-700">{title}</div><div className="mt-1 text-sm text-slate-500">{detail}</div></div> }
export function Notice({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'error' }) { return <div className={`rounded-lg px-3 py-2 text-sm ${tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{children}</div> }

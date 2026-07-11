import type { Alert, AlertEvent, AlertRuleType, FinderFilters, FinderResult, Product, SeedQuery, SeedSearchResult, SellerampImportPreview, SellerampImportSummary, Settings, Snapshot, Status, SweepSummary } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  const payload = response.status === 204 ? null : await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new ApiError(payload?.error ?? `Request failed (${response.status})`, response.status)
  return payload as T
}

export const api = {
  products: () => request<Product[]>('/api/products'),
  addProducts: (asins: string[]) => request<{ added: number; skipped: number; products: Product[] }>('/api/products', { method: 'POST', body: JSON.stringify({ asins }) }),
  archiveProduct: (id: number) => request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify({ isArchived: true }) }),
  history: (asin: string, days: number) => request<Snapshot[]>(`/api/products/${encodeURIComponent(asin)}/history?days=${days}`),
  alerts: () => request<Alert[]>('/api/alerts'),
  createAlert: (body: { asin: string; ruleType: AlertRuleType; threshold?: number; windowHours?: number }) => request<Alert>('/api/alerts', { method: 'POST', body: JSON.stringify(body) }),
  patchAlert: (id: number, body: Partial<Pick<Alert, 'isActive' | 'threshold' | 'windowHours' | 'cooldownHours'>>) => request<Alert>(`/api/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAlert: (id: number) => request<void>(`/api/alerts/${id}`, { method: 'DELETE' }),
  alertEvents: () => request<AlertEvent[]>('/api/alert-events'),
  markEventsRead: (ids: number[]) => request<{ marked: number }>('/api/alert-events/mark-read', { method: 'POST', body: JSON.stringify({ ids }) }),
  finder: (body: FinderFilters) => request<FinderResult[]>('/api/finder', { method: 'POST', body: JSON.stringify(body) }),
  seedSearch: (query: string) => request<SeedSearchResult>('/api/seed/search', { method: 'POST', body: JSON.stringify({ query }) }),
  seedAdd: (asins: string[]) => request<{ added: number; skipped: number; products: Product[] }>('/api/seed/add', { method: 'POST', body: JSON.stringify({ asins }) }),
  seedQueries: () => request<SeedQuery[]>('/api/seed-queries'),
  createSeedQuery: (query: string) => request<SeedQuery>('/api/seed-queries', { method: 'POST', body: JSON.stringify({ query }) }),
  patchSeedQuery: (id: number, body: Partial<Pick<SeedQuery, 'query' | 'lastRunAt'>>) => request<SeedQuery>(`/api/seed-queries/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  previewSelleramp: (csv: string) => request<SellerampImportPreview>('/api/import/selleramp/preview', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv }),
  importSelleramp: (csv: string) => request<SellerampImportSummary>('/api/import/selleramp', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv }),
  settings: () => request<Settings>('/api/settings'),
  patchSettings: (body: Partial<Omit<Settings, 'id'>>) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),
  testNotification: () => request<{ ok: boolean }>('/api/settings/test-notification', { method: 'POST' }),
  status: () => request<Status>('/api/status'),
  runSweep: () => request<SweepSummary>('/api/sweep/run', { method: 'POST' }),
}

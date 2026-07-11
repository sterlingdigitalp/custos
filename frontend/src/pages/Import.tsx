import { useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api'
import { ErrorBlock, PageHeader } from '../components/UI'
import type { SellerampImportPreview, SellerampImportSummary } from '../types'

export default function Import() {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<SellerampImportPreview | null>(null)
  const [summary, setSummary] = useState<SellerampImportSummary | null>(null)

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    setCsv('')
    setFileName(file?.name ?? '')
    setPreview(null)
    setSummary(null)
    setError('')
    if (!file) return

    setReading(true)
    const reader = new FileReader()
    reader.onload = () => {
      setReading(false)
      if (typeof reader.result === 'string') setCsv(reader.result)
      else setError('The selected file could not be read as text.')
    }
    reader.onerror = () => {
      setReading(false)
      setError('The selected file could not be read.')
    }
    reader.readAsText(file)
  }

  async function runPreview() {
    if (csv === '') return
    setBusy('preview')
    setError('')
    setSummary(null)
    try {
      setPreview(await api.previewSelleramp(csv))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function applyImport() {
    if (csv === '' || !preview) return
    setBusy('import')
    setError('')
    try {
      const result = await api.importSelleramp(csv)
      setSummary(result)
      setPreview(null)
      window.dispatchEvent(new Event('custos:refresh-status'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return <>
    <PageHeader title="Import from SellerAmp" description="Preview and add products from a SellerAmp history CSV export." />

    <div className="mb-5 rounded-2xl bg-surface p-4 text-sm leading-relaxed text-text-secondary">
      <strong>Re-importing is safe.</strong> Products are matched by ASIN, so repeat imports do not create duplicates. New products become actively tracked, and existing catalog metadata is never overwritten; only missing titles or images are filled.
    </div>

    {error && <div className="mb-5"><ErrorBlock message={error} /></div>}

    <section className="panel overflow-hidden">
      <div className="border-b border-divider px-5 py-4"><h2 className="font-semibold text-text-primary">SellerAmp history export</h2><p className="mt-1 text-xs text-text-muted">Invalid ASIN rows are skipped. Dates in the export are not imported.</p></div>
      <div className="p-5">
        <label className="block"><span className="label">CSV file</span><input className="input cursor-pointer file:mr-4 file:rounded-full file:border-0 file:bg-divider file:px-3 file:py-1 file:text-xs file:font-semibold file:text-text-primary" type="file" accept=".csv,text/csv,text/plain" onChange={selectFile} /></label>
        <div className="mt-2 min-h-5 text-xs text-text-muted">{reading ? 'Reading file…' : csv !== '' ? `${fileName} is ready to preview.` : 'Choose the history CSV exported from SellerAmp.'}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-3 border-t border-divider pt-5"><button className="btn-secondary" type="button" disabled={csv === '' || reading || busy !== null} onClick={() => void runPreview()}>{busy === 'preview' ? 'Previewing…' : 'Preview'}</button><button className="btn-primary" type="button" disabled={!preview || busy !== null} onClick={() => void applyImport()}>{busy === 'import' ? 'Importing…' : 'Import products'}</button></div>
      </div>
    </section>

    {preview && <section className="panel mt-6 overflow-hidden" aria-live="polite"><div className="border-b border-divider bg-accent/5 px-5 py-4"><h2 className="font-semibold text-accent">Import preview</h2></div><div className="grid grid-cols-3 divide-x divide-divider border-b border-divider"><Count value={preview.newCount} label="New products" /><Count value={preview.alreadyPresent} label="Already tracked" /><Count value={preview.skippedInvalid} label="Invalid rows" /></div><div className="p-5"><h3 className="text-sm font-semibold text-text-primary">Sample of new products</h3>{preview.sampleNew.length > 0 ? <ul className="mt-3 divide-y divide-divider rounded-xl bg-base/50">{preview.sampleNew.map(row => <li key={row.asin} className="flex gap-4 px-4 py-3 text-sm"><span className="shrink-0 font-mono text-xs text-text-muted">{row.asin}</span><span className="text-text-secondary">{row.name || 'Untitled product'}</span></li>)}</ul> : <p className="mt-2 text-sm text-text-muted">No new products in this file.</p>}</div></section>}

    {summary && <section className="panel mt-6 overflow-hidden" aria-live="polite"><div className="border-b border-divider bg-accent/5 px-5 py-4"><h2 className="font-semibold text-accent">Import complete</h2></div>{summary.warning && <div className="border-b border-divider bg-metric-down/10 px-5 py-3 text-sm text-metric-down">{summary.warning}</div>}<div className="grid grid-cols-2 divide-x divide-y divide-divider sm:grid-cols-5 sm:divide-y-0"><Count value={summary.imported} label="New products" /><Count value={summary.updatedMetadata} label="Metadata filled" /><Count value={summary.alreadyPresent} label="Already tracked" /><Count value={summary.skippedInvalid} label="Invalid rows" /><Count value={summary.totalTracked} label="Actively tracked" /></div><div className="border-t border-divider px-5 py-4 text-right"><Link className="text-sm font-semibold text-accent hover:text-text-primary" to="/">View watchlist →</Link></div></section>}
  </>
}

function Count({ value, label }: { value: number; label: string }) {
  return <div className="p-5 text-center"><div className="text-2xl font-bold tabular-nums text-text-primary">{value}</div><div className="mt-1 text-xs font-medium text-text-secondary">{label}</div></div>
}

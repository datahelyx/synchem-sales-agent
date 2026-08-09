import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { Badge, ErrorNote, Loading, SectionTitle, Spinner, useApi, useToast } from '../ui';

interface ImportSummary {
  dryRun: boolean;
  filename: string;
  encoding: string;
  rowsRead: number;
  inserted: number;
  updated: number;
  skipped: number;
  warnings: Array<{ row: number; name: string; message: string }>;
  sample: Array<Record<string, unknown>>;
}

interface Batch {
  id: number; filename: string; encoding: string; rows_read: number;
  inserted: number; updated: number; skipped: number; created_at: string;
}

/**
 * Upload is two-step on purpose: preview first, commit second. Dropping 5,000
 * rows straight into a live pipeline with no idea what the parser made of them
 * is how bad data becomes permanent.
 */
export function ImportPage() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { data: batches, loading, error, refresh } = useApi<Batch[]>('/import/batches');

  async function analyse(f: File) {
    setFile(f);
    setPreview(null);
    setBusy(true);
    try {
      const res = await api.upload<ImportSummary>('/import/companies', f, { mode: 'preview' });
      setPreview(res);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read that file', 'error');
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api.upload<ImportSummary>('/import/companies', file, { mode: 'commit' });
      toast(`Imported — ${res.inserted.toLocaleString()} added, ${res.updated.toLocaleString()} updated`);
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Import companies</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Upload a CSV with <code className="rounded bg-slate-100 px-1 text-xs">Name, City, Phone, Email, Notes</code>.
          Re-uploading the same file updates existing companies instead of duplicating them.
        </p>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) analyse(f);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition ${
          dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white'
        }`}
      >
        <FileSpreadsheet size={30} className="mx-auto text-slate-400" />
        <p className="mt-2 text-sm font-medium text-slate-700">Drop your CSV here</p>
        <p className="text-xs text-slate-500">or</p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) analyse(f); }}
        />
        <button className="btn-ghost mt-2" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy && !preview ? <Spinner /> : <Upload size={15} />} Choose a file
        </button>
        {file && <p className="mt-2 text-xs text-slate-500">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
      </div>

      {preview && (
        <section className="card p-4">
          <SectionTitle title="Preview — nothing has been saved yet" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile label="Rows read" value={preview.rowsRead} />
            <Tile label="Will be added" value={preview.inserted} tone="text-emerald-700" />
            <Tile label="Will be updated" value={preview.updated} tone="text-sky-700" />
            <Tile label="Skipped" value={preview.skipped} tone={preview.skipped ? 'text-rose-700' : undefined} />
            <Tile label="Encoding" value={preview.encoding} />
          </div>

          {preview.encoding !== 'utf-8' && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs text-sky-900">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              This file is <strong>{preview.encoding}</strong>, not UTF-8. It was decoded correctly, so accented names
              like “Nestlé” stay intact instead of turning into question marks.
            </p>
          )}

          {preview.warnings.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-amber-800">
                <AlertTriangle size={15} /> {preview.warnings.length}
                {preview.warnings.length >= 200 ? '+' : ''} rows need attention
              </p>
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                {preview.warnings.slice(0, 100).map((w, i) => (
                  <li key={i}><span className="font-medium">Row {w.row}</span> · {w.name}: {w.message}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                These rows still import — the warnings tell you what could not be salvaged.
              </p>
            </div>
          )}

          {preview.sample.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <p className="mb-1.5 text-sm font-medium text-slate-700">First few rows, as they will be stored</p>
              <table className="w-full min-w-[42rem] text-left text-xs">
                <thead className="bg-slate-50 uppercase tracking-wide text-slate-500">
                  <tr>
                    {['action', 'name', 'area', 'phone_e164', 'industry', 'contact_name'].map((h) => (
                      <th key={h} className="px-2 py-1.5 font-medium">{h.replace('_', ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.sample.map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5">
                        <Badge tone={r.action === 'insert' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}>
                          {String(r.action)}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 font-medium text-slate-800">{String(r.name ?? '')}</td>
                      <td className="px-2 py-1.5 text-slate-600">{String(r.area ?? '—')}</td>
                      <td className="px-2 py-1.5 text-slate-600">{String(r.phone_e164 ?? '—')}</td>
                      <td className="px-2 py-1.5 text-slate-600">{String(r.industry ?? '—')}</td>
                      <td className="px-2 py-1.5 text-slate-600">{String(r.contact_name ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button className="btn-ghost" onClick={() => { setPreview(null); setFile(null); }}>Cancel</button>
            <button className="btn-primary" onClick={commit} disabled={busy}>
              {busy ? <Spinner /> : <Upload size={15} />}
              Import {preview.inserted.toLocaleString()} new and update {preview.updated.toLocaleString()}
            </button>
          </div>
        </section>
      )}

      <section className="card p-4">
        <SectionTitle title="Previous imports" />
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={error} onRetry={refresh} />
        ) : !batches?.length ? (
          <p className="py-6 text-center text-sm text-slate-400">No imports yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{b.filename}</span>
                <span className="text-xs text-slate-500">
                  {b.rows_read.toLocaleString()} rows · {b.inserted.toLocaleString()} added · {b.updated.toLocaleString()} updated
                </span>
                <Badge>{b.encoding}</Badge>
                <span className="text-xs text-slate-400">{relative(b.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, tone = 'text-slate-900' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

import { Boxes, FileText, Package, Plus, Save } from 'lucide-react';
import { useState } from 'react';
import { api, type Product } from '../lib/api';
import { dateOnly, money } from '../lib/format';
import { Badge, EmptyState, ErrorNote, Field, Loading, Modal, SectionTitle, Spinner, useApi, useToast } from '../ui';

type Tab = 'products' | 'samples' | 'invoices';

export function Catalog() {
  const [tab, setTab] = useState<Tab>('products');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Products &amp; orders</h1>
        <p className="mt-0.5 text-sm text-slate-500">The catalogue salesmen pick samples from, and what came out of it.</p>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(['products', 'samples', 'invoices'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition ${
              tab === t ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'products' && <Products />}
      {tab === 'samples' && <Samples />}
      {tab === 'invoices' && <Invoices />}
    </div>
  );
}

function Products() {
  const toast = useToast();
  const { data, loading, error, refresh } = useApi<Product[]>('/products');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;

  const byCategory = new Map<string, Product[]>();
  for (const p of data ?? []) {
    const key = p.category ?? 'Uncategorised';
    byCategory.set(key, [...(byCategory.get(key) ?? []), p]);
  }

  return (
    <>
      <div className="flex justify-between">
        <p className="text-sm text-slate-500">{data?.length ?? 0} products</p>
        <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add product</button>
      </div>

      {!data?.length ? (
        <EmptyState
          icon={<Package size={26} />}
          title="No products yet"
          body="Add the SKUs your salesmen can send as samples."
          action={<button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add product</button>}
        />
      ) : (
        <div className="space-y-4">
          {[...byCategory.entries()].map(([cat, items]) => (
            <section key={cat} className="card overflow-hidden">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Product</th>
                      <th className="px-4 py-2 font-medium">Pack</th>
                      <th className="px-4 py-2 text-right font-medium">Price</th>
                      <th className="px-4 py-2 text-right font-medium">In stock</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <span className="block font-medium text-slate-800">{p.name}</span>
                          <span className="block text-xs text-slate-400">{p.sku}</span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{p.pack_size ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{money(p.unit_price)}/{p.uom}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${p.stock_qty > 0 ? 'text-slate-700' : 'text-rose-600'}`}>
                          {p.stock_qty} {p.uom}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setEditing(p)}>Edit</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <ProductForm
        open={adding || editing !== null}
        product={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { refresh(); toast(editing ? 'Product updated' : 'Product added'); }}
      />
    </>
  );
}

function ProductForm({ open, product, onClose, onSaved }: { open: boolean; product: Product | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => blank(product));

  // Re-seed the form whenever a different product is opened.
  const [seedFor, setSeedFor] = useState<number | null>(product?.id ?? null);
  if (open && (product?.id ?? null) !== seedFor) {
    setSeedFor(product?.id ?? null);
    setForm(blank(product));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        sku: form.sku, name: form.name, category: form.category || null, pack_size: form.pack_size || null,
        uom: form.uom, unit_price: Number(form.unit_price) || 0, stock_qty: Number(form.stock_qty) || 0,
        sample_qty: Number(form.sample_qty) || 1,
      };
      if (product) await api.patch(`/products/${product.id}`, body);
      else await api.post('/products', body);
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={product ? 'Edit product' : 'Add product'}
      wide
      footer={
        <div className="flex gap-2">
          <button className="btn-ghost flex-1 sm:flex-none" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={saving || !form.sku || !form.name}>
            {saving ? <Spinner /> : <Save size={15} />} Save
          </button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SKU"><input className="input" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="SC-SOL-001" /></Field>
        <Field label="Category"><input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Solvents" /></Field>
        <div className="sm:col-span-2">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </div>
        <Field label="Pack size"><input className="input" value={form.pack_size} onChange={(e) => setForm({ ...form, pack_size: e.target.value })} placeholder="200 kg drum" /></Field>
        <Field label="Unit of measure">
          <select className="input" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })}>
            {['kg', 'litre', 'drum', 'bag', 'piece'].map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="Unit price (PKR)"><input className="input" inputMode="decimal" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} /></Field>
        <Field label="Stock on hand" hint="Changing this records a stock adjustment.">
          <input className="input" inputMode="decimal" value={form.stock_qty} onChange={(e) => setForm({ ...form, stock_qty: e.target.value })} />
        </Field>
        <Field label="Default sample quantity"><input className="input" inputMode="decimal" value={form.sample_qty} onChange={(e) => setForm({ ...form, sample_qty: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function blank(p: Product | null) {
  return {
    sku: p?.sku ?? '', name: p?.name ?? '', category: p?.category ?? '', pack_size: p?.pack_size ?? '',
    uom: p?.uom ?? 'kg', unit_price: String(p?.unit_price ?? ''), stock_qty: String(p?.stock_qty ?? ''),
    sample_qty: String(p?.sample_qty ?? 1),
  };
}

interface SampleRow {
  id: number; status: string; company_name: string; salesman_name: string; courier: string | null;
  tracking_ref: string | null; created_at: string;
  lines: Array<{ name: string; qty: number; uom: string; sku: string }>;
}

function Samples() {
  const toast = useToast();
  const { data, loading, error, refresh } = useApi<SampleRow[]>('/samples');

  async function setStatus(id: number, status: string) {
    try {
      await api.patch(`/samples/${id}`, { status });
      toast(`Marked ${status}`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update', 'error');
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!data?.length) return <EmptyState icon={<Boxes size={26} />} title="No sample requests" body="They appear here when a salesman logs a meeting where a sample was asked for." />;

  return (
    <ul className="space-y-2.5">
      {data.map((s) => (
        <li key={s.id} className="card flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">{s.company_name}</p>
            <p className="text-xs text-slate-500">Requested by {s.salesman_name} · {dateOnly(s.created_at)}</p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {s.lines.map((l, i) => <li key={i}><Badge>{l.name} · {l.qty} {l.uom}</Badge></li>)}
            </ul>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={s.status === 'delivered' ? 'bg-emerald-50 text-emerald-700' : s.status === 'dispatched' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'}>
              {s.status}
            </Badge>
            {s.status === 'draft' && <button className="btn-ghost" onClick={() => setStatus(s.id, 'dispatched')}>Mark dispatched</button>}
            {s.status === 'dispatched' && <button className="btn-ghost" onClick={() => setStatus(s.id, 'delivered')}>Mark delivered</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

interface InvoiceRow {
  id: number; number: string; company_name: string; salesman_name: string; issue_date: string;
  due_date: string | null; subtotal: number; total: number; status: string;
  lines: Array<{ id: number; description: string; qty: number; unit_price: number; amount: number }>;
}

function Invoices() {
  const toast = useToast();
  const { data, loading, error, refresh } = useApi<InvoiceRow[]>('/invoices');

  async function setStatus(id: number, status: string) {
    try {
      await api.patch(`/invoices/${id}`, { status });
      toast(`Invoice marked ${status}`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update', 'error');
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!data?.length) return <EmptyState icon={<FileText size={26} />} title="No invoices yet" body="An invoice is generated automatically when a meeting outcome is set to Approved." />;

  const live = data.filter((i) => i.status !== 'cancelled');
  const outstanding = live.reduce((s, i) => s + i.total, 0);
  const cancelled = data.length - live.length;

  return (
    <>
      <SectionTitle
        title={
          `${data.length} invoice${data.length === 1 ? '' : 's'} · ${money(outstanding)}` +
          (cancelled ? ` (excludes ${cancelled} cancelled)` : '')
        }
      />
      <ul className="space-y-2.5">
        {data.map((i) => (
          <li key={i.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">{i.number} · {i.company_name}</p>
                <p className="text-xs text-slate-500">
                  Issued {dateOnly(i.issue_date)}{i.due_date ? ` · due ${dateOnly(i.due_date)}` : ''} · {i.salesman_name}
                </p>
              </div>
              <span className="text-base font-semibold tabular-nums text-slate-900">{money(i.total)}</span>
              <Badge tone={i.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : i.status === 'cancelled' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700'}>
                {i.status}
              </Badge>
              {i.status === 'draft' && <button className="btn-ghost" onClick={() => setStatus(i.id, 'sent')}>Mark sent</button>}
              {i.status === 'sent' && <button className="btn-ghost" onClick={() => setStatus(i.id, 'paid')}>Mark paid</button>}
            </div>
            {i.lines.length > 0 && (
              <ul className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
                {i.lines.map((l) => (
                  <li key={l.id} className="flex justify-between py-0.5">
                    <span>{l.description} × {l.qty}</span>
                    <span className="tabular-nums">{money(l.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

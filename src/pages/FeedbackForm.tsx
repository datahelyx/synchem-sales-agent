import { Check, PackageSearch, Save, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Feedback, type Product, type ReasonCode } from '../lib/api';
import { money, OUTCOME_META } from '../lib/format';
import { ChoiceGroup, Field, Loading, Modal, Spinner, useApi, useToast } from '../ui';

type Outcome = 'positive' | 'approved' | 'rejected';
interface Line { productId: number; qty: number }

/**
 * Post-meeting feedback. One screen, guided top to bottom, and it doubles as
 * the edit form — the brief is explicit that nothing locks after first entry,
 * so re-opening a logged meeting loads the saved answers straight back in.
 */
export function FeedbackForm({
  open, onClose, onDone, meetingId, companyName,
}: {
  open: boolean; onClose: () => void; onDone: () => void;
  meetingId: number | null; companyName: string;
}) {
  const toast = useToast();
  const { data: existing, loading } = useApi<Feedback | null>(open && meetingId ? `/feedback/${meetingId}` : null);
  const { data: reasons } = useApi<ReasonCode[]>(open ? '/reason-codes' : null);
  const { data: products } = useApi<Product[]>(open ? '/products' : null);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reasonNote, setReasonNote] = useState('');
  const [sampleRequested, setSampleRequested] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [dealValue, setDealValue] = useState('');
  const [nextStepOn, setNextStepOn] = useState('');
  const [metContact, setMetContact] = useState('');
  const [saving, setSaving] = useState(false);
  const [productQuery, setProductQuery] = useState('');

  // Load saved answers when editing; reset cleanly when opening a fresh one.
  useEffect(() => {
    if (!open) return;
    if (existing) {
      setOutcome(existing.outcome);
      setReasonCode(existing.reason_code);
      setReasonNote(existing.reason_note ?? '');
      setSampleRequested(Boolean(existing.sample_requested));
      setLines((existing.sampleLines ?? []).map((l) => ({ productId: l.productId, qty: l.qty })));
      setDealValue(existing.deal_value ? String(existing.deal_value) : '');
      setNextStepOn(existing.next_step_on ?? '');
      setMetContact(existing.met_contact ?? '');
    } else {
      setOutcome(null); setReasonCode(null); setReasonNote(''); setSampleRequested(false);
      setLines([]); setDealValue(''); setNextStepOn(''); setMetContact('');
    }
  }, [open, existing]);

  const reasonOptions = useMemo(() => (reasons ?? []).filter((r) => r.outcome === outcome), [reasons, outcome]);

  // Changing the outcome invalidates a reason that belonged to the old one.
  useEffect(() => {
    if (reasonCode && !reasonOptions.some((r) => r.code === reasonCode)) setReasonCode(null);
  }, [reasonOptions, reasonCode]);

  const productList = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    const all = products ?? [];
    if (!q) return all.slice(0, 40);
    return all.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)).slice(0, 40);
  }, [products, productQuery]);

  const productById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  function toggleProduct(p: Product) {
    setLines((ls) =>
      ls.some((l) => l.productId === p.id)
        ? ls.filter((l) => l.productId !== p.id)
        : [...ls, { productId: p.id, qty: p.sample_qty || 1 }],
    );
  }

  const valid = Boolean(outcome) && (outcome !== 'approved' || Number(dealValue) > 0);

  async function submit() {
    if (!meetingId || !outcome) return;
    setSaving(true);
    try {
      const res = await api.post<{ invoiceId: number | null; edited: boolean }>('/feedback', {
        meetingId,
        outcome,
        reasonCode,
        reasonNote: reasonNote || null,
        sampleRequested,
        sampleLines: sampleRequested ? lines : [],
        dealValue: outcome === 'approved' ? Number(dealValue) : null,
        nextStepOn: nextStepOn || null,
        metContact: metContact || null,
      });
      toast(
        res.invoiceId
          ? `Saved — deal closed and an invoice was generated`
          : res.edited
            ? 'Feedback updated'
            : 'Feedback saved',
      );
      onDone();
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
      wide
      title={existing ? `Edit outcome — ${companyName}` : `How did it go? — ${companyName}`}
      subtitle={
        existing
          ? `Last saved ${new Date(existing.updated_at.replace(' ', 'T') + 'Z').toLocaleString('en-PK')}. Anything here can be changed.`
          : 'Three quick questions.'
      }
      footer={
        <div className="flex gap-2">
          <button className="btn-ghost flex-1 sm:flex-none" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={!valid || saving} onClick={submit}>
            {saving ? <Spinner /> : <Save size={16} />}
            {existing ? 'Save changes' : 'Save outcome'}
          </button>
        </div>
      }
    >
      {loading ? (
        <Loading label="Loading" />
      ) : (
        <div className="space-y-6">
          <Field label="1. What was the outcome?">
            <ChoiceGroup<Outcome>
              value={outcome}
              onChange={setOutcome}
              options={(['positive', 'approved', 'rejected'] as Outcome[]).map((o) => ({
                value: o,
                label: OUTCOME_META[o].label,
                hint: OUTCOME_META[o].blurb,
                tone: `${OUTCOME_META[o].tone} border`,
              }))}
            />
          </Field>

          {outcome && (
            <>
              <Field label="2. Why?" hint="Pick the closest reason — this is what the dashboard groups by.">
                <div className="grid gap-2 sm:grid-cols-2">
                  {reasonOptions.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => setReasonCode(r.code)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                        reasonCode === r.code ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {reasonCode === r.code ? <Check size={14} className="shrink-0" /> : <span className="w-3.5" />}
                      {r.label}
                    </button>
                  ))}
                </div>
                <textarea
                  className="input mt-2"
                  rows={2}
                  placeholder="Anything else worth remembering (optional)"
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                />
              </Field>

              {outcome === 'approved' && (
                <Field label="Deal value (PKR)" hint="The invoice is generated from this number.">
                  <input
                    className="input"
                    inputMode="numeric"
                    value={dealValue}
                    onChange={(e) => setDealValue(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="250000"
                  />
                  {Number(dealValue) > 0 && <p className="hint">Invoice will be raised for {money(Number(dealValue))}.</p>}
                </Field>
              )}

              <Field label="3. Did they ask for a sample?">
                <ChoiceGroup
                  columns={2}
                  value={sampleRequested ? 'yes' : 'no'}
                  onChange={(v) => setSampleRequested(v === 'yes')}
                  options={[
                    { value: 'no', label: 'No sample needed' },
                    { value: 'yes', label: 'Yes — pick products' },
                  ]}
                />
              </Field>

              {sampleRequested && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="relative mb-2">
                    <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
                    <input
                      className="input pl-9"
                      placeholder="Search the catalogue…"
                      value={productQuery}
                      onChange={(e) => setProductQuery(e.target.value)}
                    />
                  </div>

                  {lines.length > 0 && (
                    <ul className="mb-3 space-y-1.5">
                      {lines.map((l) => {
                        const p = productById.get(l.productId);
                        if (!p) return null;
                        return (
                          <li key={l.productId} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-800">{p.name}</span>
                              <span className="block text-xs text-slate-500">{p.sku} · in stock {p.stock_qty} {p.uom}</span>
                            </span>
                            <input
                              className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                              inputMode="decimal"
                              value={l.qty}
                              onChange={(e) =>
                                setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, qty: Number(e.target.value) || 0 } : x)))
                              }
                            />
                            <span className="w-8 text-xs text-slate-500">{p.uom}</span>
                            <button
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              onClick={() => setLines((ls) => ls.filter((x) => x.productId !== l.productId))}
                              aria-label={`Remove ${p.name}`}
                            >
                              <Trash2 size={15} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                    {productList.length === 0 ? (
                      <p className="flex items-center gap-2 p-3 text-sm text-slate-500">
                        <PackageSearch size={15} /> No products match.
                      </p>
                    ) : (
                      productList.map((p) => {
                        const picked = lines.some((l) => l.productId === p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => toggleProduct(p)}
                            className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-slate-50 ${
                              picked ? 'bg-brand-50/60' : ''
                            }`}
                          >
                            <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${picked ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300'}`}>
                              {picked && <Check size={11} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-slate-800">{p.name}</span>
                              <span className="block text-xs text-slate-500">{p.category} · {p.sku}</span>
                            </span>
                            <span className={`text-xs ${p.stock_qty > 0 ? 'text-slate-500' : 'text-rose-600'}`}>
                              {p.stock_qty > 0 ? `${p.stock_qty} ${p.uom}` : 'out of stock'}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Follow up on" hint="The agent puts this company back on your list that day.">
                  <input type="date" className="input" value={nextStepOn} onChange={(e) => setNextStepOn(e.target.value)} />
                </Field>
                <Field label="Who did you actually meet?" hint="Optional — useful if it wasn't the listed contact.">
                  <input className="input" value={metContact} onChange={(e) => setMetContact(e.target.value)} placeholder="Name and designation" />
                </Field>
              </div>

              {existing?.invoice && (
                <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                  Invoice <span className="font-semibold">{existing.invoice.number}</span> — {money(existing.invoice.total)} ({existing.invoice.status}).
                  Changing the outcome away from Approved will cancel it.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

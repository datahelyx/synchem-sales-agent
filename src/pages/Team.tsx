import { Minus, Plus, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Salesman } from '../lib/api';
import { initials } from '../lib/format';
import { useSession } from '../session';
import { Badge, ErrorNote, Field, Loading, Modal, Spinner, useApi, useToast } from '../ui';

export function Team() {
  const toast = useToast();
  const { refreshPeople } = useSession();
  const { data, loading, error, refresh } = useApi<Salesman[]>('/salesmen');
  const [editing, setEditing] = useState<Salesman | null>(null);
  const [adding, setAdding] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Team</h1>
          <p className="mt-0.5 text-sm text-slate-500">Weekly quota decides how many companies the agent hands each person.</p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add person</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((p) => (
          <article key={p.id} className="card p-4">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                {initials(p.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{p.name}</p>
                <p className="text-xs capitalize text-slate-500">{p.role}</p>
              </div>
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setEditing(p)}>Edit</button>
            </div>

            {p.role === 'salesman' && (
              <>
                <QuotaControl person={p} onSaved={() => { refresh(); refreshPeople(); }} />
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <Metric label="This week" value={`${p.assigned_this_week ?? 0} / ${p.weekly_quota}`} />
                  <Metric label="Companies" value={String(p.companies_owned ?? 0)} />
                  <Metric label="Upcoming" value={String(p.upcoming_meetings ?? 0)} />
                  <Metric label="Deals won" value={String(p.deals_won ?? 0)} />
                </dl>
              </>
            )}

            {p.areas && (
              <div className="mt-3 flex flex-wrap gap-1">
                {p.areas.split(',').map((a) => <Badge key={a}>{a.trim()}</Badge>)}
              </div>
            )}
            {p.email && <p className="mt-2 truncate text-xs text-slate-400">{p.email}</p>}
          </article>
        ))}
      </div>

      <PersonForm
        open={adding || editing !== null}
        person={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { refresh(); refreshPeople(); toast(editing ? 'Updated' : 'Added'); }}
      />
    </div>
  );
}

/**
 * The manager's main lever: how many companies this person gets each week.
 * Inline stepper rather than buried in an edit dialog, because it is the one
 * setting they will actually reach for.
 */
function QuotaControl({ person, onSaved }: { person: Salesman; onSaved: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState(person.weekly_quota);

  // A stepper gets clicked fast. Reading React state inside the handler loses
  // every click that lands before the re-render, so the target is tracked in a
  // ref and the save is debounced into one request for the final number.
  const target = useRef(person.weekly_quota);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [seen, setSeen] = useState(person.weekly_quota);
  if (person.weekly_quota !== seen) {
    setSeen(person.weekly_quota);
    // Don't stomp on a change the user is mid-way through making.
    if (timer.current === null) {
      target.current = person.weekly_quota;
      setValue(person.weekly_quota);
    }
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function step(delta: number) {
    const next = Math.min(20, Math.max(1, target.current + delta));
    if (next === target.current) return;
    target.current = next;
    setValue(next);

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      const wanted = target.current;
      if (wanted === person.weekly_quota) return;
      try {
        await api.patch(`/salesmen/${person.id}`, { weekly_quota: wanted });
        toast(`${person.name.split(' ')[0]} now gets ${wanted} ${wanted === 1 ? 'company' : 'companies'} a week`);
        onSaved();
      } catch (e) {
        target.current = person.weekly_quota;
        setValue(person.weekly_quota);
        toast(e instanceof Error ? e.message : 'Could not update the quota', 'error');
      }
    }, 500);
  }

  const assigned = person.assigned_this_week ?? 0;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">Companies per week</span>
        <div className="flex items-center gap-1">
          <button
            className="grid h-7 w-7 place-items-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={() => step(-1)}
            disabled={value <= 1}
            aria-label={`Decrease ${person.name}'s weekly quota`}
          >
            <Minus size={13} />
          </button>
          <span className="w-7 text-center text-sm font-semibold tabular-nums text-slate-800">{value}</span>
          <button
            className="grid h-7 w-7 place-items-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={() => step(1)}
            disabled={value >= 20}
            aria-label={`Increase ${person.name}'s weekly quota`}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      {value > assigned && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {value - assigned} more can be handed out — run the agent to top up.
        </p>
      )}
      {value < assigned && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          Already has {assigned} this week; the lower quota applies from the next run.
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-1.5">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}

function PersonForm({ open, person, onClose, onSaved }: { open: boolean; person: Salesman | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [seedFor, setSeedFor] = useState<number | null>(person?.id ?? null);
  const [form, setForm] = useState(() => blank(person));

  if (open && (person?.id ?? null) !== seedFor) {
    setSeedFor(person?.id ?? null);
    setForm(blank(person));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
        role: form.role,
        weekly_quota: Number(form.weekly_quota) || 2,
        areas: form.areas || null,
      };
      if (person) await api.patch(`/salesmen/${person.id}`, body);
      else await api.post('/salesmen', body);
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
      title={person ? `Edit ${person.name}` : 'Add someone to the team'}
      footer={
        <div className="flex gap-2">
          <button className="btn-ghost flex-1 sm:flex-none" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={saving || !form.name}>
            {saving ? <Spinner /> : <Save size={15} />} Save
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="WhatsApp number" hint="The agent messages this number.">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" />
          </Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'salesman' | 'manager' })}>
              <option value="salesman">Salesman</option>
              <option value="manager">Sales manager</option>
            </select>
          </Field>
          <Field label="Companies per week" hint="The brief's default is 2.">
            <input className="input" inputMode="numeric" value={form.weekly_quota} onChange={(e) => setForm({ ...form, weekly_quota: e.target.value })} />
          </Field>
        </div>
        <Field label="Preferred areas" hint="Comma separated, e.g. Gulberg, Johar Town. Companies there get ranked higher for this person.">
          <input className="input" value={form.areas} onChange={(e) => setForm({ ...form, areas: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function blank(p: Salesman | null) {
  return {
    name: p?.name ?? '',
    email: p?.email ?? '',
    phone: p?.phone_e164 ?? '',
    role: (p?.role ?? 'salesman') as 'salesman' | 'manager',
    weekly_quota: String(p?.weekly_quota ?? 2),
    areas: p?.areas ?? '',
  };
}

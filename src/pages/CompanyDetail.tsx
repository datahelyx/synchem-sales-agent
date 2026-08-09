import { ArrowLeft, CalendarPlus, ClipboardCheck, MessageCircle, Pencil, Save, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { contactLabel, dateOnly, dateTime, money, phoneLabel, relative, STAGE_META } from '../lib/format';
import { useSession } from '../session';
import { Badge, ErrorNote, Field, Loading, Modal, SectionTitle, Spinner, useApi, useToast } from '../ui';
import { FeedbackForm } from './FeedbackForm';
import { ScheduleMeeting } from './ScheduleMeeting';

interface CompanyFull {
  id: number; name: string; area: string | null; phone: string | null; phone_e164: string | null;
  email: string | null; industry: string | null; contact_name: string | null; contact_title: string | null;
  notes: string | null; stage: string; owner_id: number | null; owner_name: string | null;
  times_assigned: number; last_assigned_on: string | null; follow_up_on: string | null;
  do_not_contact: number; data_quality: number;
  assignments: Array<{ id: number; week_start: string; status: string; reason: string | null; salesman_name: string }>;
  meetings: Array<{ id: number; scheduled_at: string; status: string; mode: string; salesman_name: string; outcome: string | null; reason_note: string | null; feedback_id: number | null }>;
  samples: Array<{ id: number; status: string; created_at: string; lines_json: string | null }>;
  invoices: Array<{ id: number; number: string; total: number; status: string; issue_date: string }>;
  timeline: Array<{ id: number; kind: string; summary: string; actor: string; created_at: string; salesman_name: string | null }>;
}

/** Everything ever done with one company — the brief's "historical per-company follow-up data". */
export function CompanyDetail() {
  const { id } = useParams();
  const { current } = useSession();
  const toast = useToast();
  const { data: c, loading, error, refresh } = useApi<CompanyFull>(id ? `/companies/${id}` : null);

  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [feedbackMeeting, setFeedbackMeeting] = useState<number | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!c) return null;

  const stage = STAGE_META[c.stage] ?? STAGE_META.new;
  const waText = `Assalam-o-Alaikum ${contactLabel(c.contact_title, c.contact_name)}, I'm reaching out from SynChem regarding ${c.name}.`;
  const waUrl = c.phone_e164 ? `https://wa.me/${c.phone_e164.replace('+', '')}?text=${encodeURIComponent(waText)}` : null;

  async function saveNote() {
    if (!note.trim() || !id) return;
    await api.post(`/companies/${id}/notes`, { text: note.trim(), actorId: current?.id });
    setNote(''); setNoteOpen(false); toast('Note added'); refresh();
  }

  return (
    <div className="space-y-5">
      <Link to="/companies" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft size={15} /> All companies
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-900">{c.name}</h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={stage.tone}>{stage.label}</Badge>
              {c.industry && <Badge>{c.industry}</Badge>}
              {c.area && <Badge>{c.area}</Badge>}
              {c.do_not_contact === 1 && <Badge tone="bg-rose-50 text-rose-700">Do not contact</Badge>}
            </div>
            <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <Pair label="Contact" value={contactLabel(c.contact_title, c.contact_name)} />
              <Pair label="Phone" value={c.phone_e164 ? <a className="text-brand-700 hover:underline" href={`tel:${c.phone_e164}`}>{phoneLabel(c.phone_e164, c.phone)}</a> : <span className="text-amber-700">none on file</span>} />
              <Pair label="Email" value={c.email ? <a className="text-brand-700 hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '—'} />
              <Pair label="Owner" value={c.owner_name ?? 'Unassigned'} />
              <Pair label="Times assigned" value={String(c.times_assigned)} />
              <Pair label="Follow up on" value={c.follow_up_on ? dateOnly(c.follow_up_on) : '—'} />
            </dl>
            {c.notes && <p className="mt-3 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">{c.notes}</p>}
          </div>

          <div className="flex flex-wrap gap-2">
            {waUrl && <a href={waUrl} target="_blank" rel="noreferrer" className="btn-ghost"><MessageCircle size={15} /> WhatsApp</a>}
            <button className="btn-ghost" onClick={() => setNoteOpen(true)}><StickyNote size={15} /> Note</button>
            <button className="btn-ghost" onClick={() => setEditing(true)}><Pencil size={15} /> Edit</button>
            <button className="btn-primary" onClick={() => setScheduling(true)}><CalendarPlus size={15} /> Book meeting</button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="card p-4">
            <SectionTitle title="Meetings" />
            {c.meetings.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No meetings yet.</p>
            ) : (
              <ul className="space-y-2">
                {c.meetings.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-800">{dateTime(m.scheduled_at)}</span>
                      <span className="block text-xs text-slate-500">
                        {m.mode} · {m.salesman_name} · {m.status}
                        {m.reason_note ? ` · ${m.reason_note}` : ''}
                      </span>
                    </span>
                    {m.outcome && (
                      <Badge tone={m.outcome === 'approved' ? 'bg-emerald-50 text-emerald-700' : m.outcome === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-marine-50 text-marine-800'}>
                        {m.outcome}
                      </Badge>
                    )}
                    <button className="btn-subtle" onClick={() => setFeedbackMeeting(m.id)}>
                      <ClipboardCheck size={14} /> {m.outcome ? 'Edit outcome' : 'Log outcome'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <SectionTitle title="Timeline" />
            {c.timeline.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">Nothing recorded yet.</p>
            ) : (
              <ol className="space-y-3">
                {c.timeline.map((t) => (
                  <li key={t.id} className="flex gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-slate-700">{t.summary}</span>
                      <span className="block text-xs text-slate-400">
                        {t.actor}{t.salesman_name ? ` · ${t.salesman_name}` : ''} · {relative(t.created_at)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="card p-4">
            <SectionTitle title="Assignments" />
            {c.assignments.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">Never assigned.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {c.assignments.map((a) => (
                  <li key={a.id} className="rounded-lg border border-slate-200 p-2.5">
                    <p className="font-medium text-slate-700">Week of {dateOnly(a.week_start)}</p>
                    <p className="text-xs text-slate-500">{a.salesman_name} · {a.status}</p>
                    {a.reason && <p className="mt-1 text-xs text-slate-400">{a.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <SectionTitle title="Samples" />
            {c.samples.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">None sent.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {c.samples.map((s) => {
                  const lines = safeParse(s.lines_json);
                  return (
                    <li key={s.id} className="rounded-lg border border-slate-200 p-2.5">
                      <p className="font-medium text-slate-700">{s.status}</p>
                      <ul className="mt-1 text-xs text-slate-500">
                        {lines.map((l, i) => <li key={i}>{l.product} — {l.qty} {l.uom}</li>)}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <SectionTitle title="Invoices" />
            {c.invoices.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">None raised.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {c.invoices.map((i) => (
                  <li key={i.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-2.5">
                    <span>
                      <span className="block font-medium text-slate-700">{i.number}</span>
                      <span className="block text-xs text-slate-500">{dateOnly(i.issue_date)} · {i.status}</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-800">{money(i.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <EditCompany open={editing} onClose={() => setEditing(false)} company={c} onSaved={refresh} />

      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Add a note"
        footer={<button className="btn-primary w-full" onClick={saveNote} disabled={!note.trim()}><Save size={15} /> Save note</button>}
      >
        <textarea className="input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
      </Modal>

      {scheduling && current && (
        <ScheduleMeeting
          open
          onClose={() => setScheduling(false)}
          onDone={refresh}
          salesmanId={current.id}
          company={{
            company_id: c.id, company_name: c.name, area: c.area,
            contact_name: c.contact_name, contact_title: c.contact_title,
            phone_e164: c.phone_e164, email: c.email, assignment_id: null,
          }}
        />
      )}

      <FeedbackForm
        open={feedbackMeeting !== null}
        onClose={() => setFeedbackMeeting(null)}
        onDone={refresh}
        meetingId={feedbackMeeting}
        companyName={c.name}
      />
    </div>
  );
}

function EditCompany({ open, onClose, company, onSaved }: { open: boolean; onClose: () => void; company: CompanyFull; onSaved: () => void }) {
  const toast = useToast();
  const { people, current } = useSession();
  const [form, setForm] = useState({
    name: company.name,
    contact_name: company.contact_name ?? '',
    contact_title: company.contact_title ?? '',
    phone: company.phone ?? '',
    email: company.email ?? '',
    area: company.area ?? '',
    industry: company.industry ?? '',
    stage: company.stage,
    owner_id: company.owner_id ? String(company.owner_id) : '',
    follow_up_on: company.follow_up_on ?? '',
    do_not_contact: company.do_not_contact === 1,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/companies/${company.id}`, {
        ...form,
        email: form.email || null,
        owner_id: form.owner_id ? Number(form.owner_id) : null,
        follow_up_on: form.follow_up_on || null,
        actorId: current?.id,
      });
      toast('Company updated');
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
      wide
      title="Edit company"
      subtitle="Nothing here is locked — fix anything the import got wrong."
      footer={
        <div className="flex gap-2">
          <button className="btn-ghost flex-1 sm:flex-none" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : <Save size={15} />} Save
          </button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Company name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </div>
        <Field label="Contact title">
          <select className="input" value={form.contact_title} onChange={(e) => setForm({ ...form, contact_title: e.target.value })}>
            <option value="">—</option>
            {['MR.', 'MRS.', 'MS.', 'DR.', 'ENGR.'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Contact name"><input className="input" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></Field>
        <Field label="Phone" hint="Pakistani format, e.g. 0321-4004998"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Area"><input className="input" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} /></Field>
        <Field label="Industry"><input className="input" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></Field>
        <Field label="Stage">
          <select className="input" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
            {Object.entries(STAGE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Owner">
          <select className="input" value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
            <option value="">Unassigned</option>
            {people.filter((p) => p.role === 'salesman').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Follow up on"><input type="date" className="input" value={form.follow_up_on} onChange={(e) => setForm({ ...form, follow_up_on: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600"
            checked={form.do_not_contact}
            onChange={(e) => setForm({ ...form, do_not_contact: e.target.checked })}
          />
          Do not contact — the agent will never assign this company
        </label>
      </div>
    </Modal>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-800">{value}</dd>
    </div>
  );
}

function safeParse(json: string | null): Array<{ product: string; qty: number; uom: string }> {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

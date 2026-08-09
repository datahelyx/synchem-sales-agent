import { CalendarDays, ClipboardCheck, Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { contactLabel, dateTime } from '../lib/format';
import { useSession } from '../session';
import { Badge, EmptyState, ErrorNote, Loading, useApi, useToast } from '../ui';
import { FeedbackForm } from './FeedbackForm';

interface MeetingRow {
  id: number; scheduled_at: string; duration_min: number; mode: string; status: string;
  location: string | null; contact_notified_at: string | null;
  company_id: number; company_name: string; area: string | null;
  contact_name: string | null; contact_title: string | null; phone_e164: string | null;
  salesman_id: number; salesman_name: string; feedback_id: number | null; outcome: string | null;
}

const STATUS_TONE: Record<string, string> = {
  proposed: 'bg-slate-100 text-slate-600',
  scheduled: 'bg-brand-50 text-brand-700',
  held: 'bg-brand-100 text-brand-800',
  no_show: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-slate-100 text-slate-500',
  rescheduled: 'bg-marine-50 text-marine-800',
};

export function Meetings() {
  const { current, isManager } = useSession();
  const toast = useToast();
  const [mineOnly, setMineOnly] = useState(!isManager);
  const [status, setStatus] = useState('');
  const [feedbackFor, setFeedbackFor] = useState<MeetingRow | null>(null);

  const params = new URLSearchParams();
  if (mineOnly && current) params.set('salesmanId', String(current.id));
  if (status) params.set('status', status);
  const qs = params.toString();

  const { data, loading, error, refresh } = useApi<MeetingRow[]>(`/meetings${qs ? `?${qs}` : ''}`);

  async function update(id: number, patch: Record<string, unknown>) {
    try {
      await api.patch(`/meetings/${id}`, patch);
      toast('Meeting updated');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update', 'error');
    }
  }

  async function invite(id: number) {
    try {
      await api.post(`/meetings/${id}/invite`);
      toast('Invitation queued for the contact');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send', 'error');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Meetings</h1>
          <p className="mt-0.5 text-sm text-slate-500">{data?.length ?? 0} shown</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="scheduled">Scheduled</option>
            <option value="held">Held</option>
            <option value="no_show">No show</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            Only mine
          </label>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : !data?.length ? (
        <EmptyState icon={<CalendarDays size={26} />} title="No meetings here" body="Book one from My week or a company page." />
      ) : (
        <ul className="space-y-2.5">
          {data.map((m) => {
            const passed = new Date(m.scheduled_at).getTime() < Date.now();
            return (
              <li key={m.id} className="card flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Link to={`/companies/${m.company_id}`} className="text-sm font-semibold text-slate-900 hover:text-brand-700">
                    {m.company_name}
                  </Link>
                  <p className="mt-0.5 text-sm text-slate-600">{dateTime(m.scheduled_at)} · {m.duration_min} min · {m.mode}</p>
                  <p className="text-xs text-slate-500">
                    {contactLabel(m.contact_title, m.contact_name)} · {m.salesman_name}
                    {m.location ? ` · ${m.location}` : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[m.status] ?? 'bg-slate-100 text-slate-600'}>{m.status.replace('_', ' ')}</Badge>
                  {m.outcome && <Badge tone="bg-emerald-50 text-emerald-700">{m.outcome}</Badge>}
                  {!m.contact_notified_at && m.phone_e164 && (
                    <button className="btn-subtle" onClick={() => invite(m.id)} title="Send the contact a confirmation">
                      <Send size={14} /> Invite contact
                    </button>
                  )}
                  {m.status === 'scheduled' && !passed && (
                    <select
                      className="input w-auto py-1.5 text-xs"
                      value=""
                      onChange={(e) => e.target.value && update(m.id, { status: e.target.value })}
                    >
                      <option value="">Change status…</option>
                      <option value="held">Mark as held</option>
                      <option value="no_show">No show</option>
                      <option value="cancelled">Cancel</option>
                    </select>
                  )}
                  <button className={passed && !m.outcome ? 'btn-primary' : 'btn-ghost'} onClick={() => setFeedbackFor(m)}>
                    <ClipboardCheck size={14} /> {m.outcome ? 'Edit outcome' : 'Log outcome'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <FeedbackForm
        open={feedbackFor !== null}
        onClose={() => setFeedbackFor(null)}
        onDone={refresh}
        meetingId={feedbackFor?.id ?? null}
        companyName={feedbackFor?.company_name ?? ''}
      />
    </div>
  );
}

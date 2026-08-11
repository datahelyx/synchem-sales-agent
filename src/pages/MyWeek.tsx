import {
  ArrowRight, CalendarClock, CalendarPlus, CheckCircle2, ClipboardCheck, Inbox, Mail, MapPin,
  MessageCircle, Phone, Sparkles, User,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AssignmentRow } from '../lib/api';
import { contactLabel, dateTime, phoneLabel, qualityLabel, STAGE_META } from '../lib/format';
import { useSession } from '../session';
import { Badge, EmptyState, ErrorNote, Loading, SectionTitle, Spinner, useApi, useToast } from '../ui';
import { FeedbackForm } from './FeedbackForm';
import { ScheduleMeeting } from './ScheduleMeeting';

/**
 * The screen a salesman lives in: this week's companies and the two or three
 * actions that move each one forward. Everything else in the app is secondary.
 */
export function MyWeek() {
  const { current } = useSession();
  const toast = useToast();

  const { data, loading, error, refresh } = useApi<{ week: string; weekLabel: string; rows: AssignmentRow[] }>(
    current ? `/assignments?salesmanId=${current.id}` : null,
  );

  const [scheduling, setScheduling] = useState<AssignmentRow | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<AssignmentRow | null>(null);
  const [asking, setAsking] = useState(false);

  async function askForWork() {
    if (!current) return;
    setAsking(true);
    try {
      const res = await api.post<{ created: number }>('/agent/run-weekly', { salesmanIds: [current.id] });
      toast(res.created ? `The agent assigned you ${res.created} more ${res.created === 1 ? 'company' : 'companies'}` : 'Nothing new to assign right now', res.created ? 'ok' : 'info');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the agent', 'error');
    } finally {
      setAsking(false);
    }
  }

  if (!current) return <EmptyState title="Pick who you are" body="Use the avatar in the top-right to choose your name." />;
  if (loading) return <Loading label="Loading your week" />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;

  const rows = data?.rows ?? [];
  const done = rows.filter((r) => r.status === 'completed').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {greeting()}, {current.name.split(' ')[0]}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">Your companies for {data?.weekLabel}</p>
        </div>
        <button className="btn-ghost" onClick={askForWork} disabled={asking}>
          {asking ? <Spinner /> : <Sparkles size={16} />}
          Ask the agent for more
        </button>
      </div>

      {/* A salesman's whole week is 2 cards; showing progress makes "am I done?"
          answerable at a glance instead of by counting. */}
      {rows.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-700">
              {done === rows.length ? (
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 size={16} /> All done for this week
                </span>
              ) : (
                `${done} of ${rows.length} wrapped up`
              )}
            </p>
            <p className="text-xs tabular-nums text-slate-500">{Math.round((done / rows.length) * 100)}%</p>
          </div>
          <div className="mt-2 flex gap-1.5" role="img" aria-label={`${done} of ${rows.length} companies completed`}>
            {rows.map((r) => (
              <span
                key={r.id}
                className={`h-1.5 flex-1 rounded-full ${r.status === 'completed' ? 'bg-emerald-500' : 'bg-slate-200'}`}
              />
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title="Nothing assigned this week yet"
          body="The agent hands out companies every Monday at 9am. You can also pull your next ones now."
          action={
            <button className="btn-primary" onClick={askForWork} disabled={asking}>
              {asking ? <Spinner /> : <Sparkles size={16} />} Get my companies
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((row) => (
            <CompanyCard
              key={row.id}
              row={row}
              onSchedule={() => setScheduling(row)}
              onFeedback={() => setFeedbackFor(row)}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {scheduling && current && (
        <ScheduleMeeting
          open
          onClose={() => setScheduling(null)}
          onDone={refresh}
          salesmanId={current.id}
          company={{ ...scheduling, assignment_id: scheduling.id }}
        />
      )}

      {feedbackFor && (
        <FeedbackForm
          open
          onClose={() => setFeedbackFor(null)}
          onDone={refresh}
          meetingId={feedbackFor.open_meeting_id ?? feedbackFor.last_meeting_id}
          companyName={feedbackFor.company_name}
        />
      )}
    </div>
  );
}

function CompanyCard({
  row, onSchedule, onFeedback, onChanged,
}: {
  row: AssignmentRow; onSchedule: () => void; onFeedback: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const stage = STAGE_META[row.stage] ?? STAGE_META.new;
  const quality = qualityLabel(row.data_quality);
  const hasMeeting = Boolean(row.open_meeting_id);
  const meetingPassed = row.open_meeting_at ? new Date(row.open_meeting_at).getTime() < Date.now() : false;

  async function markContacted() {
    try {
      await api.patch(`/assignments/${row.id}`, { status: 'in_progress' });
      toast(`Marked ${row.company_name} as contacted`);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update', 'error');
    }
  }

  const isDone = row.status === 'completed';
  // The next thing to do should be obvious without reading the card. A finished
  // company recedes; one with a meeting today pushes forward.
  // Navy and cyan are SynChem's; amber and emerald stay because "needs
  // attention" and "done" are conventions a brand should not reinvent.
  const accent = isDone ? 'bg-emerald-500' : meetingPassed ? 'bg-amber-500' : hasMeeting ? 'bg-marine-500' : 'bg-brand-500';

  return (
    <article className={`card relative flex flex-col overflow-hidden p-4 pl-5 ${isDone ? 'opacity-75' : ''}`}>
      <span className={`absolute inset-y-0 left-0 w-1.5 ${accent}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/companies/${row.company_id}`} className="block truncate text-base font-semibold text-slate-900 transition-colors hover:text-accent-600">
            {row.company_name}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={stage.tone}>{stage.label}</Badge>
            {row.industry && <Badge>{row.industry}</Badge>}
            <Badge tone={quality.tone}>{quality.text}</Badge>
          </div>
        </div>
        {isDone && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
            <CheckCircle2 size={12} /> Done
          </span>
        )}
      </div>

      {row.reason && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-brand-50/70 px-2.5 py-2 text-xs text-brand-900">
          <Sparkles size={13} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">Why you got this: </span>{row.reason}</span>
        </p>
      )}

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row icon={<User size={14} />} value={contactLabel(row.contact_title, row.contact_name)} />
        <Row
          icon={<Phone size={14} />}
          value={
            row.phone_e164 ? (
              <a href={`tel:${row.phone_e164}`} className="text-brand-700 hover:underline">{phoneLabel(row.phone_e164, row.phone)}</a>
            ) : (
              <span className="text-amber-700">No usable phone number</span>
            )
          }
        />
        {row.email && <Row icon={<Mail size={14} />} value={<a href={`mailto:${row.email}`} className="text-brand-700 hover:underline">{row.email}</a>} />}
        {row.area && <Row icon={<MapPin size={14} />} value={row.area} />}
        {row.open_meeting_at && (
          <Row
            icon={<CalendarClock size={14} />}
            value={<span className={meetingPassed ? 'font-medium text-amber-700' : 'font-medium text-slate-800'}>{dateTime(row.open_meeting_at)}{meetingPassed ? ' — needs an outcome' : ''}</span>}
          />
        )}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        {row.whatsapp_url && (
          <a href={row.whatsapp_url} target="_blank" rel="noreferrer" className="btn-ghost" onClick={markContacted}>
            <MessageCircle size={15} /> WhatsApp
          </a>
        )}
        {hasMeeting ? (
          <button className={meetingPassed ? 'btn-primary' : 'btn-ghost'} onClick={onFeedback}>
            <ClipboardCheck size={15} /> {meetingPassed ? 'Log the outcome' : 'Log outcome early'}
          </button>
        ) : row.last_outcome ? (
          // Already wrapped up — the useful action is correcting what was
          // recorded, not booking again. Booking stays available, just secondary.
          <>
            <button className="btn-ghost" onClick={onFeedback}>
              <ClipboardCheck size={15} /> Edit outcome
            </button>
            <button className="btn-subtle" onClick={onSchedule}>
              <CalendarPlus size={15} /> Book another
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={onSchedule}>
            <CalendarPlus size={15} /> Book a meeting
          </button>
        )}
        <Link to={`/companies/${row.company_id}`} className="btn-subtle ml-auto">
          History <ArrowRight size={14} />
        </Link>
      </div>
    </article>
  );
}

function Row({ icon, value }: { icon: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-slate-600">
      <span className="text-slate-400">{icon}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export { SectionTitle };

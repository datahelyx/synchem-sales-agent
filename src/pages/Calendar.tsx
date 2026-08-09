import { AlertTriangle, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Download, MapPin, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { googleCalendarLink, STAGE_META } from '../lib/format';
import { useSession } from '../session';
import { Badge, ErrorNote, Loading, Spinner, useApi, useToast } from '../ui';

interface MeetingRow {
  id: number; scheduled_at: string; duration_min: number; mode: string; status: string;
  location: string | null; company_id: number; company_name: string; area: string | null;
  salesman_id: number; salesman_name: string; outcome: string | null;
}

const MODE_LABEL: Record<string, string> = { onsite: 'Visit', call: 'Call', video: 'Video' };

interface GoogleStatus {
  configured: boolean;
  redirectUri: string;
  accounts: Array<{ id: number; name: string; role: string; connected: boolean; email: string | null; error: string | null }>;
}

/**
 * Connect/disconnect Google Calendar. Each person connects their own account —
 * the tokens are per salesman, because the agent pushes events from cron runs
 * when nobody is signed in.
 */
function GoogleConnection() {
  const { current, isManager } = useSession();
  const toast = useToast();
  const { data, refresh } = useApi<GoogleStatus>('/google/status');
  const [busy, setBusy] = useState(false);

  if (!data) return null;

  const me = data.accounts.find((a) => a.id === current?.id);

  if (!data.configured) {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle size={16} /> Google Calendar is not set up yet
        </p>
        <p className="mt-1 text-xs leading-relaxed">
          Add <code className="rounded bg-amber-100 px-1">GOOGLE_CLIENT_ID</code> and{' '}
          <code className="rounded bg-amber-100 px-1">GOOGLE_CLIENT_SECRET</code> to <code>.env</code>, then restart.
          The redirect URI to register is{' '}
          <code className="rounded bg-amber-100 px-1">{data.redirectUri}</code>. Until then meetings still go out as
          .ics invites, which most calendars accept.
        </p>
      </div>
    );
  }

  async function act(path: string, label: string) {
    if (!current) return;
    setBusy(true);
    try {
      const r = await api.post<{ synced?: number; total?: number }>(path, { salesmanId: current.id });
      toast(r.synced !== undefined ? `${label}: ${r.synced} of ${r.total} synced` : label);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Google request failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <CalendarDays size={16} className="text-marine-600" />
            Google Calendar
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {me?.connected
              ? `Connected as ${me.email}. Meetings appear on your Google Calendar with its own reminders.`
              : 'Not connected. Connect and your meetings sync straight to your Google Calendar.'}
          </p>
          {me?.error && <p className="mt-1 text-xs text-rose-600">{me.error}</p>}
        </div>
        <div className="flex gap-2">
          {me?.connected ? (
            <>
              <button className="btn-ghost" disabled={busy} onClick={() => act('/google/resync', 'Re-synced')}>
                {busy ? <Spinner /> : <RefreshCw size={15} />} Re-sync
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => act('/google/disconnect', 'Disconnected')}>
                Disconnect
              </button>
            </>
          ) : (
            <a className="btn-primary" href={`/api/google/connect?salesmanId=${current?.id}`}>
              <CalendarDays size={15} /> Connect Google Calendar
            </a>
          )}
        </div>
      </div>

      {isManager && data.accounts.length > 1 && (
        <ul className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
          {data.accounts.map((a) => (
            <li key={a.id}>
              <Badge tone={a.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}>
                {a.connected ? <Check size={11} /> : null} {a.name.split(' ')[0]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Month view of everything booked. For a manager this is the whole team's
 * diary — each entry reads "Salesman × Company", which is the label they asked
 * for. They see it, but the reminder sweep never targets them.
 */
export function Calendar() {
  const { current, isManager } = useSession();
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [mineOnly, setMineOnly] = useState(!isManager);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Google bounces back here after consent with the outcome in the query string.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    if (!g) return;
    if (g === 'connected') {
      const pushed = Number(q.get('pushed') ?? 0);
      setBanner({
        tone: 'ok',
        text:
          `Google Calendar connected${q.get('email') ? ` as ${q.get('email')}` : ''}.` +
          (pushed ? ` ${pushed} upcoming meeting${pushed === 1 ? '' : 's'} pushed across.` : ''),
      });
    } else {
      setBanner({ tone: 'error', text: q.get('message') || 'Could not connect Google Calendar.' });
    }
    window.history.replaceState({}, '', '/calendar');
  }, []);

  const from = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const params = new URLSearchParams({ from: iso(from), to: iso(to) });
  if (mineOnly && current) params.set('salesmanId', String(current.id));
  const { data, loading, error, refresh } = useApi<MeetingRow[]>(`/meetings?${params.toString()}`);

  // Monday-first grid covering whole weeks either side of the month.
  const cells = useMemo(() => {
    const start = new Date(from);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
      if (i >= 34 && d > to) break;
    }
    return out;
  }, [from.getTime(), to.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, MeetingRow[]>();
    for (const r of data ?? []) {
      const k = iso(new Date(r.scheduled_at));
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    for (const list of m.values()) list.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    return m;
  }, [data]);

  const todayKey = iso(new Date());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Calendar</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {isManager && !mineOnly ? 'Every visit the team has booked' : 'Your booked visits'}
            {data ? ` · ${data.length} this month` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-brand-600"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Only mine
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
            <button
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
              aria-label="Previous month"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[9rem] text-center text-sm font-medium text-slate-800">
              {cursor.toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}
            </span>
            <button
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            className="btn-ghost"
            onClick={() => { const d = new Date(); d.setDate(1); setCursor(d); }}
          >
            Today
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3.5 text-sm ${
            banner.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-rose-200 bg-rose-50 text-rose-900'
          }`}
        >
          {banner.tone === 'ok' ? <Check size={17} className="mt-0.5 shrink-0" /> : <AlertTriangle size={17} className="mt-0.5 shrink-0" />}
          <span>{banner.text}</span>
        </div>
      )}

      <GoogleConnection />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d) => {
                const key = iso(d);
                const items = byDay.get(key) ?? [];
                const outside = d.getMonth() !== cursor.getMonth();
                return (
                  <div
                    key={key}
                    className={`min-h-[3.5rem] border-b border-r border-slate-100 p-1.5 sm:min-h-[6rem] ${outside ? 'bg-slate-50/60' : 'bg-white'}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] tabular-nums ${
                          key === todayKey
                            ? 'bg-brand-700 font-semibold text-white'
                            : outside
                              ? 'text-slate-300'
                              : 'text-slate-500'
                        }`}
                      >
                        {d.getDate()}
                      </span>
                    </div>
                    {/* A 49px cell cannot hold a readable label, so phones get
                        density dots and read the detail from the list below. */}
                    {items.length > 0 && (
                      <div className="flex flex-wrap gap-1 sm:hidden">
                        {items.slice(0, 6).map((m) => (
                          <span
                            key={m.id}
                            className={`h-1.5 w-1.5 rounded-full ${
                              m.status === 'cancelled' ? 'bg-slate-300' : m.outcome ? 'bg-emerald-500' : 'bg-brand-600'
                            }`}
                          />
                        ))}
                      </div>
                    )}

                    <ul className="hidden space-y-1 sm:block">
                      {items.slice(0, 3).map((m) => (
                        <li key={m.id}>
                          <Link
                            to={`/companies/${m.company_id}`}
                            title={`${m.salesman_name} × ${m.company_name} · ${new Date(m.scheduled_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}`}
                            className={`block truncate rounded px-1.5 py-1 text-[11px] leading-tight transition hover:opacity-80 ${
                              m.status === 'cancelled'
                                ? 'bg-slate-100 text-slate-400 line-through'
                                : m.outcome
                                  ? 'bg-emerald-50 text-emerald-800'
                                  : m.mode === 'onsite'
                                    ? 'bg-brand-50 text-brand-800'
                                    : 'bg-marine-50 text-marine-800'
                            }`}
                          >
                            <span className="font-medium tabular-nums">
                              {new Date(m.scheduled_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}
                            </span>{' '}
                            {isManager && !mineOnly ? `${m.salesman_name.split(' ')[0]} × ` : ''}
                            {m.company_name}
                          </Link>
                        </li>
                      ))}
                      {items.length > 3 && (
                        <li className="px-1.5 text-[11px] text-slate-400">+{items.length - 3} more</li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              This month, in order
            </h2>
            {!data?.length ? (
              <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                <CalendarDays size={16} /> Nothing booked this month.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {[...data].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="w-32 shrink-0 text-xs tabular-nums text-slate-500">
                      {new Date(m.scheduled_at).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link to={`/companies/${m.company_id}`} className="text-sm font-medium text-slate-800 hover:text-brand-700">
                        {isManager && !mineOnly ? `${m.salesman_name} × ${m.company_name}` : m.company_name}
                      </Link>
                      {(m.location || m.area) && (
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <MapPin size={11} /> {m.location || m.area}
                        </span>
                      )}
                    </span>
                    <Badge tone={m.mode === 'onsite' ? 'bg-brand-50 text-brand-700' : 'bg-marine-50 text-marine-800'}>
                      {MODE_LABEL[m.mode] ?? m.mode}
                    </Badge>
                    {m.outcome && <Badge tone={STAGE_META.won.tone}>{m.outcome}</Badge>}
                    <a
                      className="btn-subtle"
                      href={googleCalendarLink(m)}
                      target="_blank"
                      rel="noreferrer"
                      title="Add this to Google Calendar"
                    >
                      <CalendarPlus size={13} /> Google
                    </a>
                    <a
                      className="btn-subtle"
                      href={`/api/meetings/${m.id}/calendar.ics`}
                      title="Download for Outlook, Apple Calendar or anything else"
                    >
                      <Download size={13} /> .ics
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

import { AlertTriangle, CalendarClock, ClipboardList, Handshake, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { compactMoney, dateOnly, dateTime, money, STAGE_META } from '../lib/format';
import { useSession } from '../session';
import { Badge, EmptyState, ErrorNote, Loading, SectionTitle, Stat, useApi } from '../ui';

/**
 * SynChem's own colours — navy, cyan and red from their logo and site. They
 * were validated before use, not just adopted for looking right: this trio
 * separates better under colour-vision deficiency (worst pair ΔE 17.5) than the
 * generic blue/aqua/orange it replaced (9.2). Green+red stays rejected — that
 * pair fails, and won-vs-lost is exactly what a red-green colourblind reader
 * must not lose.
 *
 * Brand cyan sits at 2.96:1 on white, just under the 3:1 bar, so every series is
 * also directly labelled and the same numbers appear as text in the tiles and
 * the "show as a table" view.
 */
const C = {
  primary: '#375698', // SynChem navy — meetings
  good: '#00a0e0',    // SynChem cyan — won
  bad: '#d51b29',     // SynChem red — lost
  grid: '#e2e8f0',
  axis: '#94a3b8',
  ink: '#475569',
};

/** Ordinal navy ramp for the pipeline; nothing so light it fades into white. */
const PIPELINE_RAMP = ['#8aa3d6', '#7191cb', '#5a79ba', '#4667a6', '#375698', '#2c4886', '#243f79', '#1c3163'];

const STAGE_ORDER = ['assigned', 'contacted', 'meeting_scheduled', 'met', 'sample_sent', 'negotiating', 'won', 'lost'];

interface DashboardData {
  weekLabel: string;
  windowDays: number;
  totals: {
    companies: number; contactable: number; inPlay: number; assignedThisWeek: number;
    meetingsUpcoming: number; meetingsHeld: number; feedbackPending: number;
    dealsWon: number; samplesOut: number; revenue: number; invoices: number; conversionPct: number;
  };
  outcomes: Array<{ outcome: string; n: number }>;
  rejectionReasons: Array<{ label: string; n: number }>;
  pipeline: Array<{ stage: string; n: number }>;
  trend: Array<{ week: string; meetings: number; won: number; lost: number }>;
  bySalesman: Array<{ id: number; name: string; assigned: number; meetings: number; won: number; lost: number; revenue: number }>;
  topIndustries: Array<{ industry: string; meetings: number; won: number }>;
  upcoming: Array<{ id: number; scheduled_at: string; company_name: string; area: string | null; salesman_name: string }>;
  needsFeedback: Array<{ id: number; scheduled_at: string; company_name: string; salesman_name: string }>;
  followUps: Array<{ id: number; name: string; follow_up_on: string; stage: string; owner_name: string | null }>;
  recentActivity: Array<{ id: number; kind: string; summary: string; company_name: string | null; salesman_name: string | null; created_at: string; actor: string }>;
  dataHealth: { unreachable: number; with_email: number; no_contact_name: number; no_industry: number; no_area: number };
}

export function Dashboard() {
  const { current, isManager } = useSession();
  const [days, setDays] = useState(90);
  const [mineOnly, setMineOnly] = useState(!isManager);

  const scope = mineOnly && current ? `&salesmanId=${current.id}` : '';
  const { data, loading, error, refresh } = useApi<DashboardData>(`/dashboard?days=${days}${scope}`);

  if (loading) return <Loading label="Crunching the numbers" />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!data) return null;

  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Live from the pipeline · week of {data.weekLabel} · last {data.windowDays} days
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {[30, 90, 365].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${days === d ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {d === 365 ? '1 year' : `${d} days`}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Only my work
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Assigned this week"
          value={t.assignedThisWeek}
          sub={`${t.inPlay.toLocaleString()} ${t.inPlay === 1 ? 'company' : 'companies'} in play`}
          icon={<ClipboardList size={15} />}
          iconTone="bg-brand-50 text-brand-600"
        />
        <Stat
          label="Meetings upcoming"
          value={t.meetingsUpcoming}
          sub={`${t.meetingsHeld} held in ${data.windowDays} days`}
          icon={<CalendarClock size={15} />}
          iconTone="bg-violet-50 text-violet-600"
        />
        <Stat
          label="Deals won"
          value={t.dealsWon}
          sub={`${t.conversionPct}% of meetings held`}
          tone="text-emerald-700"
          icon={<Handshake size={15} />}
          iconTone="bg-emerald-50 text-emerald-600"
        />
        <Stat
          label="Invoiced"
          value={compactMoney(t.revenue)}
          sub={`${t.invoices} invoice${t.invoices === 1 ? '' : 's'}`}
          icon={<TrendingUp size={15} />}
          iconTone="bg-amber-50 text-amber-600"
        />
      </div>

      {(t.feedbackPending > 0 || t.samplesOut > 0) && (
        <div className="flex flex-wrap gap-3">
          {t.feedbackPending > 0 && (
            <span className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle size={15} />
              {t.feedbackPending} meeting{t.feedbackPending === 1 ? '' : 's'} still waiting on an outcome
            </span>
          )}
          {t.samplesOut > 0 && (
            <span className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
              <ClipboardList size={15} />
              {t.samplesOut} sample request{t.samplesOut === 1 ? '' : 's'} open
            </span>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ trend */}
      <section className="card p-4">
        <SectionTitle title="Meetings and outcomes over time" />
        {data.trend.length === 0 ? (
          <EmptyState icon={<TrendingUp size={24} />} title="No meetings recorded yet" body="Book and complete a meeting and this chart fills in." />
        ) : (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.trend} margin={{ top: 8, right: 16, bottom: 4, left: -18 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="week" tick={{ fill: C.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: C.grid }} tickFormatter={(v) => dateOnly(v).replace(/,.*/, '')} />
                  <YAxis tick={{ fill: C.axis, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                    labelFormatter={(v) => `Week of ${dateOnly(String(v))}`}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: C.ink }} />
                  <Line type="monotone" dataKey="meetings" name="Meetings held" stroke={C.primary} strokeWidth={2} dot={{ r: 4 }} label={{ position: 'top', fontSize: 10, fill: C.ink }} />
                  <Line type="monotone" dataKey="won" name="Won" stroke={C.good} strokeWidth={2} dot={{ r: 4 }} label={{ position: 'top', fontSize: 10, fill: C.ink }} />
                  <Line type="monotone" dataKey="lost" name="Lost" stroke={C.bad} strokeWidth={2} dot={{ r: 4 }} label={{ position: 'bottom', fontSize: 10, fill: C.ink }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">Show as a table</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500">
                    <tr><th className="py-1 pr-4">Week</th><th className="py-1 pr-4">Meetings</th><th className="py-1 pr-4">Won</th><th className="py-1">Lost</th></tr>
                  </thead>
                  <tbody className="tabular-nums text-slate-700">
                    {data.trend.map((r) => (
                      <tr key={r.week} className="border-t border-slate-100">
                        <td className="py-1 pr-4">{dateOnly(r.week)}</td><td className="py-1 pr-4">{r.meetings}</td>
                        <td className="py-1 pr-4">{r.won}</td><td className="py-1">{r.lost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* -------------------------------------------------------- outcomes */}
        <section className="card p-4">
          <SectionTitle title="Meeting outcomes" />
          {data.outcomes.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">No feedback logged yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {['approved', 'positive', 'rejected'].map((key) => {
                const n = data.outcomes.find((o) => o.outcome === key)?.n ?? 0;
                const total = data.outcomes.reduce((s, o) => s + o.n, 0) || 1;
                const pct = Math.round((n / total) * 100);
                const color = key === 'approved' ? C.good : key === 'positive' ? C.primary : C.bad;
                return (
                  <li key={key}>
                    <div className="mb-1 flex items-baseline justify-between text-sm">
                      <span className="font-medium capitalize text-slate-700">{key}</span>
                      <span className="tabular-nums text-slate-600">{n} <span className="text-slate-400">({pct}%)</span></span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ------------------------------------------------ rejection reasons */}
        <section className="card p-4">
          <SectionTitle title="Why deals are lost" />
          {data.rejectionReasons.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">Nothing rejected in this period.</p>
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.rejectionReasons} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke={C.grid} horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" width={140} tick={{ fill: C.ink, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} cursor={{ fill: '#f1f5f9' }} />
                  <Bar dataKey="n" name="Deals" fill={C.primary} radius={[0, 4, 4, 0]} barSize={14} label={{ position: 'right', fontSize: 11, fill: C.ink }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------- pipeline */}
      <section className="card p-4">
        <SectionTitle title="Where companies are sitting" />
        {data.pipeline.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">Nothing in the pipeline yet.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {STAGE_ORDER.map((stage, i) => {
              const n = data.pipeline.find((p) => p.stage === stage)?.n ?? 0;
              const meta = STAGE_META[stage];
              return (
                <div key={stage} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: PIPELINE_RAMP[i] }} />
                    <span className="truncate text-xs font-medium text-slate-600">{meta?.label ?? stage}</span>
                  </div>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{n.toLocaleString()}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- leaderboard */}
      {isManager && data.bySalesman.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Team</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Salesman</th>
                  <th className="px-4 py-2 font-medium">This week</th>
                  <th className="px-4 py-2 font-medium">Meetings</th>
                  <th className="px-4 py-2 font-medium">Won</th>
                  <th className="px-4 py-2 font-medium">Lost</th>
                  <th className="px-4 py-2 text-right font-medium">Invoiced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {data.bySalesman.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.assigned}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.meetings}</td>
                    <td className="px-4 py-2.5 font-medium text-emerald-700">{s.won}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.lost}</td>
                    <td className="px-4 py-2.5 text-right text-slate-800">{money(s.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------ lists */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ListCard
          title="Next meetings"
          icon={<CalendarClock size={15} />}
          empty="Nothing booked."
          items={data.upcoming.map((m) => ({
            key: m.id,
            primary: m.company_name,
            secondary: `${dateTime(m.scheduled_at)}${m.area ? ` · ${m.area}` : ''}`,
            trailing: m.salesman_name.split(' ')[0],
          }))}
        />
        <ListCard
          title="Waiting on an outcome"
          icon={<ClipboardList size={15} />}
          empty="All caught up."
          tone="amber"
          items={data.needsFeedback.map((m) => ({
            key: m.id,
            primary: m.company_name,
            secondary: `Met ${dateTime(m.scheduled_at)}`,
            trailing: m.salesman_name.split(' ')[0],
          }))}
        />
        <ListCard
          title="Follow-ups scheduled"
          icon={<Handshake size={15} />}
          empty="None scheduled."
          items={data.followUps.map((c) => ({
            key: c.id,
            primary: c.name,
            secondary: `${dateOnly(c.follow_up_on)} · ${STAGE_META[c.stage]?.label ?? c.stage}`,
            trailing: c.owner_name?.split(' ')[0] ?? '—',
            href: `/companies/${c.id}`,
          }))}
        />
      </div>

      {/* ------------------------------------------------------ data health */}
      {isManager && (
        <section className="card p-4">
          <SectionTitle title="Imported data health" />
          <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-5">
            <Health label="Cannot be contacted" value={data.dataHealth.unreachable} bad />
            <Health label="Have an email" value={data.dataHealth.with_email} />
            <Health label="No contact name" value={data.dataHealth.no_contact_name} />
            <Health label="No industry" value={data.dataHealth.no_industry} />
            <Health label="No area" value={data.dataHealth.no_area} />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Companies with no phone and no email can never be worked — the agent skips them when assigning.
          </p>
        </section>
      )}

      {data.recentActivity.length > 0 && (
        <section className="card p-4">
          <SectionTitle title="Recent activity" />
          <ul className="space-y-2">
            {data.recentActivity.map((a) => (
              <li key={a.id} className="flex items-start gap-3 text-sm">
                <Badge tone={a.actor === 'agent' ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600'}>{a.actor}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="text-slate-700">{a.summary}</span>
                  {a.company_name && <span className="text-slate-400"> · {a.company_name}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Health({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${bad && value > 0 ? 'text-rose-700' : 'text-slate-900'}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function ListCard({
  title, icon, items, empty, tone,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  tone?: 'amber';
  items: Array<{ key: number; primary: string; secondary: string; trailing?: string; href?: string }>;
}) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <span className={tone === 'amber' ? 'text-amber-600' : 'text-slate-400'}>{icon}</span>
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => {
            const inner = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">{i.primary}</span>
                  <span className="block truncate text-xs text-slate-500">{i.secondary}</span>
                </span>
                {i.trailing && <span className="shrink-0 text-xs text-slate-400">{i.trailing}</span>}
              </>
            );
            return (
              <li key={i.key}>
                {i.href ? (
                  <Link to={i.href} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-slate-50">{inner}</Link>
                ) : (
                  <span className="flex items-center gap-2 px-1 py-1">{inner}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

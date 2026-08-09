import { AlertTriangle, Bot, CalendarClock, Inbox, Play, RefreshCw, Save, Settings2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type NotificationRow } from '../lib/api';
import { relative } from '../lib/format';
import { Badge, ErrorNote, Field, Loading, SectionTitle, Spinner, Stat, useApi, useToast } from '../ui';

interface AgentStatus {
  week: string;
  weekLabel: string;
  availablePool: number;
  cronEnabled: boolean;
  outboundMode: 'off' | 'redirect' | 'allowlist' | 'live';
  redirectTo: string | null;
  suppressed: number;
  perSalesman: Array<{ id: number; name: string; quota: number; assigned: number; short: number }>;
  lastRun: { id: number; kind: string; created: number; notified: number; created_at: string; trigger: string } | null;
}

interface AgentRun {
  id: number; kind: string; week_start: string | null; trigger: string;
  created: number; skipped: number; notified: number; created_at: string;
}

/** The manager's window into the autonomous half — what it did, and why. */
export function AgentConsole() {
  const toast = useToast();
  const { data: status, loading, error, refresh } = useApi<AgentStatus>('/agent/status');
  const { data: runs, refresh: refreshRuns } = useApi<AgentRun[]>('/agent/runs');
  const { data: outbox, refresh: refreshOutbox } = useApi<NotificationRow[]>('/notifications?recipientType=all&limit=40');
  const { data: settings, refresh: refreshSettings } = useApi<Record<string, string>>('/settings');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(path: string, label: string) {
    setBusy(path);
    try {
      const res = await api.post<Record<string, number>>(path, {});
      const created = res.created ?? res.notified ?? res.sent ?? 0;
      toast(`${label}: ${created} ${created === 1 ? 'action' : 'actions'}`, created ? 'ok' : 'info');
      refresh(); refreshRuns(); refreshOutbox();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The agent could not run', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading label="Checking on the agent" />;
  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!status) return null;

  const short = status.perSalesman.reduce((n, s) => n + s.short, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Agent</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {status.cronEnabled
            ? 'Running on schedule: assignments Monday 09:00, reminders 18:00, follow-ups 08:30 (Asia/Karachi).'
            : 'Scheduled runs are switched off (AGENT_CRON=off) — trigger them by hand below.'}
        </p>
      </div>

      {/* The single most consequential setting in the app gets its own banner. */}
      {status.outboundMode === 'live' ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-900">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <span>
            <strong>Live outbound is ON.</strong> Meeting invites and reminders are delivered to the real company
            contacts imported from your CSV. Set <code className="rounded bg-amber-100 px-1">OUTBOUND_MODE=off</code> in
            your <code className="rounded bg-amber-100 px-1">.env</code> before testing anything.
          </span>
        </div>
      ) : status.outboundMode === 'redirect' ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 p-3.5 text-sm text-sky-900">
          <ShieldCheck size={17} className="mt-0.5 shrink-0" />
          <span>
            <strong>Test redirect is on.</strong> Messages really are sent, but every one aimed at a company contact is
            re-addressed to <code className="rounded bg-sky-100 px-1">{status.redirectTo ?? 'nobody'}</code> with a
            banner naming the company it was meant for. No real customer can be reached in this mode.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-sm text-emerald-900">
          <ShieldCheck size={17} className="mt-0.5 shrink-0" />
          <span>
            <strong>Safe to test.</strong> Outbound delivery to company contacts is{' '}
            <code className="rounded bg-emerald-100 px-1">{status.outboundMode}</code>
            {status.outboundMode === 'allowlist' && ' — only numbers in OUTBOUND_ALLOWLIST are reachable'}. Messages to
            real companies are written to the outbox and marked <em>suppressed</em>, never delivered — and “Retry queued
            messages” will not release them.
            {status.suppressed > 0 && ` ${status.suppressed} message${status.suppressed === 1 ? '' : 's'} held so far.`}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Week" value={status.weekLabel} />
        <Stat label="Companies available" value={status.availablePool.toLocaleString()} sub="not won, lost or already in play" />
        <Stat label="Quota shortfall" value={short} tone={short ? 'text-amber-700' : 'text-slate-900'} sub="assignments still owed this week" />
        <Stat
          label="Last run"
          value={status.lastRun ? relative(status.lastRun.created_at) : 'never'}
          sub={status.lastRun ? `${status.lastRun.created} assigned · ${status.lastRun.trigger}` : undefined}
        />
      </div>

      <section className="card p-4">
        <SectionTitle title="Run something now" />
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy !== null} onClick={() => run('/agent/run-weekly', 'Weekly assignment')}>
            {busy === '/agent/run-weekly' ? <Spinner /> : <Play size={15} />} Assign this week's companies
          </button>
          <button className="btn-ghost" disabled={busy !== null} onClick={() => run('/agent/run-reminders', 'Reminders')}>
            {busy === '/agent/run-reminders' ? <Spinner /> : <CalendarClock size={15} />} Send reminders
          </button>
          <button className="btn-ghost" disabled={busy !== null} onClick={() => run('/agent/run-followups', 'Follow-up sweep')}>
            {busy === '/agent/run-followups' ? <Spinner /> : <RefreshCw size={15} />} Sweep follow-ups
          </button>
          <button className="btn-ghost" disabled={busy !== null} onClick={() => run('/agent/drain-outbox', 'Outbox')}>
            {busy === '/agent/drain-outbox' ? <Spinner /> : <Inbox size={15} />} Retry queued messages
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="py-2 font-medium">Salesman</th><th className="py-2 font-medium">Assigned</th><th className="py-2 font-medium">Quota</th><th className="py-2 font-medium">Short</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {status.perSalesman.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 font-medium text-slate-800">{s.name}</td>
                  <td className="py-2 text-slate-600">{s.assigned}</td>
                  <td className="py-2 text-slate-600">{s.quota}</td>
                  <td className={`py-2 ${s.short ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>{s.short || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <AgentSettings settings={settings ?? {}} onSaved={refreshSettings} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <SectionTitle title="Run history" />
          {!runs?.length ? (
            <p className="py-6 text-center text-sm text-slate-400">The agent has not run yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                  <Bot size={14} className="shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-700">{r.kind.replace(/_/g, ' ')}</span>
                    <span className="block text-xs text-slate-500">
                      {r.created} created · {r.notified} notified{r.skipped ? ` · ${r.skipped} short` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{r.trigger} · {relative(r.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <SectionTitle title="Message outbox" />
          <p className="mb-2 text-xs text-slate-500">
            Every message the agent produced — nothing is ever silently dropped.{' '}
            <em>Held</em> means the outbound guard refused to contact a real company and never will;{' '}
            <em>queued</em> means it is waiting on credentials for that channel.
          </p>
          {!outbox?.length ? (
            <p className="py-6 text-center text-sm text-slate-400">Nothing sent yet.</p>
          ) : (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto text-sm">
              {outbox.map((n) => (
                <li key={n.id} className="rounded-lg border border-slate-200 p-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={n.channel === 'whatsapp' ? 'bg-emerald-50 text-emerald-700' : n.channel === 'email' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'}>
                      {n.channel}
                    </Badge>
                    <Badge
                      tone={
                        n.status === 'sent' || n.status === 'read'
                          ? 'bg-emerald-50 text-emerald-700'
                          : n.status === 'failed'
                            ? 'bg-rose-50 text-rose-700'
                            : n.status === 'suppressed'
                              ? 'bg-slate-200 text-slate-700'
                              : 'bg-amber-50 text-amber-700'
                      }
                    >
                      {n.status === 'suppressed' ? 'held — not sent' : n.status}
                    </Badge>
                    <span className="text-xs text-slate-400">{n.to_addr ?? n.recipient_type} · {relative(n.created_at)}</span>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600">{n.body}</p>
                  {n.error && <p className="mt-1 text-xs text-rose-600">{n.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function AgentSettings({ settings, onSaved }: { settings: Record<string, string>; onSaved: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState(settings.scheduling_provider ?? 'manual');
  const [targets, setTargets] = useState(settings.target_industries ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.put('/settings', { scheduling_provider: provider, target_industries: targets });
      toast('Settings saved');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-4">
      <SectionTitle title="Settings" action={<Settings2 size={15} className="text-slate-400" />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Field
          label="Meeting scheduler"
          hint="Calendly needs CALENDLY_LINK in the environment. Odoo's calendar drops in here later without touching the UI."
        >
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="manual">Built-in slot picker</option>
            <option value="calendly">Calendly</option>
            <option value="odoo">Odoo calendar (not implemented yet)</option>
          </select>
        </Field>
        <Field
          label="Target industries"
          hint="Comma separated. Companies in these industries are ranked highest when assigning. Leave blank to rank on contact data alone."
        >
          <input className="input" value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="Textiles & Apparel, Chemicals, Pharma & Healthcare…" />
        </Field>
      </div>
      <button className="btn-primary mt-3" onClick={save} disabled={saving}>
        {saving ? <Spinner /> : <Save size={15} />} Save settings
      </button>
    </section>
  );
}

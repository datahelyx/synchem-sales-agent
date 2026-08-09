/**
 * Stage colours run SynChem's navy → cyan as the company moves through the
 * early pipeline, deepening as it progresses, then hand over to the usual
 * amber/emerald/rose once the outcome is what matters. Neighbouring stages use
 * different steps of the ramp so two adjacent stages never look identical.
 */
export const STAGE_META: Record<string, { label: string; tone: string }> = {
  new: { label: 'Not started', tone: 'bg-slate-100 text-slate-600' },
  assigned: { label: 'Assigned', tone: 'bg-brand-50 text-brand-700' },
  contacted: { label: 'Contacted', tone: 'bg-marine-50 text-marine-700' },
  meeting_scheduled: { label: 'Meeting booked', tone: 'bg-marine-100 text-marine-800' },
  met: { label: 'Meeting held', tone: 'bg-brand-100 text-brand-800' },
  sample_sent: { label: 'Sample sent', tone: 'bg-amber-50 text-amber-700' },
  negotiating: { label: 'Negotiating', tone: 'bg-orange-50 text-orange-700' },
  won: { label: 'Won', tone: 'bg-emerald-50 text-emerald-700' },
  lost: { label: 'Lost', tone: 'bg-rose-50 text-rose-700' },
  on_hold: { label: 'On hold', tone: 'bg-slate-100 text-slate-600' },
};

export const OUTCOME_META: Record<string, { label: string; tone: string; blurb: string }> = {
  positive: {
    label: 'Positive',
    tone: 'bg-marine-50 text-marine-800 border-marine-200',
    blurb: 'Interested, but not closed yet',
  },
  approved: {
    label: 'Approved',
    tone: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    blurb: 'Deal agreed — closes the company and raises an invoice',
  },
  rejected: {
    label: 'Rejected',
    tone: 'bg-rose-50 text-rose-700 border-rose-200',
    blurb: 'Not going ahead',
  },
};

const PKR = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });

export function money(n: number | null | undefined): string {
  return PKR.format(Number(n ?? 0));
}

export function compactMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `PKR ${(v / 1_000).toFixed(0)}K`;
  return `PKR ${v.toFixed(0)}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-PK', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return '';
  // SQLite datetime('now') is UTC without a zone marker; tell Date so.
  const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
  const then = new Date(stamp).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return 'just now';
  if (Math.abs(mins) < 60) return mins > 0 ? `${mins}m ago` : `in ${-mins}m`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return hrs > 0 ? `${hrs}h ago` : `in ${-hrs}h`;
  const days = Math.round(hrs / 24);
  if (Math.abs(days) < 30) return days > 0 ? `${days}d ago` : `in ${-days}d`;
  return dateOnly(iso);
}

/**
 * The CSV writes the same number a dozen ways (`0321-4004998`, `3246052052`,
 * `+92 42 35990034`). Show the normalized form when we managed to parse one,
 * and fall back to whatever the file said when we did not.
 */
export function phoneLabel(e164: string | null | undefined, raw: string | null | undefined): string {
  if (e164) {
    const d = e164.replace('+92', '');
    return d.startsWith('3') ? `0${d.slice(0, 3)}-${d.slice(3)}` : `0${d}`;
  }
  return raw?.trim() || '';
}

/**
 * One-click "Add to Google Calendar" link. Needs no OAuth and no setup, so it
 * works the moment the app runs — the proper API sync is better, this is what
 * covers everyone who has not connected an account.
 */
export function googleCalendarLink(m: {
  scheduled_at: string;
  duration_min?: number | null;
  company_name: string;
  salesman_name?: string | null;
  location?: string | null;
  area?: string | null;
  mode?: string | null;
}): string {
  const start = new Date(m.scheduled_at);
  const end = new Date(start.getTime() + (m.duration_min ?? 30) * 60_000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const verb = (m.mode ?? 'onsite') === 'onsite' ? 'visit' : m.mode === 'call' ? 'call' : 'video call';

  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', `SynChem — ${verb} with ${m.company_name}`);
  u.searchParams.set('dates', `${fmt(start)}/${fmt(end)}`);
  if (m.location || m.area) u.searchParams.set('location', (m.location || m.area)!);
  u.searchParams.set(
    'details',
    [`SynChem Global ${verb} with ${m.company_name}.`, m.salesman_name ? `Representative: ${m.salesman_name}` : '']
      .filter(Boolean)
      .join('\n'),
  );
  return u.toString();
}

export function contactLabel(title: string | null, name: string | null): string {
  const s = [title, name].filter(Boolean).join(' ').trim();
  return s || 'Contact not recorded';
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** 0-100 lead-data score -> something a salesman can read at a glance. */
export function qualityLabel(score: number): { text: string; tone: string } {
  if (score >= 80) return { text: 'Complete details', tone: 'bg-emerald-50 text-emerald-700' };
  if (score >= 60) return { text: 'Phone + contact', tone: 'bg-marine-50 text-marine-800' };
  if (score >= 40) return { text: 'Phone only', tone: 'bg-amber-50 text-amber-700' };
  return { text: 'Sparse details', tone: 'bg-rose-50 text-rose-700' };
}

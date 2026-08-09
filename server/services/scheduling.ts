import { db } from '../db/index.js';
import { dayjs, TZ } from '../lib/dates.js';

/**
 * Meeting scheduling sits behind a provider interface because the brief says
 * Calendly now, Odoo's calendar later.
 *
 *  - `manual`   — built-in slot picker. Works offline, no account needed, and
 *                 is the default so the pipeline is never blocked on a signup.
 *  - `calendly` — if CALENDLY_LINK is set we hand the salesman their scheduling
 *                 link and store the resulting event reference.
 *  - `odoo`     — placeholder; implement createEvent() against calendar.event
 *                 when the module lands. Nothing else in the app changes.
 */

export type ProviderName = 'manual' | 'calendly' | 'odoo';

export interface SlotRequest {
  salesmanId: number;
  companyId: number;
  scheduledAt: string;
  durationMin: number;
  /** Always an in-person visit today; kept optional for a future call/video mode. */
  mode?: 'onsite' | 'call' | 'video';
  location?: string | null;
}

export interface ProviderResult {
  provider: ProviderName;
  providerEventId: string | null;
  bookingUrl: string | null;
}

export interface SchedulingProvider {
  name: ProviderName;
  createEvent(req: SlotRequest): Promise<ProviderResult> | ProviderResult;
  cancelEvent?(providerEventId: string): Promise<void> | void;
}

const manual: SchedulingProvider = {
  name: 'manual',
  createEvent: () => ({ provider: 'manual', providerEventId: null, bookingUrl: null }),
};

const calendly: SchedulingProvider = {
  name: 'calendly',
  createEvent: (req) => {
    const base = process.env.CALENDLY_LINK;
    if (!base) return manual.createEvent(req) as ProviderResult;
    // Calendly's public link cannot be booked server-side without the paid API,
    // so we prefill the link and let the salesman confirm the slot.
    const url = new URL(base);
    url.searchParams.set('month', dayjs(req.scheduledAt).format('YYYY-MM'));
    url.searchParams.set('date', dayjs(req.scheduledAt).format('YYYY-MM-DD'));
    return { provider: 'calendly', providerEventId: null, bookingUrl: url.toString() };
  },
};

const providers: Record<ProviderName, SchedulingProvider> = {
  manual,
  calendly,
  odoo: { name: 'odoo', createEvent: (req) => manual.createEvent(req) as ProviderResult },
};

export function activeProvider(): SchedulingProvider {
  const configured = (db.prepare(`SELECT value FROM setting WHERE key = 'scheduling_provider'`).get() as any)?.value;
  const name = (configured ?? (process.env.CALENDLY_LINK ? 'calendly' : 'manual')) as ProviderName;
  return providers[name] ?? manual;
}

/**
 * Working-hour slots for the next `days` days, minus anything the salesman has
 * already booked. Fridays get a lunch-prayer gap, Sundays are skipped.
 */
export function suggestSlots(salesmanId: number, days = 10, durationMin = 30) {
  const busy = new Set(
    (
      db
        .prepare(
          `SELECT scheduled_at FROM meeting
            WHERE salesman_id = ? AND status IN ('proposed','scheduled')
              AND scheduled_at >= datetime('now')`,
        )
        .all(salesmanId) as any[]
    ).map((m) => dayjs(m.scheduled_at).format('YYYY-MM-DD HH:mm')),
  );

  const hours = [10, 11, 12, 14, 15, 16];
  const out: Array<{ date: string; label: string; slots: Array<{ iso: string; label: string; free: boolean }> }> = [];

  for (let d = 1; d <= days; d++) {
    const day = dayjs().tz(TZ).add(d, 'day').startOf('day');
    if (day.day() === 0) continue; // Sunday
    const isFriday = day.day() === 5;

    const slots = hours
      .filter((h) => !(isFriday && (h === 12 || h === 14)))
      .map((h) => {
        const at = day.hour(h).minute(0).second(0);
        return {
          iso: at.format(),
          label: at.format('h:mm A'),
          free: !busy.has(at.format('YYYY-MM-DD HH:mm')),
        };
      });

    out.push({ date: day.format('YYYY-MM-DD'), label: day.format('ddd D MMM'), slots });
    if (out.length >= 7) break;
  }
  return { durationMin, timezone: TZ, days: out };
}

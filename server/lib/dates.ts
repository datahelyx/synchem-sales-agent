import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

/** Everyone using this runs on Pakistan time; weeks and "today" follow suit. */
export const TZ = process.env.TZ_NAME ?? 'Asia/Karachi';

export function localNow() {
  return dayjs().tz(TZ);
}

/** ISO date (YYYY-MM-DD) of the Monday of the week containing `d`. */
export function weekStart(d?: string | Date): string {
  const base = d ? dayjs(d).tz(TZ) : localNow();
  return base.startOf('isoWeek').format('YYYY-MM-DD');
}

export function nextWeekStart(d?: string | Date): string {
  return dayjs(weekStart(d)).add(7, 'day').format('YYYY-MM-DD');
}

export function weekLabel(mondayIso: string): string {
  const start = dayjs(mondayIso);
  const end = start.add(6, 'day');
  const sameMonth = start.month() === end.month();
  return sameMonth
    ? `${start.format('D')}–${end.format('D MMM YYYY')}`
    : `${start.format('D MMM')} – ${end.format('D MMM YYYY')}`;
}

export function today(): string {
  return localNow().format('YYYY-MM-DD');
}

export function addDays(iso: string, n: number): string {
  return dayjs(iso).add(n, 'day').format('YYYY-MM-DD');
}

export { dayjs };

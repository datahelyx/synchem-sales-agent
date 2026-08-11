import { db } from '../db/index.js';

/**
 * Calendar invites (RFC 5545 .ics).
 *
 * This is what actually puts a meeting on someone's calendar with working
 * reminders: an .ics attached to the invite email is understood by Google
 * Calendar, Outlook and Apple Calendar, and the VALARM blocks below become
 * that person's own alerts on their own phone. The app's in-app reminders are
 * a backstop for the salesman, not the mechanism.
 *
 * Rescheduling re-sends the same UID with a higher SEQUENCE, so calendars
 * update the existing entry instead of creating a duplicate. Cancelling sends
 * METHOD:CANCEL for the same UID, which removes it.
 */

const PRODID = '-//SynChem Global//Sales Agent//EN';

/** RFC 5545 wants CRLF and lines folded at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let buf = line;
  while (Buffer.byteLength(buf, 'utf8') > 75) {
    let cut = 75;
    while (cut > 1 && Buffer.byteLength(buf.slice(0, cut), 'utf8') > 75) cut--;
    out.push(buf.slice(0, cut));
    buf = ' ' + buf.slice(cut); // continuation lines start with a space
  }
  out.push(buf);
  return out.join('\r\n');
}

function esc(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC stamp: 20260813T104500Z */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface IcsOptions {
  method: 'REQUEST' | 'CANCEL';
  /** Minutes before the start for each alarm. */
  alarms?: number[];
}

export async function icsForMeeting(meetingId: number, opts: IcsOptions = { method: 'REQUEST' }): Promise<string | null> {
  const m = await db
    .prepare(
      `SELECT m.*, c.name AS company_name, c.area, c.email AS company_email,
              c.contact_name, c.contact_title, c.phone_e164,
              s.name AS salesman_name, s.email AS salesman_email, s.phone_e164 AS salesman_phone
         FROM meeting m
         JOIN company  c ON c.id = m.company_id
         JOIN salesman s ON s.id = m.salesman_id
        WHERE m.id = ?`,
    )
    .get(meetingId) as any;
  if (!m) return null;

  const start = new Date(m.scheduled_at);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + (m.duration_min ?? 30) * 60_000);

  const contact = [m.contact_title, m.contact_name].filter(Boolean).join(' ');
  const isVisit = (m.mode ?? 'onsite') === 'onsite';
  const summary = `SynChem — ${isVisit ? 'visit' : m.mode === 'call' ? 'call' : 'video call'} with ${m.company_name}`;
  const where = m.location || m.area || '';

  const descLines = [
    `${isVisit ? 'In-person visit' : 'Meeting'} on behalf of SynChem Global.`,
    `Company: ${m.company_name}`,
    contact ? `Contact: ${contact}${m.phone_e164 ? ` (${m.phone_e164})` : ''}` : '',
    `SynChem representative: ${m.salesman_name}${m.salesman_phone ? ` (${m.salesman_phone})` : ''}`,
    m.booking_url ? `Need a different time? ${m.booking_url}` : '',
  ].filter(Boolean);

  const alarms = opts.alarms ?? [24 * 60, 120];

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${opts.method}`,
    'BEGIN:VEVENT',
    // Stable per meeting so a reschedule updates rather than duplicates.
    `UID:sales-agent-meeting-${m.id}@synchemglobal.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SEQUENCE:${m.ics_sequence ?? 0}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(descLines.join('\n'))}`,
    where ? `LOCATION:${esc(where)}` : '',
    `STATUS:${opts.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ].filter(Boolean);

  if (m.salesman_email) {
    lines.push(`ORGANIZER;CN=${esc(m.salesman_name)}:mailto:${m.salesman_email}`);
  }
  if (m.company_email) {
    lines.push(
      `ATTENDEE;CN=${esc(contact || m.company_name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${m.company_email}`,
    );
  }

  // Alarms only make sense on a live invite, never on a cancellation.
  if (opts.method === 'REQUEST') {
    for (const mins of alarms) {
      lines.push(
        'BEGIN:VALARM',
        `TRIGGER:-PT${mins >= 60 && mins % 60 === 0 ? `${mins / 60}H` : `${mins}M`}`,
        'ACTION:DISPLAY',
        `DESCRIPTION:${esc(summary)}`,
        'END:VALARM',
      );
    }
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Bump SEQUENCE so a re-sent invite supersedes the previous one. */
export async function bumpIcsSequence(meetingId: number) {
  await db.prepare(
    `UPDATE meeting SET ics_sequence = COALESCE(ics_sequence, 0) + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(meetingId);
}

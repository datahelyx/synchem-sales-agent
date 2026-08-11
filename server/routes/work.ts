import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../db/index.js';
import { weekLabel, weekStart } from '../lib/dates.js';
import { asyncRoute, HttpError, intParam, parseBody } from '../lib/http.js';
import { bumpIcsSequence, icsForMeeting } from '../services/calendar.js';
import { busyBlocks, googleAccount, pushMeeting, removeMeeting } from '../services/google.js';
import { createOrReplaceSampleRequest, deleteSampleRequestForFeedback, syncInvoiceForFeedback } from '../services/commerce.js';
import { notify, outboundMode, redirectTarget, waLink } from '../services/notifier.js';
import { logActivity, recordRevision, setStage } from '../services/pipeline.js';
import { activeProvider, suggestSlots } from '../services/scheduling.js';

export const workRouter = Router();

/* ----------------------------------------------------------- assignments */

/** A salesman's week: the 2 companies plus everything needed to act on them. */
workRouter.get(
  '/assignments',
  asyncRoute(async (req, res) => {
    const { salesmanId, week } = req.query as Record<string, string>;
    const w = week || weekStart();
    const where = ['a.week_start = ?'];
    const params: any[] = [w];
    if (salesmanId) { where.push('a.salesman_id = ?'); params.push(Number(salesmanId)); }

    const rows = await db
      .prepare(
        `SELECT a.*, c.name AS company_name, c.area, c.industry, c.phone, c.phone_e164, c.email,
                c.contact_name, c.contact_title, c.stage, c.data_quality, c.follow_up_on,
                s.name AS salesman_name,
                (SELECT COUNT(*) FROM activity ac WHERE ac.company_id = c.id) AS activity_count,
                (SELECT m.id FROM meeting m
                  WHERE m.company_id = c.id AND m.status IN ('proposed','scheduled')
                  ORDER BY m.scheduled_at LIMIT 1) AS open_meeting_id,
                (SELECT m.scheduled_at FROM meeting m
                  WHERE m.company_id = c.id AND m.status IN ('proposed','scheduled')
                  ORDER BY m.scheduled_at LIMIT 1) AS open_meeting_at,
                -- Once feedback is logged the meeting leaves 'scheduled', so the
                -- card needs the latest meeting too — otherwise a finished
                -- company offers "Book a meeting" and the outcome is uneditable.
                (SELECT m.id FROM meeting m
                  WHERE m.company_id = c.id ORDER BY m.scheduled_at DESC LIMIT 1) AS last_meeting_id,
                (SELECT f.outcome FROM feedback f
                   JOIN meeting m ON m.id = f.meeting_id
                  WHERE m.company_id = c.id ORDER BY m.scheduled_at DESC LIMIT 1) AS last_outcome
           FROM assignment a
           JOIN company  c ON c.id = a.company_id
           JOIN salesman s ON s.id = a.salesman_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.id`,
      )
      .all(...params) as any[];

    for (const r of rows) {
      const greeting = [r.contact_title, r.contact_name].filter(Boolean).join(' ') || 'Sir/Madam';
      r.whatsapp_url = waLink(
        r.phone_e164,
        `Assalam-o-Alaikum ${greeting}, I'm reaching out from SynChem regarding your requirements at ${r.company_name}. Would you have a few minutes this week?`,
      );
    }

    res.json({ week: w, weekLabel: weekLabel(w), rows });
  }),
);

workRouter.patch(
  '/assignments/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(
      z.object({
        status: z.enum(['pending', 'in_progress', 'meeting_set', 'completed', 'skipped', 'carried_over']).optional(),
        notes: z.string().nullable().optional(),
        actorId: z.number().int().optional(),
      }),
      req.body,
    );
    const before = await db.prepare('SELECT * FROM assignment WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Assignment not found');

    await db.prepare(
      `UPDATE assignment SET status = COALESCE(?, status), notes = COALESCE(?, notes),
              closed_at = CASE WHEN ? IN ('completed','skipped') THEN datetime('now') ELSE closed_at END,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(patch.status ?? null, patch.notes ?? null, patch.status ?? '', id);

    if (patch.status === 'in_progress') await setStage(before.company_id, 'contacted', { salesmanId: before.salesman_id, actor: 'salesman' });

    const after = await db.prepare('SELECT * FROM assignment WHERE id = ?').get(id);
    await recordRevision('assignment', id, before, after, patch.actorId);
    res.json(after);
  }),
);

/* -------------------------------------------------------------- meetings */

workRouter.get(
  '/meetings/slots',
  asyncRoute(async (req, res) => {
    const salesmanId = intParam(req.query.salesmanId, 'salesmanId');
    const base = await suggestSlots(salesmanId);

    /*
     * When Google is connected, the salesman's real diary decides what is free
     * — including everything this app knows nothing about. Without it we can
     * only see meetings booked here, which is how you end up double-booking
     * someone who has a dentist appointment.
     */
    const all = base.days.flatMap((d) => d.slots);
    let googleBusy = false;
    if (all.length && await googleAccount(salesmanId)) {
      const from = all[0].iso;
      const last = new Date(all[all.length - 1].iso);
      const busy = await busyBlocks(salesmanId, from, new Date(last.getTime() + 60 * 60_000).toISOString());
      if (busy.length) {
        googleBusy = true;
        for (const day of base.days) {
          for (const slot of day.slots) {
            const s = new Date(slot.iso).getTime();
            const e = s + base.durationMin * 60_000;
            const clashes = busy.some((b) => s < new Date(b.end).getTime() && e > new Date(b.start).getTime());
            if (clashes) slot.free = false;
          }
        }
      }
    }

    // outboundMode travels with the slots so the booking screen can tell the
    // salesman up front whether the contact will really be messaged.
    res.json({
      provider: (await activeProvider()).name,
      outboundMode: outboundMode(),
      redirectTo: redirectTarget(),
      googleConnected: Boolean(await googleAccount(salesmanId)),
      googleBusy,
      ...base,
    });
  }),
);

workRouter.get(
  '/meetings',
  asyncRoute(async (req, res) => {
    const { salesmanId, status, from, to } = req.query as Record<string, string>;
    const where: string[] = [];
    const params: any[] = [];
    if (salesmanId) { where.push('m.salesman_id = ?'); params.push(Number(salesmanId)); }
    if (status) { where.push(`m.status IN (${status.split(',').map(() => '?').join(',')})`); params.push(...status.split(',')); }
    if (from) { where.push('date(m.scheduled_at) >= ?'); params.push(from); }
    if (to) { where.push('date(m.scheduled_at) <= ?'); params.push(to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    res.json(
      await db
        .prepare(
          `SELECT m.*, c.name AS company_name, c.area, c.contact_name, c.contact_title, c.phone_e164,
                  s.name AS salesman_name, f.id AS feedback_id, f.outcome
             FROM meeting m
             JOIN company  c ON c.id = m.company_id
             JOIN salesman s ON s.id = m.salesman_id
        LEFT JOIN feedback f ON f.meeting_id = m.id
             ${clause}
             ORDER BY m.scheduled_at DESC LIMIT 300`,
        )
        .all(...params),
    );
  }),
);

// Most meetings are in-person visits, so 'onsite' is the default — but a call
// or video call is still possible and Odoo's calendar.event models the same.
const meetingInput = z.object({
  assignmentId: z.number().int().nullable().optional(),
  companyId: z.number().int(),
  salesmanId: z.number().int(),
  scheduledAt: z.string().min(4),
  durationMin: z.number().int().min(5).max(480).default(30),
  mode: z.enum(['onsite', 'call', 'video']).default('onsite'),
  location: z.string().nullable().optional(),
  notifyContact: z.boolean().default(true),
  /** The salesman confirms the time was agreed with the contact, not guessed. */
  agreedWithContact: z.boolean().default(false),
});

workRouter.post(
  '/meetings',
  asyncRoute(async (req, res) => {
    const input = parseBody(meetingInput, req.body);
    const company = await db.prepare('SELECT * FROM company WHERE id = ?').get(input.companyId) as any;
    if (!company) throw new HttpError(404, 'Company not found');

    const provider = await (await activeProvider()).createEvent(input);

    const id = await tx(async () => {
      const r = await db
        .prepare(
          `INSERT INTO meeting (assignment_id, company_id, salesman_id, scheduled_at, duration_min, mode, location,
                                provider, provider_event_id, booking_url, agreed_with_contact)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.assignmentId ?? null,
          input.companyId,
          input.salesmanId,
          input.scheduledAt,
          input.durationMin,
          input.mode,
          input.location ?? company.area ?? null,
          provider.provider,
          provider.providerEventId,
          provider.bookingUrl,
          input.agreedWithContact ? 1 : 0,
        );
      const mid = Number(r.lastInsertRowid);
      if (input.assignmentId) {
        await db.prepare(`UPDATE assignment SET status = 'meeting_set', updated_at = datetime('now') WHERE id = ?`).run(input.assignmentId);
      }
      await setStage(input.companyId, 'meeting_scheduled', { salesmanId: input.salesmanId, actor: 'salesman' });
      await logActivity({
        companyId: input.companyId,
        salesmanId: input.salesmanId,
        kind: 'meeting_scheduled',
        summary:
          `Visit set for ${new Date(input.scheduledAt).toLocaleString('en-PK')}` +
          (input.agreedWithContact ? ' — time agreed with the contact' : ' — time not yet confirmed with the contact'),
        detail: { meetingId: mid, provider: provider.provider, agreedWithContact: input.agreedWithContact },
        actor: 'salesman',
      });
      return mid;
    });

    // Google first: when it succeeds the salesman's own calendar handles the
    // reminders, and the .ics email below is just belt and braces.
    const google = await pushMeeting(id);

    await sendSalesmanInvite(id);
    await notifyManagers(id);
    if (input.notifyContact) await inviteContact(id);

    res.status(201).json({ ...(await db.prepare('SELECT * FROM meeting WHERE id = ?').get(id) as object), google });
  }),
);

async function meetingRow(meetingId: number) {
  return await db
    .prepare(
      `SELECT m.*, c.name AS company_name, c.area, c.contact_name, c.contact_title,
              c.phone_e164, c.email, s.name AS salesman_name, s.email AS salesman_email,
              s.phone_e164 AS salesman_phone
         FROM meeting m JOIN company c ON c.id = m.company_id JOIN salesman s ON s.id = m.salesman_id
        WHERE m.id = ?`,
    )
    .get(meetingId) as any;
}

function whenLabel(iso: string) {
  return new Date(iso).toLocaleString('en-PK', {
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
}

async function calendarAttachment(meetingId: number, method: 'REQUEST' | 'CANCEL' = 'REQUEST') {
  const ics = await icsForMeeting(meetingId, { method });
  if (!ics) return undefined;
  return [{
    filename: method === 'CANCEL' ? 'cancelled.ics' : 'invite.ics',
    content: ics,
    contentType: `text/calendar; charset=utf-8; method=${method}`,
  }];
}

/**
 * The salesman's own calendar entry. The .ics is what carries the reminders
 * onto their phone — the in-app nudges are only a backstop for anyone who
 * never adds it.
 */
async function sendSalesmanInvite(meetingId: number, method: 'REQUEST' | 'CANCEL' = 'REQUEST') {
  const m = await meetingRow(meetingId);
  if (!m?.salesman_email) return;

  const verb = m.mode === 'onsite' ? 'Visit' : m.mode === 'call' ? 'Call' : 'Video call';
  await notify({
    channel: 'email',
    template: method === 'CANCEL' ? 'salesman_meeting_cancelled' : 'salesman_meeting_invite',
    recipientType: 'salesman',
    recipientId: m.salesman_id,
    toAddr: m.salesman_email,
    subject:
      method === 'CANCEL'
        ? `Cancelled — ${m.company_name} on ${whenLabel(m.scheduled_at)}`
        : `${verb}: ${m.company_name} — ${whenLabel(m.scheduled_at)}`,
    body:
      method === 'CANCEL'
        ? `The meeting with ${m.company_name} on ${whenLabel(m.scheduled_at)} has been cancelled and removed from your calendar.`
        : `${verb} with ${m.company_name} on ${whenLabel(m.scheduled_at)}.\n\n` +
          `Where: ${m.location || m.area || 'their office'}\n` +
          `Who: ${[m.contact_title, m.contact_name].filter(Boolean).join(' ') || 'contact not recorded'}` +
          `${m.phone_e164 ? ` (${m.phone_e164})` : ''}\n\n` +
          `Add the attached invite to your calendar — it carries its own reminders.`,
    payload: { meetingId },
    attachments: await calendarAttachment(meetingId, method),
    email:
      method === 'CANCEL'
        ? {
            kicker: 'Meeting cancelled',
            heading: `${m.company_name} — cancelled`,
            intro: `The meeting on ${whenLabel(m.scheduled_at)} is off, and has been removed from your calendar.`,
          }
        : {
            kicker: `${verb} scheduled`,
            heading: m.company_name,
            intro: 'This is on your calendar. The attached invite carries its own reminders.',
            details: [
              { label: 'When', value: whenLabel(m.scheduled_at), strong: true },
              { label: 'Where', value: m.location || m.area || 'their office' },
              {
                label: 'Who',
                value:
                  ([m.contact_title, m.contact_name].filter(Boolean).join(' ') || 'contact not recorded') +
                  (m.phone_e164 ? ` · ${m.phone_e164}` : ''),
              },
            ],
            footnote: 'Log the outcome in the app afterwards so the deal keeps moving.',
          },
  });
}

/**
 * The sales manager is told a meeting exists and gets it on their calendar,
 * but is deliberately NOT put on the reminder path — they oversee the pipeline,
 * they are not the one who has to show up. So: one notification at booking, an
 * .ics with no alarms, and nothing from the reminder sweep.
 */
async function notifyManagers(meetingId: number, method: 'REQUEST' | 'CANCEL' = 'REQUEST') {
  const m = await meetingRow(meetingId);
  if (!m) return;

  const managers = await db.prepare(`SELECT * FROM salesman WHERE role = 'manager' AND active = 1`).all() as any[];
  const title = `${m.salesman_name} × ${m.company_name}`;

  for (const mgr of managers) {
    await notify({
      channel: 'inapp',
      template: method === 'CANCEL' ? 'manager_meeting_cancelled' : 'manager_meeting_booked',
      recipientType: 'manager',
      recipientId: mgr.id,
      subject: method === 'CANCEL' ? `Cancelled — ${title}` : `Meeting booked — ${title}`,
      body:
        `${title}\n${whenLabel(m.scheduled_at)}` +
        `${m.location || m.area ? ` · ${m.location || m.area}` : ''}` +
        `${method === 'CANCEL' ? '\n\nThis meeting has been cancelled.' : ''}`,
      payload: { meetingId, salesman: m.salesman_name, company: m.company_name },
    });

    if (mgr.email) {
      await notify({
        channel: 'email',
        template: method === 'CANCEL' ? 'manager_meeting_cancelled' : 'manager_meeting_booked',
        recipientType: 'manager',
        recipientId: mgr.id,
        toAddr: mgr.email,
        subject: `${method === 'CANCEL' ? 'Cancelled' : 'Meeting'} — ${title}`,
        body: `${title}\n${whenLabel(m.scheduled_at)}\n\nAdded to your calendar for visibility. You will not be reminded about it.`,
        payload: { meetingId },
        email: {
          kicker: method === 'CANCEL' ? 'Meeting cancelled' : 'Meeting booked',
          heading: title,
          intro:
            method === 'CANCEL'
              ? 'This meeting has been cancelled and removed from your calendar.'
              : 'Added to your calendar so you can see it. You will not be sent reminders for it.',
          details: [
            { label: 'When', value: whenLabel(m.scheduled_at), strong: true },
            ...(m.location || m.area ? [{ label: 'Where', value: m.location || m.area }] : []),
            { label: 'Salesman', value: m.salesman_name },
            { label: 'Company', value: m.company_name },
          ],
        },
        // No alarms: it shows on the manager's calendar without nagging them.
        attachments: await (async () => {
          const ics = await icsForMeeting(meetingId, { method, alarms: [] });
          return ics
            ? [{ filename: 'meeting.ics', content: ics, contentType: `text/calendar; charset=utf-8; method=${method}` }]
            : undefined;
        })(),
      });
    }
  }
}

/**
 * Invite the company's contact. 97.8% of imported companies have no email, so
 * WhatsApp is the primary path and email is the exception — not the reverse.
 */
async function inviteContact(meetingId: number) {
  const m = await db
    .prepare(
      `SELECT m.*, c.name AS company_name, c.contact_name, c.contact_title, c.phone_e164, c.email,
              s.name AS salesman_name, s.phone_e164 AS salesman_phone
         FROM meeting m JOIN company c ON c.id = m.company_id JOIN salesman s ON s.id = m.salesman_id
        WHERE m.id = ?`,
    )
    .get(meetingId) as any;
  if (!m) return;

  const when = new Date(m.scheduled_at).toLocaleString('en-PK', {
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
  const greeting = [m.contact_title, m.contact_name].filter(Boolean).join(' ') || 'Sir/Madam';
  // A booking link only helps if it can actually be opened, so include it only
  // when the active provider produced one.
  const reschedule = m.booking_url
    ? `\n\nNeed a different time? Pick one here:\n${m.booking_url}`
    : '\n\nPlease let us know if another time suits you better.';

  const body =
    `Assalam-o-Alaikum ${greeting},\n\n` +
    `This is to confirm our meeting regarding ${m.company_name} on ${when}` +
    `${m.location ? ` at ${m.location}` : ''}.\n\n` +
    `${m.salesman_name} from SynChem will be attending${m.salesman_phone ? ` (${m.salesman_phone})` : ''}.` +
    reschedule;

  let reached = false;
  if (m.phone_e164) {
    await notify({
      channel: 'whatsapp', template: 'contact_meeting_invite', recipientType: 'contact',
      recipientId: m.company_id, toAddr: m.phone_e164, body, payload: { meetingId },
    });
    reached = true;
  }
  if (m.email) {
    const verb = (m.mode ?? 'onsite') === 'onsite' ? 'Visit' : m.mode === 'call' ? 'Call' : 'Video call';
    await notify({
      channel: 'email', template: 'contact_meeting_invite', recipientType: 'contact',
      recipientId: m.company_id, toAddr: m.email, subject: `Meeting confirmation — ${when}`, body,
      payload: { meetingId },
      attachments: await calendarAttachment(meetingId),
      email: {
        kicker: 'Meeting confirmation',
        heading: `Assalam-o-Alaikum ${greeting}`,
        intro: `This confirms our meeting regarding ${m.company_name}. The details are below — the invite attached to this email will add it to your calendar.`,
        details: [
          { label: 'When', value: when, strong: true },
          ...(m.location || m.area ? [{ label: 'Where', value: m.location || m.area }] : []),
          { label: 'Type', value: verb === 'Visit' ? 'In-person visit' : verb },
          {
            label: 'Attending',
            value: `${m.salesman_name}, SynChem Global${m.salesman_phone ? ` · ${m.salesman_phone}` : ''}`,
          },
        ],
        paragraphs: m.booking_url
          ? ['If another time suits you better, you can pick one directly:']
          : ['Please let us know if another time would suit you better.'],
        ...(m.booking_url ? { cta: { label: 'Choose a different time', url: m.booking_url } } : {}),
        footnote: 'Reply to this email to reach us directly.',
      },
    });
    reached = true;
  }

  if (reached) {
    await db.prepare(`UPDATE meeting SET contact_notified_at = datetime('now') WHERE id = ?`).run(meetingId);
  } else {
    await logActivity({
      companyId: m.company_id, salesmanId: m.salesman_id, kind: 'note',
      summary: 'Could not invite the contact — no phone and no email on file',
    });
  }
}

workRouter.post('/meetings/:id/invite', asyncRoute(async (req, res) => {
  await inviteContact(intParam(req.params.id));
  res.json(await db.prepare('SELECT * FROM meeting WHERE id = ?').get(intParam(req.params.id)));
}));

workRouter.patch(
  '/meetings/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(
      z.object({
        scheduledAt: z.string().optional(),
        durationMin: z.number().int().optional(),
        mode: z.enum(['onsite', 'call', 'video']).optional(),
        location: z.string().nullable().optional(),
        status: z.enum(['proposed', 'scheduled', 'held', 'no_show', 'cancelled', 'rescheduled']).optional(),
        actorId: z.number().int().optional(),
      }),
      req.body,
    );
    const before = await db.prepare('SELECT * FROM meeting WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Meeting not found');

    await db.prepare(
      `UPDATE meeting SET scheduled_at = COALESCE(?, scheduled_at), duration_min = COALESCE(?, duration_min),
              mode = COALESCE(?, mode), location = COALESCE(?, location), status = COALESCE(?, status),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(patch.scheduledAt ?? null, patch.durationMin ?? null, patch.mode ?? null, patch.location ?? null, patch.status ?? null, id);

    if (patch.status === 'held') await setStage(before.company_id, 'met', { salesmanId: before.salesman_id, actor: 'salesman' });

    const after = await db.prepare('SELECT * FROM meeting WHERE id = ?').get(id) as any;
    await recordRevision('meeting', id, before, after, patch.actorId);
    await logActivity({
      companyId: before.company_id, salesmanId: before.salesman_id, kind: 'meeting_scheduled',
      summary: patch.status ? `Meeting marked ${patch.status}` : 'Meeting details updated', actor: 'salesman',
    });

    // Keep everyone's calendar honest. A moved meeting re-sends the same UID at
    // a higher SEQUENCE so it updates in place; a cancelled one is withdrawn.
    const moved = Boolean(patch.scheduledAt && patch.scheduledAt !== before.scheduled_at)
      || Boolean(patch.durationMin && patch.durationMin !== before.duration_min)
      || Boolean(patch.location && patch.location !== before.location);
    const cancelled = patch.status === 'cancelled' && before.status !== 'cancelled';

    if (moved || cancelled) {
      await bumpIcsSequence(id);
      const method = cancelled ? 'CANCEL' : 'REQUEST';
      // A reschedule invalidates reminders already sent for the old time.
      if (moved && !cancelled) {
        await db.prepare(`UPDATE meeting SET reminded_day_before_at = NULL, reminded_hours_before_at = NULL WHERE id = ?`).run(id);
      }
      // Same event id on Google, so it moves rather than duplicating.
      if (cancelled) await removeMeeting(id);
      else await pushMeeting(id);

      await sendSalesmanInvite(id, method);
      await notifyManagers(id, method);
      if (!cancelled) await inviteContact(id);
    }

    res.json(await db.prepare('SELECT * FROM meeting WHERE id = ?').get(id));
  }),
);

/** Download the calendar entry directly — useful when email is not configured. */
workRouter.get(
  '/meetings/:id/calendar.ics',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const ics = await icsForMeeting(id);
    if (!ics) throw new HttpError(404, 'Meeting not found');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="synchem-meeting-${id}.ics"`);
    res.send(ics);
  }),
);

/* -------------------------------------------------------------- feedback */

const feedbackInput = z.object({
  meetingId: z.number().int(),
  outcome: z.enum(['positive', 'approved', 'rejected']),
  reasonCode: z.string().nullable().optional(),
  reasonNote: z.string().nullable().optional(),
  sampleRequested: z.boolean().default(false),
  sampleLines: z.array(z.object({ productId: z.number().int(), qty: z.number().positive() })).default([]),
  dealValue: z.number().nonnegative().nullable().optional(),
  nextStepOn: z.string().nullable().optional(),
  metContact: z.string().nullable().optional(),
  actorId: z.number().int().optional(),
});

/** Create-or-update: the same endpoint handles the first entry and every edit. */
workRouter.post(
  '/feedback',
  asyncRoute(async (req, res) => {
    const input = parseBody(feedbackInput, req.body);
    const meeting = await db.prepare('SELECT * FROM meeting WHERE id = ?').get(input.meetingId) as any;
    if (!meeting) throw new HttpError(404, 'Meeting not found');

    const before = await db.prepare('SELECT * FROM feedback WHERE meeting_id = ?').get(input.meetingId) as any;

    const feedbackId = await tx(async () => {
      let fid: number;
      if (before) {
        fid = before.id;
        await db.prepare(
          `UPDATE feedback SET outcome = ?, reason_code = ?, reason_note = ?, sample_requested = ?,
                  deal_value = ?, next_step_on = ?, met_contact = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(
          input.outcome, input.reasonCode ?? null, input.reasonNote ?? null, input.sampleRequested ? 1 : 0,
          input.dealValue ?? null, input.nextStepOn ?? null, input.metContact ?? null, fid,
        );
      } else {
        const r = await db
          .prepare(
            `INSERT INTO feedback (meeting_id, company_id, salesman_id, outcome, reason_code, reason_note,
                                   sample_requested, deal_value, next_step_on, met_contact)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.meetingId, meeting.company_id, meeting.salesman_id, input.outcome, input.reasonCode ?? null,
            input.reasonNote ?? null, input.sampleRequested ? 1 : 0, input.dealValue ?? null,
            input.nextStepOn ?? null, input.metContact ?? null,
          );
        fid = Number(r.lastInsertRowid);
      }

      await db.prepare(`UPDATE meeting SET status = 'held', updated_at = datetime('now') WHERE id = ? AND status IN ('proposed','scheduled')`).run(input.meetingId);
      if (meeting.assignment_id) {
        await db.prepare(`UPDATE assignment SET status = 'completed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(meeting.assignment_id);
      }

      if (input.sampleRequested && input.sampleLines.length) {
        await createOrReplaceSampleRequest({
          feedbackId: fid, companyId: meeting.company_id, salesmanId: meeting.salesman_id, lines: input.sampleLines,
        });
      } else {
        await deleteSampleRequestForFeedback(fid);
      }

      // Outcome drives the stage; approved is finished by syncInvoiceForFeedback.
      if (input.outcome === 'rejected') await setStage(meeting.company_id, 'lost', { force: true, actor: 'salesman', salesmanId: meeting.salesman_id });
      else if (input.outcome === 'positive') await setStage(meeting.company_id, input.sampleRequested ? 'sample_sent' : 'negotiating', { actor: 'salesman', salesmanId: meeting.salesman_id });

      await db.prepare(
        `UPDATE company SET follow_up_on = ?, last_touched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(input.nextStepOn ?? null, meeting.company_id);

      await logActivity({
        companyId: meeting.company_id, salesmanId: meeting.salesman_id, kind: 'feedback',
        summary: before ? `Feedback edited — ${input.outcome}` : `Meeting outcome logged — ${input.outcome}`,
        detail: input, actor: 'salesman',
      });
      return fid;
    });

    const invoiceId = await syncInvoiceForFeedback(feedbackId);
    const after = await db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId);
    await recordRevision('feedback', feedbackId, before ?? null, after, input.actorId);

    res.status(before ? 200 : 201).json({ ...(after as object), invoiceId, edited: Boolean(before) });
  }),
);

workRouter.get(
  '/feedback/:meetingId',
  asyncRoute(async (req, res) => {
    const meetingId = intParam(req.params.meetingId, 'meetingId');
    const f = await db.prepare('SELECT * FROM feedback WHERE meeting_id = ?').get(meetingId) as any;
    if (!f) { res.json(null); return; }
    f.sampleLines = await db
      .prepare(
        `SELECT sl.product_id AS productId, sl.qty, p.name, p.uom, p.sku
           FROM sample_line sl JOIN product p ON p.id = sl.product_id
           JOIN sample_request sr ON sr.id = sl.sample_request_id
          WHERE sr.feedback_id = ?`,
      )
      .all(f.id);
    f.invoice = await db.prepare('SELECT * FROM invoice WHERE feedback_id = ?').get(f.id) ?? null;
    f.revisions = await db.prepare(`SELECT id, created_at FROM revision WHERE entity = 'feedback' AND entity_id = ? ORDER BY id DESC`).all(f.id);
    res.json(f);
  }),
);

workRouter.get(
  '/reason-codes',
  asyncRoute(async (_req, res) => {
    res.json(await db.prepare('SELECT * FROM reason_code WHERE active = 1 ORDER BY outcome, sort, label').all());
  }),
);

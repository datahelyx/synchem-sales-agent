import { db, tx } from '../db/index.js';
import { addDays, today, weekLabel, weekStart } from '../lib/dates.js';
import { prettyPhone } from '../lib/normalize.js';
import { notify } from '../services/notifier.js';
import { logActivity, setStage } from '../services/pipeline.js';

/**
 * The weekly assignment run. This is the agent's main job: every Monday give
 * each active salesman their quota (2 by default) of companies to work.
 *
 * Selection is deliberately explainable — the manager can see *why* each
 * company was picked, because a black box that hands out leads is not something
 * a sales team will trust. Priority, highest first:
 *
 *   1. Follow-ups that are due (a past meeting said "come back on this date").
 *   2. Companies already owned by that salesman and still mid-pipeline.
 *   3. Fresh companies, best contact data first, never-assigned before
 *      previously-assigned, with the salesman's preferred areas nudged up.
 *
 * Companies that are won, lost, do-not-contact, or already assigned to anyone
 * in the same week are out of the running.
 */

export interface AssignmentPick {
  companyId: number;
  companyName: string;
  reason: string;
  priority: number;
}

const DEAD_STAGES = `('won','lost')`;

/**
 * Industries the business actually sells to. Without this the ranking is pure
 * data-completeness and the agent cheerfully hands a chemicals rep two banks —
 * they have tidy contact details and zero use for solvents. Editable from
 * Settings, because who you target is a business decision, not a constant.
 */
const DEFAULT_TARGET_INDUSTRIES = [
  'Textiles & Apparel',
  'Chemicals',
  'Pharma & Healthcare',
  'Food & Beverage',
  'Plastics & Polymers',
  'Packaging & Printing',
  'Cosmetics & Detergents',
  'Leather & Footwear',
  'Paper & Board',
  'Water Treatment',
  'Cotton & Ginning',
  'Agriculture',
  'General Manufacturing',
].join(',');

async function targetIndustries(): Promise<string[]> {
  const row = await db.prepare(`SELECT value FROM setting WHERE key = 'target_industries'`).get() as any;
  return (row?.value ?? DEFAULT_TARGET_INDUSTRIES)
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
}

async function candidatesFor(salesmanId: number, week: string, excludeIds: number[]) {
  const excl = excludeIds.length ? `AND c.id NOT IN (${excludeIds.join(',')})` : '';
  const areas = ((await db.prepare('SELECT areas FROM salesman WHERE id = ?').get(salesmanId) as any)?.areas ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const areaCase = areas.length
    ? `CASE WHEN c.area IN (${areas.map(() => '?').join(',')}) THEN 15 ELSE 0 END`
    : '0';

  // A company we sell to beats a tidy record we do not. An unknown industry
  // sits between the two — 3,153 companies have none, and skipping them all
  // would shrink the pool to a third of the file.
  const targets = await targetIndustries();
  const fitCase = targets.length
    ? `CASE WHEN c.industry IN (${targets.map(() => '?').join(',')}) THEN 120
             WHEN c.industry IS NULL THEN 30
             ELSE 0 END`
    : '0';

  /*
   * Every parameter here is positional.
   *
   * The area and industry lists are variable-length, so they have to be `?`.
   * Mixing those with named parameters is what SQLite's own bindings allow but
   * libSQL does not — and it does not complain, it just returns nothing. So
   * the whole statement uses `?`, and `args` below is built in SQL order.
   */
  const day = today();
  const args: unknown[] = [
    day,            // follow_up_on <= ?          (priority)
    salesmanId,     // owner_id = ?               (priority)
    ...areas,       // area IN (…)
    ...targets,     // industry IN (…)
    salesmanId,     // owner_id IS NULL OR owner_id = ?
    day,            // follow_up_on <= ?          (filter)
    week,           // assignment.week_start = ?
  ];

  const sql = `
    SELECT
      c.id, c.name, c.area, c.industry, c.stage, c.follow_up_on, c.owner_id,
      c.data_quality, c.times_assigned, c.last_assigned_on,
      (
        CASE WHEN c.follow_up_on IS NOT NULL AND c.follow_up_on <= ? THEN 1000 ELSE 0 END
        + CASE WHEN c.owner_id = ? AND c.stage NOT IN ('new','assigned') THEN 400 ELSE 0 END
        + CASE WHEN c.owner_id IS NULL THEN 60 ELSE 0 END
        + CASE WHEN c.times_assigned = 0 THEN 80 ELSE 0 END
        + c.data_quality
        + ${areaCase}
        + ${fitCase}
      ) AS priority
    FROM company c
    WHERE c.do_not_contact = 0
      AND c.stage NOT IN ${DEAD_STAGES}
      AND (c.owner_id IS NULL OR c.owner_id = ?)
      AND (c.follow_up_on IS NULL OR c.follow_up_on <= ? OR c.stage = 'new')
      AND NOT EXISTS (
        SELECT 1 FROM assignment a WHERE a.company_id = c.id AND a.week_start = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM assignment a
         WHERE a.company_id = c.id AND a.status IN ('pending','in_progress','meeting_set')
      )
      ${excl}
    ORDER BY priority DESC, c.data_quality DESC, c.id ASC
    LIMIT 40
  `;

  return (await db.prepare(sql).all(...args)) as any[];
}

async function explain(row: any, salesmanId: number): Promise<string> {
  if (row.follow_up_on && row.follow_up_on <= today()) return `Follow-up was due ${row.follow_up_on}`;
  if (row.owner_id === salesmanId) return `Already yours, currently at "${row.stage}"`;
  const bits: string[] = [];
  if (row.industry && (await targetIndustries()).includes(row.industry)) bits.push(`${row.industry.toLowerCase()} — a target industry`);
  else if (row.industry) bits.push(row.industry.toLowerCase());
  else bits.push('industry not recorded');
  if (row.times_assigned === 0) bits.push('never contacted');
  if (row.data_quality >= 80) bits.push('complete contact details');
  else if (row.data_quality >= 60) bits.push('has a phone and a named contact');
  if (row.area) bits.push(row.area);
  return `New lead — ${bits.join(', ')}`;
}

export interface RunOptions {
  week?: string;
  trigger?: 'manual' | 'cron';
  salesmanIds?: number[];
  /** Re-running a week tops salesmen up to quota rather than duplicating. */
  notifySalesmen?: boolean;
}

export async function runWeeklyAssignment(opts: RunOptions = {}) {
  const week = opts.week ?? weekStart();
  const trigger = opts.trigger ?? 'manual';

  const salesmen = (
    opts.salesmanIds?.length
      ? await db
          .prepare(
            `SELECT * FROM salesman WHERE active = 1 AND role = 'salesman' AND id IN (${opts.salesmanIds.join(',')})`,
          )
          .all()
      : await db.prepare(`SELECT * FROM salesman WHERE active = 1 AND role = 'salesman' ORDER BY id`).all()
  ) as any[];

  const results: Array<{ salesmanId: number; salesman: string; picks: AssignmentPick[]; already: number; short: number }> = [];
  // Companies claimed earlier in this same run, so two salesmen never collide.
  const claimed: number[] = [];
  let created = 0;

  for (const s of salesmen) {
    const already = (
      await db.prepare(`SELECT COUNT(*) AS n FROM assignment WHERE salesman_id = ? AND week_start = ?`).get(s.id, week) as any
    ).n as number;
    const need = Math.max(0, (s.weekly_quota ?? 2) - already);

    const picks: AssignmentPick[] = [];
    if (need > 0) {
      const rows = await candidatesFor(s.id, week, claimed);
      for (const row of rows.slice(0, need)) {
        picks.push({ companyId: row.id, companyName: row.name, reason: await explain(row, s.id), priority: row.priority });
        claimed.push(row.id);
      }
    }

    await tx(async () => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO assignment (company_id, salesman_id, week_start, reason) VALUES (?, ?, ?, ?)`,
      );
      for (const p of picks) {
        const r = await ins.run(p.companyId, s.id, week, p.reason);
        if (r.changes === 0) continue;
        created++;
        await db.prepare(
          `UPDATE company
              SET owner_id = COALESCE(owner_id, ?),
                  times_assigned = times_assigned + 1,
                  last_assigned_on = ?,
                  follow_up_on = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(s.id, week, p.companyId);
        await setStage(p.companyId, 'assigned', { salesmanId: s.id });
        await logActivity({
          companyId: p.companyId,
          salesmanId: s.id,
          kind: 'assigned',
          summary: `Assigned to ${s.name} for the week of ${weekLabel(week)}`,
          detail: { reason: p.reason, week },
        });
      }
    });

    results.push({
      salesmanId: s.id,
      salesman: s.name,
      picks,
      already,
      short: Math.max(0, need - picks.length),
    });
  }

  let notified = 0;
  if (opts.notifySalesmen !== false) {
    for (const r of results) {
      if (!r.picks.length) continue;
      const s = salesmen.find((x) => x.id === r.salesmanId)!;
      const body = await buildAssignmentMessage(s.name, week, r.picks);
      await notify({
        channel: 'inapp',
        template: 'weekly_assignment',
        recipientType: 'salesman',
        recipientId: s.id,
        subject: `Your companies for ${weekLabel(week)}`,
        body,
        payload: { week, picks: r.picks },
      });
      notified++;
      if (s.phone_e164) {
        await notify({
          channel: 'whatsapp',
          template: 'weekly_assignment',
          recipientType: 'salesman',
          recipientId: s.id,
          toAddr: s.phone_e164,
          body,
          payload: { week },
        });
      }
    }
  }

  const skipped = results.reduce((n, r) => n + r.short, 0);
  await db.prepare(
    `INSERT INTO agent_run (kind, week_start, trigger, created, skipped, notified, detail_json)
     VALUES ('weekly_assignment', ?, ?, ?, ?, ?, ?)`,
  ).run(week, trigger, created, skipped, notified, JSON.stringify(results));

  return { week, weekLabel: weekLabel(week), created, skipped, notified, results };
}

async function buildAssignmentMessage(name: string, week: string, picks: AssignmentPick[]): Promise<string> {
  // Each line needs a database read, so the whole list is resolved before it is
  // joined — mapping to promises and joining them straight away renders every
  // company as "[object Promise]".
  const lines = await Promise.all(
    picks.map(async (p, i) => {
      const c = await db.prepare('SELECT * FROM company WHERE id = ?').get(p.companyId) as any;
      if (!c) return `${i + 1}. (company removed)\n   Why you: ${p.reason}`;
      const who = [c.contact_title, c.contact_name].filter(Boolean).join(' ');
      const detail = [who && `contact ${who}`, c.phone_e164 && prettyPhone(c.phone_e164), c.area, c.industry]
        .filter(Boolean)
        .join(' · ');
      return `${i + 1}. ${c.name}\n   ${detail}\n   Why you: ${p.reason}`;
    }),
  );
  return [
    `Hi ${name.split(' ')[0]}, here are your ${picks.length} companies for ${weekLabel(week)}:`,
    '',
    ...lines,
    '',
    'Open the app to book a meeting or log what happened.',
  ].join('\n');
}

/**
 * Reminder sweep, driven by each meeting's own time rather than a fixed daily
 * digest. Runs every 15 minutes; each meeting gets:
 *
 *   - one reminder about a day ahead, so the visit can still be rearranged
 *   - one about two hours ahead, because these are physical visits across
 *     Lahore and the salesman needs to leave in time
 *
 * The `reminded_*_at` columns make it idempotent — a meeting is reminded once
 * per window no matter how often the sweep runs.
 */
const DAY_BEFORE_HOURS = Number(process.env.REMIND_DAY_BEFORE_HOURS ?? 24);
const HOURS_BEFORE = Number(process.env.REMIND_HOURS_BEFORE ?? 2);

async function meetingsDueForReminder(column: string, withinHours: number) {
  return await db
    .prepare(
      `SELECT m.*, c.name AS company_name, c.area, c.contact_name, c.contact_title,
              c.phone_e164, c.email, s.name AS salesman_name, s.phone_e164 AS salesman_phone
         FROM meeting m
         JOIN company  c ON c.id = m.company_id
         JOIN salesman s ON s.id = m.salesman_id
        WHERE m.status = 'scheduled'
          AND m.${column} IS NULL
          AND datetime(m.scheduled_at) > datetime('now')
          AND datetime(m.scheduled_at) <= datetime('now', '+${withinHours} hours')`,
    )
    .all() as any[];
}

function meetingTimeLabel(iso: string) {
  return new Date(iso).toLocaleString('en-PK', {
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
}

export async function runReminderSweep(trigger: 'manual' | 'cron' = 'manual') {
  let notified = 0;

  // --- a day ahead: salesman and, where reachable, the contact --------------
  for (const m of await meetingsDueForReminder('reminded_day_before_at', DAY_BEFORE_HOURS)) {
    const who = [m.contact_title, m.contact_name].filter(Boolean).join(' ') || 'the contact';
    const place = m.location || m.area || 'their office';

    await notify({
      channel: 'inapp',
      template: 'meeting_reminder_day_before',
      recipientType: 'salesman',
      recipientId: m.salesman_id,
      subject: `Tomorrow: visit ${m.company_name}`,
      body:
        `You are visiting ${m.company_name} on ${meetingTimeLabel(m.scheduled_at)}.\n\n` +
        `Where: ${place}\nWho: ${who}${m.phone_e164 ? ` (${m.phone_e164})` : ''}\n\n` +
        `If the time no longer suits either side, agree a new one and update it in the app.`,
      payload: { meetingId: m.id },
    });
    notified++;

    if (m.phone_e164) {
      await notify({
        channel: 'whatsapp',
        template: 'meeting_reminder_day_before',
        recipientType: 'contact',
        recipientId: m.company_id,
        toAddr: m.phone_e164,
        body:
          `Assalam-o-Alaikum ${who}, a reminder of our meeting at ${m.company_name} on ` +
          `${meetingTimeLabel(m.scheduled_at)}. ${m.salesman_name} from SynChem will be visiting. ` +
          `Please let us know if another time suits you better.`,
        payload: { meetingId: m.id },
      });
    }
    if (m.email) {
      await notify({
        channel: 'email',
        template: 'meeting_reminder_day_before',
        recipientType: 'contact',
        recipientId: m.company_id,
        toAddr: m.email,
        subject: `Reminder — meeting on ${meetingTimeLabel(m.scheduled_at)}`,
        body:
          `Assalam-o-Alaikum ${who},\n\nA reminder of our meeting at ${m.company_name} on ` +
          `${meetingTimeLabel(m.scheduled_at)}.\n\n${m.salesman_name} from SynChem will be visiting` +
          `${m.salesman_phone ? ` (${m.salesman_phone})` : ''}.\n\n` +
          `Please let us know if another time suits you better.`,
        payload: { meetingId: m.id },
      });
    }

    await db.prepare(`UPDATE meeting SET reminded_day_before_at = datetime('now') WHERE id = ?`).run(m.id);
  }

  // --- a couple of hours ahead: salesman only, time to set off --------------
  for (const m of await meetingsDueForReminder('reminded_hours_before_at', HOURS_BEFORE)) {
    const place = m.location || m.area || 'their office';
    await notify({
      channel: 'inapp',
      template: 'meeting_reminder_soon',
      recipientType: 'salesman',
      recipientId: m.salesman_id,
      subject: `Soon: ${m.company_name}`,
      body:
        `${m.company_name} at ${new Date(m.scheduled_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}` +
        ` — ${place}. Time to set off.`,
      payload: { meetingId: m.id },
    });
    notified++;
    await db.prepare(`UPDATE meeting SET reminded_hours_before_at = datetime('now') WHERE id = ?`).run(m.id);
  }

  const overdue = await db
    .prepare(
      `SELECT m.*, c.name AS company_name
         FROM meeting m
         JOIN company c ON c.id = m.company_id
    LEFT JOIN feedback f ON f.meeting_id = m.id
        WHERE m.status IN ('scheduled','held')
          AND datetime(m.scheduled_at) < datetime('now')
          AND f.id IS NULL`,
    )
    .all() as any[];

  for (const m of overdue) {
    await notify({
      channel: 'inapp',
      template: 'feedback_due',
      recipientType: 'salesman',
      recipientId: m.salesman_id,
      subject: `How did ${m.company_name} go?`,
      body: `Your meeting with ${m.company_name} has passed. Log the outcome so the deal can move forward — it takes about 20 seconds.`,
      payload: { meetingId: m.id },
    });
    notified++;
  }

  await db.prepare(
    `INSERT INTO agent_run (kind, trigger, created, skipped, notified, detail_json)
     VALUES ('reminder_sweep', ?, 0, 0, ?, ?)`,
  ).run(trigger, notified, JSON.stringify({ overdue: overdue.length, notified }));

  return { overdue: overdue.length, notified };
}

/**
 * Companies whose follow-up date has arrived get put back in the pool and, if
 * they have an owner, that owner hears about it.
 */
export async function runFollowUpSweep(trigger: 'manual' | 'cron' = 'manual') {
  const due = await db
    .prepare(
      `SELECT c.*, s.name AS owner_name
         FROM company c
    LEFT JOIN salesman s ON s.id = c.owner_id
        WHERE c.follow_up_on IS NOT NULL AND c.follow_up_on <= ?
          AND c.do_not_contact = 0 AND c.stage NOT IN ('won','lost')`,
    )
    .all(today()) as any[];

  let notified = 0;
  for (const c of due) {
    await logActivity({
      companyId: c.id,
      salesmanId: c.owner_id,
      kind: 'note',
      summary: `Follow-up due (${c.follow_up_on}) — back in the assignment pool`,
    });
    if (c.owner_id) {
      await notify({
        channel: 'inapp',
        template: 'followup_due',
        recipientType: 'salesman',
        recipientId: c.owner_id,
        subject: `Follow-up due: ${c.name}`,
        body: `${c.name} was marked for follow-up on ${c.follow_up_on}. It is back at the top of your list.`,
        payload: { companyId: c.id },
      });
      notified++;
    }
  }

  await db.prepare(
    `INSERT INTO agent_run (kind, trigger, created, skipped, notified, detail_json)
     VALUES ('follow_up_sweep', ?, 0, 0, ?, ?)`,
  ).run(trigger, notified, JSON.stringify({ due: due.length }));

  return { due: due.length, notified };
}

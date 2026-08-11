import { runFollowUpSweep, runReminderSweep, runWeeklyAssignment } from '../agent/assignment.js';
import { db, migrate } from '../db/index.js';
import { weekStart } from '../lib/dates.js';
import { syncInvoiceForFeedback } from '../services/commerce.js';
import { seedIfEmpty } from './seed-data.js';

/**
 * End-to-end exercise of the pipeline against whatever is in the database:
 * assign -> schedule -> feedback -> sample -> invoice. Safe to re-run.
 */

await migrate();
await seedIfEmpty();

const line = (s: string) => console.log(`\n=== ${s} ===`);

line('weekly assignment');
const run = await runWeeklyAssignment({ trigger: 'manual' });
console.log(`week ${run.weekLabel}: created ${run.created}, notified ${run.notified}, short ${run.skipped}`);
for (const r of run.results) {
  console.log(`  ${r.salesman}: ${r.picks.length} new (had ${r.already})`);
  for (const p of r.picks) console.log(`     - ${p.companyName}  [${p.reason}]`);
}

line('idempotency — running again must not double-assign');
const again = await runWeeklyAssignment({ trigger: 'manual' });
console.log(`created ${again.created} (expected 0)`);

line('schedule a meeting for the first assignment');
const first = await db
  .prepare(`SELECT a.*, c.name FROM assignment a JOIN company c ON c.id = a.company_id WHERE a.week_start = ? LIMIT 1`)
  .get(weekStart()) as any;

let meetingId: number | null = null;
if (first) {
  const when = new Date(Date.now() + 2 * 86400_000).toISOString();
  const r = await db
    .prepare(
      `INSERT INTO meeting (assignment_id, company_id, salesman_id, scheduled_at, duration_min, mode, status)
       VALUES (?, ?, ?, ?, 30, 'onsite', 'scheduled')`,
    )
    .run(first.id, first.company_id, first.salesman_id, when);
  meetingId = Number(r.lastInsertRowid);
  console.log(`meeting ${meetingId} for ${first.name} at ${when}`);
}

line('log approved feedback -> invoice should appear');
if (meetingId) {
  const m = await db.prepare('SELECT * FROM meeting WHERE id = ?').get(meetingId) as any;
  const fr = await db
    .prepare(
      `INSERT INTO feedback (meeting_id, company_id, salesman_id, outcome, reason_code, sample_requested, deal_value)
       VALUES (?, ?, ?, 'approved', 'trial_order', 1, 250000)
       ON CONFLICT(meeting_id) DO UPDATE SET outcome = 'approved', deal_value = 250000`,
    )
    .run(meetingId, m.company_id, m.salesman_id);
  const fid =
    Number(fr.lastInsertRowid) || (await db.prepare('SELECT id FROM feedback WHERE meeting_id = ?').get(meetingId) as any).id;

  const invId = await syncInvoiceForFeedback(fid);
  console.log('invoice:', await db.prepare('SELECT number, subtotal, total, status FROM invoice WHERE id = ?').get(invId as number));
  console.log('company stage:', await db.prepare('SELECT name, stage FROM company WHERE id = ?').get(m.company_id));

  line('flip the outcome to rejected — invoice must cancel, not vanish');
  await db.prepare(`UPDATE feedback SET outcome = 'rejected', reason_code = 'price_too_high' WHERE id = ?`).run(fid);
  await syncInvoiceForFeedback(fid);
  console.log('invoice now:', await db.prepare('SELECT number, status FROM invoice WHERE feedback_id = ?').get(fid));

  line('back to approved — must reuse the same invoice number');
  await db.prepare(`UPDATE feedback SET outcome = 'approved', deal_value = 300000 WHERE id = ?`).run(fid);
  await syncInvoiceForFeedback(fid);
  console.log('invoice now:', await db.prepare('SELECT number, subtotal, total, status FROM invoice WHERE feedback_id = ?').get(fid));
  console.log('invoice count for this feedback:', await db.prepare('SELECT COUNT(*) n FROM invoice WHERE feedback_id = ?').get(fid));
}

line('sweeps');
console.log('reminders:', await runReminderSweep('manual'));
console.log('follow-ups:', await runFollowUpSweep('manual'));

line('outbox');
console.log(await db.prepare('SELECT channel, status, COUNT(*) n FROM notification GROUP BY 1, 2').all());

line('stock after sample dispatch');
console.log(await db.prepare(`SELECT p.sku, p.stock_qty FROM product p JOIN stock_move sm ON sm.product_id = p.id
                        WHERE sm.reason = 'sample_dispatch' GROUP BY p.id LIMIT 5`).all());

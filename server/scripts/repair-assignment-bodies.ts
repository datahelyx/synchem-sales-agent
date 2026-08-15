import { db, migrate } from '../db/index.js';
import { buildAssignmentMessage } from '../agent/assignment.js';

/**
 * One-off repair for weekly assignment notifications that read
 * "[object Promise]" instead of the company list.
 *
 * An early version of the message builder joined un-awaited promises, so the
 * text was already wrong by the time it was stored. The builder was fixed, but
 * the rows written before that keep the broken text — the outbox stores the
 * final string, not a template. This regenerates the body from the assignment
 * rows the message was describing.
 *
 * Nothing is touched unless the body actually contains "[object Promise]".
 */

await migrate();

const broken = (await db
  .prepare(
    `SELECT n.id, n.recipient_id, n.body, s.name AS salesman_name
       FROM notification n
       LEFT JOIN salesman s ON s.id = n.recipient_id
      WHERE n.template = 'weekly_assignment'
        AND n.body LIKE '%[object Promise]%'`,
  )
  .all()) as Array<{ id: number; recipient_id: number; body: string; salesman_name: string | null }>;

if (!broken.length) {
  console.log('No weekly assignment messages need repair.');
} else {
  for (const row of broken) {
    // The week is named in the first line of the message the salesman received.
    const week = (await db
      .prepare(
        `SELECT week_start FROM assignment
          WHERE salesman_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.recipient_id)) as { week_start: string } | undefined;

    if (!week) {
      console.log(`notification ${row.id}: no assignments on record, left as is`);
      continue;
    }

    const picks = (await db
      .prepare(
        `SELECT company_id AS companyId, reason
           FROM assignment
          WHERE salesman_id = ? AND week_start = ?
          ORDER BY id`,
      )
      .all(row.recipient_id, week.week_start)) as Array<{ companyId: number; reason: string }>;

    if (!picks.length) {
      console.log(`notification ${row.id}: no assignments for ${week.week_start}, left as is`);
      continue;
    }

    const body = await buildAssignmentMessage(row.salesman_name ?? 'there', week.week_start, picks as any);
    await db.prepare(`UPDATE notification SET body = ? WHERE id = ?`).run(body, row.id);
    console.log(`notification ${row.id}: rebuilt with ${picks.length} companies`);
  }
}

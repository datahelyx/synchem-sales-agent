import { db, migrate } from '../db/index.js';

/**
 * One-off cleanup for the pile of identical "How did X go?" nudges.
 *
 * The reminder sweep runs every 15 minutes and, until `feedback_nudged_at`
 * existed, re-sent the feedback nudge for every meeting still missing its
 * outcome on every single run. This collapses each meeting's backlog down to
 * the most recent nudge and back-dates the guard so the next sweep waits out
 * the normal window instead of firing again immediately.
 *
 * Only `feedback_due` rows are touched, and only where the same meeting has
 * more than one. Everything else in the outbox is left exactly as it is.
 */

await migrate();

const groups = (await db
  .prepare(
    `SELECT json_extract(payload_json, '$.meetingId') AS meeting_id,
            recipient_id,
            COUNT(*) AS n,
            MAX(id)  AS keep_id
       FROM notification
      WHERE template = 'feedback_due'
        AND json_extract(payload_json, '$.meetingId') IS NOT NULL
      GROUP BY meeting_id, recipient_id
     HAVING n > 1`,
  )
  .all()) as Array<{ meeting_id: number; recipient_id: number; n: number; keep_id: number }>;

if (!groups.length) {
  console.log('No duplicate feedback nudges found — nothing to do.');
} else {
  let removed = 0;
  for (const g of groups) {
    const res = await db
      .prepare(
        `DELETE FROM notification
          WHERE template = 'feedback_due'
            AND json_extract(payload_json, '$.meetingId') = ?
            AND recipient_id IS ?
            AND id <> ?`,
      )
      .run(g.meeting_id, g.recipient_id, g.keep_id);
    const gone = res.changes;
    removed += gone;
    console.log(`meeting ${g.meeting_id}: ${g.n} nudges -> 1 (removed ${gone})`);
  }

  // Stamp the guard from the nudge we kept, so the meeting is not nudged again
  // the moment the next sweep runs.
  await db.exec(
    `UPDATE meeting
        SET feedback_nudged_at = (
              SELECT MAX(created_at) FROM notification
               WHERE template = 'feedback_due'
                 AND json_extract(payload_json, '$.meetingId') = meeting.id)
      WHERE feedback_nudged_at IS NULL
        AND EXISTS (SELECT 1 FROM notification
                     WHERE template = 'feedback_due'
                       AND json_extract(payload_json, '$.meetingId') = meeting.id)`,
  );

  console.log(`\nRemoved ${removed} duplicate notification${removed === 1 ? '' : 's'}.`);
}

const left = (await db.prepare(`SELECT COUNT(*) AS n FROM notification`).get()) as { n: number };
console.log(`Outbox now holds ${left.n} messages.`);

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { weekStart } from '../lib/dates.js';
import { asyncRoute, HttpError, intParam, parseBody } from '../lib/http.js';
import { toE164Pk } from '../lib/normalize.js';

export const peopleRouter = Router();

peopleRouter.get(
  '/salesmen',
  asyncRoute((req, res) => {
    const week = (req.query.week as string) || weekStart();
    res.json(
      db
        .prepare(
          `SELECT s.*,
                  (SELECT COUNT(*) FROM assignment a WHERE a.salesman_id = s.id AND a.week_start = ?) AS assigned_this_week,
                  (SELECT COUNT(*) FROM company  c WHERE c.owner_id = s.id) AS companies_owned,
                  (SELECT COUNT(*) FROM meeting  m WHERE m.salesman_id = s.id AND m.status = 'scheduled'
                     AND datetime(m.scheduled_at) >= datetime('now')) AS upcoming_meetings,
                  (SELECT COUNT(*) FROM notification n WHERE n.recipient_type = 'salesman'
                     AND n.recipient_id = s.id AND n.read_at IS NULL AND n.channel = 'inapp') AS unread,
                  (SELECT COUNT(*) FROM feedback f WHERE f.salesman_id = s.id AND f.outcome = 'approved') AS deals_won
             FROM salesman s
            WHERE s.active = 1
            ORDER BY s.role DESC, s.name`,
        )
        .all(week),
    );
  }),
);

const salesmanInput = z.object({
  name: z.string().min(1),
  email: z.string().email().nullable().optional().or(z.literal('')),
  phone: z.string().nullable().optional(),
  role: z.enum(['salesman', 'manager']).default('salesman'),
  weekly_quota: z.number().int().min(1).max(20).default(2),
  areas: z.string().nullable().optional(),
});

peopleRouter.post(
  '/salesmen',
  asyncRoute((req, res) => {
    const s = parseBody(salesmanInput, req.body);
    const r = db
      .prepare(
        `INSERT INTO salesman (name, email, phone_e164, role, weekly_quota, areas) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(s.name, s.email || null, toE164Pk(s.phone), s.role, s.weekly_quota, s.areas || null);
    res.status(201).json(db.prepare('SELECT * FROM salesman WHERE id = ?').get(Number(r.lastInsertRowid)));
  }),
);

peopleRouter.patch(
  '/salesmen/:id',
  asyncRoute((req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(salesmanInput.partial().extend({ active: z.boolean().optional() }), req.body);
    const before = db.prepare('SELECT * FROM salesman WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Salesman not found');

    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'phone') { sets.push('phone_e164 = ?'); params.push(toE164Pk(v as string)); continue; }
      sets.push(`${k} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v === '' ? null : v);
    }
    if (sets.length) {
      sets.push(`updated_at = datetime('now')`);
      db.prepare(`UPDATE salesman SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    res.json(db.prepare('SELECT * FROM salesman WHERE id = ?').get(id));
  }),
);

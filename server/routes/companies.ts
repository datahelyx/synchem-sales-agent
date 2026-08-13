import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { isValidDateOnly } from '../lib/dates.js';
import { asyncRoute, HttpError, intParam, parseBody } from '../lib/http.js';
import { nameKey, dataQuality, toE164Pk } from '../lib/normalize.js';
import { logActivity, recordRevision, setStage, STAGES } from '../services/pipeline.js';

export const companiesRouter = Router();

const LIST_SELECT = `
  SELECT c.id, c.name, c.area, c.phone, c.phone_e164, c.email, c.industry,
         c.contact_name, c.contact_title, c.stage, c.owner_id, c.times_assigned,
         c.last_assigned_on, c.last_touched_at, c.follow_up_on, c.do_not_contact,
         c.data_quality, s.name AS owner_name
    FROM company c
    LEFT JOIN salesman s ON s.id = c.owner_id
`;

companiesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { q, stage, area, industry, owner, quality, page = '1', pageSize = '25', sort = 'name' } = req.query as Record<string, string>;
    const where: string[] = [];
    const params: any[] = [];

    if (q) {
      where.push('(c.name LIKE ? OR c.contact_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (stage) {
      where.push(`c.stage IN (${stage.split(',').map(() => '?').join(',')})`);
      params.push(...stage.split(','));
    }
    if (area) { where.push('c.area = ?'); params.push(area); }
    if (industry) { where.push('c.industry = ?'); params.push(industry); }
    if (owner === 'none') where.push('c.owner_id IS NULL');
    else if (owner) { where.push('c.owner_id = ?'); params.push(Number(owner)); }
    if (quality === 'contactable') where.push('c.phone_e164 IS NOT NULL');
    if (quality === 'missing') where.push('c.phone_e164 IS NULL AND c.email IS NULL');

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy =
      { name: 'c.name ASC', quality: 'c.data_quality DESC, c.name ASC', recent: 'c.last_touched_at DESC NULLS LAST, c.id DESC', stage: 'c.stage ASC, c.name ASC' }[
        sort
      ] ?? 'c.name ASC';

    const size = Math.min(200, Math.max(1, Number(pageSize) || 25));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;

    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM company c ${clause}`).get(...params) as any).n;
    const rows = await db.prepare(`${LIST_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, size, offset);

    res.json({ total, page: Number(page) || 1, pageSize: size, rows });
  }),
);

/** Filter dropdown contents, so the UI never asks the user to type a free-text area. */
companiesRouter.get(
  '/facets',
  asyncRoute(async (_req, res) => {
    res.json({
      areas: await db.prepare(`SELECT area AS value, COUNT(*) AS n FROM company WHERE area IS NOT NULL AND area <> '' GROUP BY area ORDER BY n DESC`).all(),
      industries: await db.prepare(`SELECT industry AS value, COUNT(*) AS n FROM company WHERE industry IS NOT NULL GROUP BY industry ORDER BY n DESC`).all(),
      stages: await db.prepare(`SELECT stage AS value, COUNT(*) AS n FROM company GROUP BY stage`).all(),
      owners: await db.prepare(`SELECT s.id AS value, s.name AS label, COUNT(c.id) AS n FROM salesman s LEFT JOIN company c ON c.owner_id = s.id GROUP BY s.id ORDER BY s.name`).all(),
    });
  }),
);

companiesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const company = await db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(id) as any;
    if (!company) throw new HttpError(404, 'Company not found');

    company.assignments = await db
      .prepare(
        `SELECT a.*, s.name AS salesman_name FROM assignment a JOIN salesman s ON s.id = a.salesman_id
          WHERE a.company_id = ? ORDER BY a.week_start DESC`,
      )
      .all(id);
    company.meetings = await db
      .prepare(
        `SELECT m.*, s.name AS salesman_name, f.outcome, f.reason_code, f.reason_note, f.id AS feedback_id
           FROM meeting m
           JOIN salesman s ON s.id = m.salesman_id
      LEFT JOIN feedback f ON f.meeting_id = m.id
          WHERE m.company_id = ? ORDER BY m.scheduled_at DESC`,
      )
      .all(id);
    company.samples = await db
      .prepare(
        `SELECT sr.*, (SELECT json_group_array(json_object('product', p.name, 'qty', sl.qty, 'uom', p.uom))
                         FROM sample_line sl JOIN product p ON p.id = sl.product_id
                        WHERE sl.sample_request_id = sr.id) AS lines_json
           FROM sample_request sr WHERE sr.company_id = ? ORDER BY sr.id DESC`,
      )
      .all(id);
    company.invoices = await db.prepare('SELECT * FROM invoice WHERE company_id = ? ORDER BY id DESC').all(id);
    company.timeline = await db
      .prepare(
        `SELECT a.*, s.name AS salesman_name FROM activity a LEFT JOIN salesman s ON s.id = a.salesman_id
          WHERE a.company_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      )
      .all(id);

    res.json(company);
  }),
);

const companyPatch = z.object({
  name: z.string().min(1).optional(),
  area: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  industry: z.string().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  contact_title: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  stage: z.enum(STAGES).optional(),
  owner_id: z.number().int().nullable().optional(),
  follow_up_on: z
    .string()
    .refine((v) => v === '' || isValidDateOnly(v), 'Use a YYYY-MM-DD date')
    .nullable()
    .optional(),
  do_not_contact: z.boolean().optional(),
  actorId: z.number().int().optional(),
});

companiesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(companyPatch, req.body);
    const before = await db.prepare('SELECT * FROM company WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Company not found');

    const { actorId, stage, ...fields } = patch;
    const sets: string[] = [];
    const params: any[] = [];

    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v === '' ? null : v);
    }
    if (patch.name) { sets.push('name_key = ?'); params.push(nameKey(patch.name)); }
    if (patch.phone !== undefined) { sets.push('phone_e164 = ?'); params.push(toE164Pk(patch.phone)); }

    if (sets.length) {
      sets.push(`updated_at = datetime('now')`);
      await db.prepare(`UPDATE company SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      const after = await db.prepare('SELECT * FROM company WHERE id = ?').get(id) as any;
      await db.prepare('UPDATE company SET data_quality = ? WHERE id = ?').run(dataQuality(after), id);
    }
    if (stage) await setStage(id, stage, { force: true, actor: 'manager', salesmanId: actorId ?? null });

    const after = await db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(id);
    await recordRevision('company', id, before, after, actorId);
    res.json(after);
  }),
);

companiesRouter.post(
  '/:id/notes',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const { text, actorId } = parseBody(z.object({ text: z.string().min(1), actorId: z.number().int().optional() }), req.body);
    await logActivity({ companyId: id, salesmanId: actorId ?? null, kind: 'note', summary: text, actor: 'salesman' });
    await db.prepare(`UPDATE company SET last_touched_at = datetime('now') WHERE id = ?`).run(id);
    res.status(201).json({ ok: true });
  }),
);

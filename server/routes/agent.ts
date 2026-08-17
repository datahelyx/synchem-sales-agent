import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { runFollowUpSweep, runReminderSweep, runWeeklyAssignment } from '../agent/assignment.js';
import { db, tx } from '../db/index.js';
import { nextWeekStart, weekLabel, weekStart } from '../lib/dates.js';
import { asyncRoute, HttpError, intParam, parseBody } from '../lib/http.js';
import { importCompanies } from '../services/importer.js';
import { drainOutbox, outboundMode, redirectTarget } from '../services/notifier.js';

export const agentRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ---------------------------------------------------------------- import */

/**
 * Two-step upload: `preview` shows what would happen (and every data warning)
 * without writing, `commit` performs it. Uploading 5,119 rows blind into a
 * live pipeline is exactly the kind of dead end the brief rules out.
 */
agentRouter.post(
  '/import/companies',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded — choose a .csv file');
    const dryRun = req.body?.mode !== 'commit';
    const summary = await importCompanies(req.file.buffer, req.file.originalname, { dryRun });
    res.json({ ...summary, dryRun });
  }),
);

agentRouter.get(
  '/import/batches',
  asyncRoute(async (_req, res) => {
    res.json(await db.prepare('SELECT * FROM import_batch ORDER BY id DESC LIMIT 20').all());
  }),
);

/* ------------------------------------------------------------- agent runs */

agentRouter.post(
  '/agent/run-weekly',
  asyncRoute(async (req, res) => {
    const input = parseBody(
      z.object({
        week: z.string().optional(),
        forNextWeek: z.boolean().optional(),
        salesmanIds: z.array(z.number().int()).optional(),
        notify: z.boolean().default(true),
      }),
      req.body ?? {},
    );
    const week = input.week ?? (input.forNextWeek ? nextWeekStart() : weekStart());
    const result = await runWeeklyAssignment({
      week, trigger: 'manual', salesmanIds: input.salesmanIds, notifySalesmen: input.notify,
    });
    res.json(result);
  }),
);

agentRouter.post('/agent/run-reminders', asyncRoute(async (_req, res) => res.json(await runReminderSweep('manual'))));
agentRouter.post('/agent/run-followups', asyncRoute(async (_req, res) => res.json(await runFollowUpSweep('manual'))));
agentRouter.post('/agent/drain-outbox', asyncRoute(async (_req, res) => res.json(await drainOutbox())));

agentRouter.get(
  '/agent/runs',
  asyncRoute(async (_req, res) => {
    res.json(await db.prepare('SELECT * FROM agent_run ORDER BY id DESC LIMIT 40').all());
  }),
);

/** What the agent *would* do this week, without writing anything. */
agentRouter.get(
  '/agent/status',
  asyncRoute(async (_req, res) => {
    const week = weekStart();
    const salesmen = await db.prepare(`SELECT * FROM salesman WHERE active = 1 AND role = 'salesman'`).all() as any[];
    // Each row needs its own count query; without Promise.all this serialises
    // into an array of pending promises and the UI renders empty rows.
    const perSalesman = await Promise.all(
      salesmen.map(async (s) => {
        const assigned = (await db.prepare('SELECT COUNT(*) AS n FROM assignment WHERE salesman_id = ? AND week_start = ?').get(s.id, week) as any).n;
        const quota = s.weekly_quota ?? 0;
        return { id: s.id, name: s.name, quota, assigned, short: Math.max(0, quota - assigned) };
      }),
    );
    const pool = (await db.prepare(
      `SELECT COUNT(*) AS n FROM company
        WHERE do_not_contact = 0 AND stage NOT IN ('won','lost')
          AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.company_id = company.id AND a.status IN ('pending','in_progress','meeting_set'))`,
    ).get() as any).n;

    res.json({
      week, weekLabel: weekLabel(week), perSalesman, availablePool: pool,
      lastRun: await db.prepare(`SELECT * FROM agent_run WHERE kind = 'weekly_assignment' ORDER BY id DESC LIMIT 1`).get() ?? null,
      cronEnabled: process.env.AGENT_CRON !== 'off',
      outboundMode: outboundMode(),
      redirectTo: redirectTarget(),
      suppressed: (await db.prepare(`SELECT COUNT(*) AS n FROM notification WHERE status = 'suppressed'`).get() as any).n,
    });
  }),
);

/* --------------------------------------------------------- notifications */

agentRouter.get(
  '/notifications',
  asyncRoute(async (req, res) => {
    const { recipientType = 'salesman', recipientId, unreadOnly, channel, limit = '50' } = req.query as Record<string, string>;
    const where: string[] = [];
    const params: any[] = [];
    // Accepts a comma list: a manager's inbox holds both the notices addressed
    // to them as a manager and anything sent to them as a person.
    if (recipientType !== 'all') {
      const types = recipientType.split(',').map((t) => t.trim()).filter(Boolean);
      where.push(`recipient_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (recipientId) { where.push('recipient_id = ?'); params.push(Number(recipientId)); }
    if (channel) { where.push('channel = ?'); params.push(channel); }
    if (unreadOnly === 'true') where.push(`read_at IS NULL`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json(await db.prepare(`SELECT * FROM notification ${clause} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(200, Number(limit) || 50)));
  }),
);

agentRouter.post(
  '/notifications/:id/read',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    await db.prepare(`UPDATE notification SET read_at = datetime('now'), status = 'read' WHERE id = ?`).run(id);
    res.json({ ok: true });
  }),
);

agentRouter.post(
  '/notifications/read-all',
  asyncRoute(async (req, res) => {
    const { recipientId } = parseBody(z.object({ recipientId: z.number().int() }), req.body);
    await db.prepare(
      `UPDATE notification SET read_at = datetime('now'), status = 'read'
        WHERE recipient_type IN ('salesman','manager') AND recipient_id = ? AND read_at IS NULL`,
    ).run(recipientId);
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------- settings */

agentRouter.get(
  '/settings',
  asyncRoute(async (_req, res) => {
    const rows = await db.prepare('SELECT key, value FROM setting').all() as any[];
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  }),
);

agentRouter.put(
  '/settings',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.record(z.string()), req.body);
    const stmt = db.prepare(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    );
    // Awaited so a failed write surfaces as a 500 rather than being swallowed,
    // and so the response only goes out once the setting is actually committed.
    await tx(async () => {
      for (const [k, v] of Object.entries(body)) await stmt.run(k, v);
    });
    res.json(body);
  }),
);

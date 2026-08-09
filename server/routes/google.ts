import { Router } from 'express';
import { db } from '../db/index.js';
import { asyncRoute, HttpError, intParam } from '../lib/http.js';
import { authUrl, disconnect, exchangeCode, googleAccount, googleConfig, pushMeeting, verifyState } from '../services/google.js';

export const googleRouter = Router();

const WEB_ORIGIN = () => process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 5310}`;

/** Who is connected, so the UI can show a Connect or Disconnect button. */
googleRouter.get(
  '/google/status',
  asyncRoute((req, res) => {
    const cfg = googleConfig();
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.role, g.google_email, g.connected_at, g.last_error
           FROM salesman s LEFT JOIN google_account g ON g.salesman_id = s.id
          WHERE s.active = 1 ORDER BY s.role DESC, s.name`,
      )
      .all() as any[];

    const salesmanId = req.query.salesmanId ? Number(req.query.salesmanId) : null;
    res.json({
      configured: cfg.configured,
      redirectUri: cfg.redirectUri,
      accounts: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        connected: Boolean(r.google_email),
        email: r.google_email,
        connectedAt: r.connected_at,
        error: r.last_error,
      })),
      me: salesmanId ? (googleAccount(salesmanId) ? { connected: true, email: googleAccount(salesmanId).google_email } : { connected: false }) : null,
    });
  }),
);

googleRouter.get(
  '/google/connect',
  asyncRoute((req, res) => {
    const salesmanId = intParam(req.query.salesmanId, 'salesmanId');
    const url = authUrl(salesmanId);
    if (!url) {
      throw new HttpError(
        400,
        'Google is not configured — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart.',
      );
    }
    res.redirect(url);
  }),
);

/**
 * Google sends the user back here. This is a browser redirect, not an API call,
 * so it ends by bouncing to the app with a readable outcome in the query string.
 */
googleRouter.get(
  '/google/callback',
  asyncRoute(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    const back = (params: Record<string, string>) =>
      res.redirect(`${WEB_ORIGIN()}/calendar?${new URLSearchParams(params).toString()}`);

    if (error) return back({ google: 'error', message: error });
    if (!code || !state) return back({ google: 'error', message: 'Missing code or state' });

    const salesmanId = verifyState(state);
    if (!salesmanId) return back({ google: 'error', message: 'That sign-in link expired — try again' });

    try {
      const { email } = await exchangeCode(code, salesmanId);

      // Push anything already booked and still ahead, so a freshly connected
      // calendar is not empty of the meetings the app already knows about.
      const pending = db
        .prepare(
          `SELECT id FROM meeting
            WHERE salesman_id = ? AND status IN ('proposed','scheduled')
              AND datetime(scheduled_at) >= datetime('now')`,
        )
        .all(salesmanId) as any[];
      let pushed = 0;
      for (const m of pending) {
        const r = await pushMeeting(m.id);
        if (r.synced) pushed++;
      }

      return back({ google: 'connected', email: email ?? '', pushed: String(pushed) });
    } catch (err) {
      return back({ google: 'error', message: (err as Error).message });
    }
  }),
);

googleRouter.post(
  '/google/disconnect',
  asyncRoute((req, res) => {
    const salesmanId = intParam(req.body?.salesmanId, 'salesmanId');
    disconnect(salesmanId);
    res.json({ ok: true });
  }),
);

/** Re-push everything upcoming — useful after fixing a sync error. */
googleRouter.post(
  '/google/resync',
  asyncRoute(async (req, res) => {
    const salesmanId = intParam(req.body?.salesmanId, 'salesmanId');
    const rows = db
      .prepare(
        `SELECT id FROM meeting
          WHERE salesman_id = ? AND status IN ('proposed','scheduled')
            AND datetime(scheduled_at) >= datetime('now')`,
      )
      .all(salesmanId) as any[];

    let synced = 0;
    const failures: string[] = [];
    for (const m of rows) {
      const r = await pushMeeting(m.id);
      if (r.synced) synced++;
      else if (r.reason) failures.push(r.reason);
    }
    res.json({ total: rows.length, synced, failures: [...new Set(failures)] });
  }),
);

import { Router } from 'express';
import { db } from '../db/index.js';
import { addDays, today, weekLabel, weekStart } from '../lib/dates.js';
import { asyncRoute } from '../lib/http.js';

export const dashboardRouter = Router();

/**
 * Every number here is computed at request time from the operational tables —
 * the brief asks for "fully dynamic, live from the data, not static exports",
 * so there is deliberately no snapshot/rollup table anywhere in the schema.
 */
dashboardRouter.get(
  '/dashboard',
  asyncRoute((req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
    const since = addDays(today(), -days);
    const week = weekStart();
    const salesmanId = req.query.salesmanId ? Number(req.query.salesmanId) : null;
    const mineMeeting = salesmanId ? 'AND m.salesman_id = @sid' : '';
    const mineFeedback = salesmanId ? 'AND f.salesman_id = @sid' : '';
    const p = { since, week, sid: salesmanId };

    const scalar = (sql: string) => (db.prepare(sql).get(p) as any)?.n ?? 0;

    const totals = {
      companies: scalar('SELECT COUNT(*) AS n FROM company'),
      contactable: scalar('SELECT COUNT(*) AS n FROM company WHERE phone_e164 IS NOT NULL OR email IS NOT NULL'),
      inPlay: scalar(`SELECT COUNT(*) AS n FROM company WHERE stage NOT IN ('new','won','lost')`),
      assignedThisWeek: scalar('SELECT COUNT(*) AS n FROM assignment WHERE week_start = @week'),
      meetingsUpcoming: scalar(
        `SELECT COUNT(*) AS n FROM meeting m WHERE m.status = 'scheduled' AND datetime(m.scheduled_at) >= datetime('now') ${mineMeeting}`,
      ),
      meetingsHeld: scalar(
        `SELECT COUNT(*) AS n FROM meeting m WHERE m.status = 'held' AND date(m.scheduled_at) >= @since ${mineMeeting}`,
      ),
      feedbackPending: scalar(
        `SELECT COUNT(*) AS n FROM meeting m LEFT JOIN feedback f ON f.meeting_id = m.id
          WHERE f.id IS NULL AND datetime(m.scheduled_at) < datetime('now')
            AND m.status IN ('scheduled','held') ${mineMeeting}`,
      ),
      dealsWon: scalar(
        `SELECT COUNT(*) AS n FROM feedback f WHERE f.outcome = 'approved' AND date(f.created_at) >= @since ${mineFeedback}`,
      ),
      samplesOut: scalar(`SELECT COUNT(*) AS n FROM sample_request WHERE status IN ('draft','dispatched')`),
    };

    const revenueRow = db
      .prepare(
        `SELECT COALESCE(SUM(i.total), 0) AS total, COUNT(*) AS n
           FROM invoice i WHERE i.status <> 'cancelled' AND date(i.issue_date) >= @since
           ${salesmanId ? 'AND i.salesman_id = @sid' : ''}`,
      )
      .get(p) as any;

    const held = totals.meetingsHeld || 0;
    const conversion = held ? Math.round((totals.dealsWon / held) * 100) : 0;

    res.json({
      week,
      weekLabel: weekLabel(week),
      windowDays: days,
      totals: { ...totals, revenue: revenueRow.total, invoices: revenueRow.n, conversionPct: conversion },

      // Feedback split — the brief's "feedback charts".
      outcomes: db
        .prepare(
          `SELECT f.outcome, COUNT(*) AS n FROM feedback f WHERE date(f.created_at) >= @since ${mineFeedback}
            GROUP BY f.outcome`,
        )
        .all(p),

      rejectionReasons: db
        .prepare(
          `SELECT COALESCE(rc.label, f.reason_code, 'Not given') AS label, COUNT(*) AS n
             FROM feedback f LEFT JOIN reason_code rc ON rc.code = f.reason_code AND rc.outcome = f.outcome
            WHERE f.outcome = 'rejected' AND date(f.created_at) >= @since ${mineFeedback}
            GROUP BY label ORDER BY n DESC LIMIT 8`,
        )
        .all(p),

      pipeline: db
        .prepare(
          `SELECT stage, COUNT(*) AS n FROM company
            WHERE stage <> 'new' ${salesmanId ? 'AND owner_id = @sid' : ''} GROUP BY stage`,
        )
        .all(p),

      // Weekly trend: meetings held vs deals won, by ISO week.
      trend: db
        .prepare(
          `WITH weeks AS (
             SELECT DISTINCT date(m.scheduled_at, 'weekday 0', '-6 day') AS wk
               FROM meeting m WHERE date(m.scheduled_at) >= @since ${mineMeeting}
           )
           SELECT w.wk AS week,
                  (SELECT COUNT(*) FROM meeting m
                    WHERE date(m.scheduled_at, 'weekday 0', '-6 day') = w.wk
                      AND m.status = 'held' ${mineMeeting}) AS meetings,
                  (SELECT COUNT(*) FROM feedback f JOIN meeting m2 ON m2.id = f.meeting_id
                    WHERE date(m2.scheduled_at, 'weekday 0', '-6 day') = w.wk
                      AND f.outcome = 'approved' ${mineFeedback}) AS won,
                  (SELECT COUNT(*) FROM feedback f JOIN meeting m2 ON m2.id = f.meeting_id
                    WHERE date(m2.scheduled_at, 'weekday 0', '-6 day') = w.wk
                      AND f.outcome = 'rejected' ${mineFeedback}) AS lost
             FROM weeks w ORDER BY w.wk`,
        )
        .all(p),

      // Per-salesman leaderboard, all live.
      bySalesman: db
        .prepare(
          `SELECT s.id, s.name,
                  (SELECT COUNT(*) FROM assignment a WHERE a.salesman_id = s.id AND a.week_start = @week) AS assigned,
                  (SELECT COUNT(*) FROM meeting m WHERE m.salesman_id = s.id AND m.status = 'held'
                     AND date(m.scheduled_at) >= @since) AS meetings,
                  (SELECT COUNT(*) FROM feedback f WHERE f.salesman_id = s.id AND f.outcome = 'approved'
                     AND date(f.created_at) >= @since) AS won,
                  (SELECT COUNT(*) FROM feedback f WHERE f.salesman_id = s.id AND f.outcome = 'rejected'
                     AND date(f.created_at) >= @since) AS lost,
                  (SELECT COALESCE(SUM(i.total), 0) FROM invoice i WHERE i.salesman_id = s.id
                     AND i.status <> 'cancelled' AND date(i.issue_date) >= @since) AS revenue
             FROM salesman s WHERE s.active = 1 AND s.role = 'salesman' ORDER BY won DESC, meetings DESC`,
        )
        .all(p),

      topIndustries: db
        .prepare(
          `SELECT COALESCE(c.industry, 'Unknown') AS industry, COUNT(*) AS meetings,
                  SUM(CASE WHEN f.outcome = 'approved' THEN 1 ELSE 0 END) AS won
             FROM meeting m JOIN company c ON c.id = m.company_id
        LEFT JOIN feedback f ON f.meeting_id = m.id
            WHERE date(m.scheduled_at) >= @since ${mineMeeting}
            GROUP BY industry ORDER BY meetings DESC LIMIT 8`,
        )
        .all(p),

      upcoming: db
        .prepare(
          `SELECT m.id, m.scheduled_at, m.mode, m.status, c.name AS company_name, c.area,
                  s.name AS salesman_name, c.contact_name, c.contact_title
             FROM meeting m JOIN company c ON c.id = m.company_id JOIN salesman s ON s.id = m.salesman_id
            WHERE m.status IN ('proposed','scheduled') AND datetime(m.scheduled_at) >= datetime('now') ${mineMeeting}
            ORDER BY m.scheduled_at LIMIT 12`,
        )
        .all(p),

      needsFeedback: db
        .prepare(
          `SELECT m.id, m.scheduled_at, c.name AS company_name, s.name AS salesman_name, m.salesman_id
             FROM meeting m JOIN company c ON c.id = m.company_id JOIN salesman s ON s.id = m.salesman_id
        LEFT JOIN feedback f ON f.meeting_id = m.id
            WHERE f.id IS NULL AND datetime(m.scheduled_at) < datetime('now')
              AND m.status IN ('scheduled','held') ${mineMeeting}
            ORDER BY m.scheduled_at LIMIT 12`,
        )
        .all(p),

      followUps: db
        .prepare(
          `SELECT c.id, c.name, c.follow_up_on, c.stage, s.name AS owner_name
             FROM company c LEFT JOIN salesman s ON s.id = c.owner_id
            WHERE c.follow_up_on IS NOT NULL AND c.stage NOT IN ('won','lost')
              ${salesmanId ? 'AND c.owner_id = @sid' : ''}
            ORDER BY c.follow_up_on LIMIT 12`,
        )
        .all(p),

      recentActivity: db
        .prepare(
          `SELECT a.*, c.name AS company_name, s.name AS salesman_name
             FROM activity a LEFT JOIN company c ON c.id = a.company_id LEFT JOIN salesman s ON s.id = a.salesman_id
            ${salesmanId ? 'WHERE a.salesman_id = @sid' : ''}
            ORDER BY a.id DESC LIMIT 15`,
        )
        .all(p),

      dataHealth: db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM company WHERE phone_e164 IS NULL AND email IS NULL) AS unreachable,
             (SELECT COUNT(*) FROM company WHERE email IS NOT NULL) AS with_email,
             (SELECT COUNT(*) FROM company WHERE contact_name IS NULL) AS no_contact_name,
             (SELECT COUNT(*) FROM company WHERE industry IS NULL) AS no_industry,
             (SELECT COUNT(*) FROM company WHERE area IS NULL OR area = '') AS no_area`,
        )
        .get(),
    });
  }),
);

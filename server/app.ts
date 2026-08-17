import './env.js'; // must run before anything reads process.env
import express, { type Express } from 'express';
import { runFollowUpSweep, runReminderSweep, runWeeklyAssignment } from './agent/assignment.js';
import { dbPath, isRemote, migrate } from './db/index.js';
import { errorHandler, HttpError } from './lib/http.js';
import { agentRouter } from './routes/agent.js';
import { catalogRouter } from './routes/catalog.js';
import { companiesRouter } from './routes/companies.js';
import { dashboardRouter } from './routes/dashboard.js';
import { googleRouter } from './routes/google.js';
import { peopleRouter } from './routes/people.js';
import { workRouter } from './routes/work.js';
import { seedIfEmpty } from './scripts/seed-data.js';
import { STAGE_LABELS, STAGES } from './services/pipeline.js';

/**
 * The Express app on its own, with no server attached.
 *
 * Locally `server/index.ts` calls listen(); on Vercel `api/index.ts` hands the
 * same app to the serverless runtime. Keeping them apart means one codebase
 * behaves identically in both places.
 */

let ready: Promise<void> | null = null;

/**
 * Schema setup runs once per process. On a serverless platform a cold start is
 * a fresh process, so this has to be idempotent and cheap — it is both:
 * CREATE TABLE IF NOT EXISTS plus a handful of PRAGMA checks.
 */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await migrate();
      await seedIfEmpty();
    })().catch((err) => {
      ready = null; // let the next request retry rather than wedging forever
      throw err;
    });
  }
  return ready;
}

/**
 * Configuration that is fine on a laptop and dangerous once this is reachable
 * from anywhere. Printed once per process so it shows up in a deploy log, where
 * the person who can actually fix it will see it.
 */
function warnAboutConfig() {
  const notes: string[] = [];

  if (!process.env.CRON_SECRET) {
    notes.push('CRON_SECRET is not set — /api/cron/* can be triggered by anyone who can reach this server.');
  }
  if ((process.env.OUTBOUND_MODE ?? 'off').toLowerCase() === 'live') {
    notes.push('OUTBOUND_MODE=live — real company contacts WILL be messaged.');
  }
  if (isRemote && !process.env.TURSO_AUTH_TOKEN) {
    notes.push('TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not.');
  }

  if (notes.length) {
    console.warn('\nConfiguration warnings:');
    for (const n of notes) console.warn(`  ! ${n}`);
    console.warn('  (this build has no login: anyone who can reach it can act as anyone)\n');
  }
}

export function createApp(): Express {
  warnAboutConfig();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.use((req, _res, next) => {
    ensureReady().then(() => next()).catch(next);
  });

  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, storage: isRemote ? 'turso' : 'local file', db: isRemote ? 'remote' : dbPath }),
  );
  app.get('/api/meta', (_req, res) =>
    res.json({
      stages: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
      currency: 'PKR',
      timezone: process.env.TZ_NAME ?? 'Asia/Karachi',
    }),
  );

  const companies = express.Router();
  companies.use('/companies', companiesRouter);

  app.use('/api', companies);
  app.use('/api', peopleRouter);
  app.use('/api', workRouter);
  app.use('/api', catalogRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', googleRouter);
  app.use('/api', agentRouter);

  /*
   * Serverless has no long-running process, so the schedule lives in
   * vercel.json and calls back in here. The shared secret stops anyone on the
   * internet from triggering a weekly assignment run.
   */
  app.get('/api/cron/:job', async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? (req.query.key as string | undefined);
      if (secret && provided !== secret) throw new HttpError(401, 'Bad cron secret');

      switch (req.params.job) {
        case 'weekly':
          return res.json(await runWeeklyAssignment({ trigger: 'cron' }));
        case 'reminders':
          return res.json(await runReminderSweep('cron'));
        case 'followups':
          return res.json(await runFollowUpSweep('cron'));
        /*
         * Vercel's Hobby plan allows two cron jobs, each at most once a day.
         * `daily` bundles the two sweeps into one of those slots.
         *
         * Reminders really want to run every 15 minutes, so that they fire
         * near each meeting's own time rather than in a single daily batch.
         * Once a day is a real downgrade — point an external scheduler at
         * /api/cron/reminders to get the intended behaviour back.
         */
        case 'daily': {
          const reminders = await runReminderSweep('cron');
          const followups = await runFollowUpSweep('cron');
          return res.json({ reminders, followups });
        }
        default:
          throw new HttpError(404, `Unknown job "${req.params.job}"`);
      }
    } catch (err) {
      next(err);
    }
  });

  app.use(errorHandler);
  return app;
}

/** Local only: node-cron needs a process that stays alive. */
export async function startLocalCron() {
  if (process.env.AGENT_CRON === 'off') return;
  const cron = await import('node-cron');
  const tz = process.env.TZ_NAME ?? 'Asia/Karachi';

  cron.default.schedule('0 9 * * 1', () => {
    runWeeklyAssignment({ trigger: 'cron' }).catch(console.error);
  }, { timezone: tz });

  cron.default.schedule('*/15 * * * *', () => {
    runReminderSweep('cron').catch(console.error);
  }, { timezone: tz });

  cron.default.schedule('30 8 * * *', () => {
    runFollowUpSweep('cron').catch(console.error);
  }, { timezone: tz });

  console.log(`Agent schedule active (${tz}): assignments Mon 09:00, reminders every 15 min, follow-ups 08:30`);
}

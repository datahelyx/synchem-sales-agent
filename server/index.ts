import './env.js'; // must run before anything reads process.env
import express from 'express';
import { runFollowUpSweep, runReminderSweep, runWeeklyAssignment } from './agent/assignment.js';
import { dbPath, migrate } from './db/index.js';
import { errorHandler } from './lib/http.js';
import { agentRouter } from './routes/agent.js';
import { catalogRouter } from './routes/catalog.js';
import { companiesRouter } from './routes/companies.js';
import { dashboardRouter } from './routes/dashboard.js';
import { googleRouter } from './routes/google.js';
import { peopleRouter } from './routes/people.js';
import { workRouter } from './routes/work.js';
import { seedIfEmpty } from './scripts/seed-data.js';
import { STAGE_LABELS, STAGES } from './services/pipeline.js';

migrate();
seedIfEmpty();

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: dbPath }));
app.get('/api/meta', (_req, res) =>
  res.json({
    stages: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
    currency: 'PKR',
    timezone: process.env.TZ_NAME ?? 'Asia/Karachi',
  }),
);

app.use('/api', companiesPrefix());
app.use('/api', peopleRouter);
app.use('/api', workRouter);
app.use('/api', catalogRouter);
app.use('/api', dashboardRouter);
app.use('/api', googleRouter);
app.use('/api', agentRouter);
app.use(errorHandler);

function companiesPrefix() {
  const r = express.Router();
  r.use('/companies', companiesRouter);
  return r;
}

const port = Number(process.env.API_PORT ?? 4310);
app.listen(port, () => {
  console.log(`AI Sales Manager Agent API on http://localhost:${port}`);
  console.log(`Database: ${dbPath}`);
});

/**
 * The autonomous half. Cron is on by default because an agent that only runs
 * when a human clicks a button is not an agent; set AGENT_CRON=off to disable.
 */
if (process.env.AGENT_CRON !== 'off') {
  const cron = await import('node-cron');
  const tz = process.env.TZ_NAME ?? 'Asia/Karachi';

  // Monday 09:00 — hand out the week's companies.
  cron.default.schedule('0 9 * * 1', () => {
    runWeeklyAssignment({ trigger: 'cron' }).catch(console.error);
  }, { timezone: tz });

  // Every 15 minutes — reminders fire relative to each meeting's own time
  // (about a day ahead, then about two hours ahead), so a daily digest would
  // be too coarse. Also chases meetings that have passed with no outcome.
  cron.default.schedule('*/15 * * * *', () => {
    runReminderSweep('cron').catch(console.error);
  }, { timezone: tz });

  // Every morning — re-surface companies whose follow-up date has arrived.
  cron.default.schedule('30 8 * * *', () => {
    runFollowUpSweep('cron').catch(console.error);
  }, { timezone: tz });

  console.log(`Agent schedule active (${tz}): assignments Mon 09:00, reminders every 15 min, follow-ups 08:30`);
}

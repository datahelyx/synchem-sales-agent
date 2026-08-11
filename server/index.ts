import { createApp, ensureReady, startLocalCron } from './app.js';
import { dbPath, isRemote } from './db/index.js';

/** Local development server. Vercel uses `api/index.ts` instead. */

await ensureReady();

const app = createApp();
const port = Number(process.env.API_PORT ?? 4310);

app.listen(port, () => {
  console.log(`AI Sales Manager Agent API on http://localhost:${port}`);
  console.log(`Database: ${isRemote ? 'Turso (remote)' : dbPath}`);
});

await startLocalCron();

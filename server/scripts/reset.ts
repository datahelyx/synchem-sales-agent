import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drops the database file so the next start rebuilds and re-seeds it.
 * Deliberately does NOT import ../db — opening the handle would keep the file
 * locked on Windows and the delete would silently fail.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const dbPath = process.env.DB_FILE ?? path.join(dataDir, 'sales-agent.db');

let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const f = `${dbPath}${suffix}`;
  if (!fs.existsSync(f)) continue;
  try {
    fs.rmSync(f);
    console.log(`removed ${path.basename(f)}`);
    removed++;
  } catch (err) {
    // Windows will not unlink a file the dev server still has open, and a
    // half-reset database silently keeps the old schema — which is far more
    // confusing later than failing loudly here.
    console.error(`\nCould not delete ${path.basename(f)}: ${(err as Error).message}`);
    console.error('The dev server is probably still running and holding the database open.');
    console.error('Stop `npm run dev`, then run this again.\n');
    process.exit(1);
  }
}
console.log(removed ? 'Database reset — start the server to recreate and re-seed it.' : 'No database file found; nothing to reset.');

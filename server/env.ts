import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `.env` from the project root using Node's built-in loader (no dotenv
 * dependency). Imported first by both the server and the CLI scripts, so
 * anything reading `process.env` — the outbound guard especially — sees the
 * real configuration rather than defaults.
 *
 * Values already present in the environment win, so `OUTBOUND_MODE=off npm run dev`
 * still overrides the file.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.ENV_FILE ?? path.join(root, '.env');

if (fs.existsSync(envFile)) {
  // Snapshot first: loadEnvFile overwrites, and a value passed on the command
  // line must beat the file.
  const explicit = { ...process.env };
  try {
    process.loadEnvFile(envFile);
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn(`Could not read ${envFile}: ${(err as Error).message}`);
  }
}

export const envLoaded = true;

import '../env.js'; // must run before anything reads process.env
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const dbFile = process.env.DB_FILE ?? path.join(dataDir, 'sales-agent.db');

fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so new columns need an explicit ALTER. Additive-only by design —
 * enough for this app, and it means an existing database keeps its data.
 */
function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`migrated: ${table}.${column} added`);
}

export function migrate() {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(sql);

  // Reminders are sent relative to each meeting's own time; these record which
  // ones have already gone out so a 15-minute cron cannot send duplicates.
  ensureColumn('meeting', 'reminded_day_before_at', 'TEXT');
  ensureColumn('meeting', 'reminded_hours_before_at', 'TEXT');
  ensureColumn('meeting', 'agreed_with_contact', 'INTEGER NOT NULL DEFAULT 0');
  // Calendar invites: a reschedule re-sends the same UID with a higher SEQUENCE
  // so the entry updates on the attendee's calendar instead of duplicating.
  ensureColumn('meeting', 'ics_sequence', 'INTEGER NOT NULL DEFAULT 0');
  // Google Calendar event id, so a reschedule patches the same event rather
  // than creating a second one on the salesman's calendar.
  ensureColumn('meeting', 'google_event_id', 'TEXT');
  ensureColumn('meeting', 'google_sync_error', 'TEXT');
}

export const dbPath = dbFile;

/** Wrap a mutation so it either fully applies or not at all. */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/** Rows come back as plain objects; SQLite has no booleans, so callers coerce. */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function nowIso(): string {
  return new Date().toISOString();
}

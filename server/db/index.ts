import '../env.js'; // must run before anything reads process.env
import { createClient, type Client, type InArgs, type Transaction } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Database access.
 *
 * libSQL is SQLite — the same engine, reachable over the network — so every
 * query in this app is unchanged from the local build. What changes is that
 * calls are async, hence the `await` in front of each one.
 *
 * Two deployments, one code path:
 *   TURSO_DATABASE_URL set  -> hosted libSQL, which is what production uses
 *   otherwise               -> a local file, exactly as before
 *
 * The API deliberately mirrors better-sqlite3 (`prepare().get/all/run`) so the
 * call sites read the same as they always did.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const dbFile = process.env.DB_FILE ?? path.join(dataDir, 'sales-agent.db');

const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
export const isRemote = Boolean(remoteUrl);

if (!isRemote) fs.mkdirSync(dataDir, { recursive: true });

const client: Client = createClient(
  isRemote
    ? { url: remoteUrl!, authToken: process.env.TURSO_AUTH_TOKEN?.trim() }
    : { url: `file:${dbFile}` },
);

export const dbPath = isRemote ? remoteUrl! : dbFile;

/*
 * Transactions.
 *
 * better-sqlite3 made every query inside `db.transaction(fn)()` part of the
 * transaction automatically, because it was all one synchronous connection.
 * Here the transaction is an object, so the queries have to be told about it —
 * and threading it through every helper would mean rewriting each one.
 *
 * AsyncLocalStorage keeps that implicit: `tx()` puts the transaction in
 * context, and any query running inside picks it up. Call sites keep reading
 * the way they did.
 */
const txContext = new AsyncLocalStorage<Transaction>();

function normalizeArgs(args: unknown[]): InArgs {
  // `.get({ a: 1 })` is named binding; `.get(1, 2)` is positional. A lone array
  // argument is still one positional value, so only a plain object switches.
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0] as InArgs;
  }
  return args as InArgs;
}

async function runSql(sql: string, args: unknown[]) {
  const active = txContext.getStore();
  const runner = active ?? client;
  return runner.execute({ sql, args: normalizeArgs(args) });
}

export interface Statement {
  get<T = any>(...args: unknown[]): Promise<T | undefined>;
  all<T = any>(...args: unknown[]): Promise<T[]>;
  run(...args: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
}

export const db = {
  prepare(sql: string): Statement {
    return {
      async get<T>(...args: unknown[]) {
        const res = await runSql(sql, args);
        return res.rows[0] as T | undefined;
      },
      async all<T>(...args: unknown[]) {
        const res = await runSql(sql, args);
        return res.rows as T[];
      },
      async run(...args: unknown[]) {
        const res = await runSql(sql, args);
        return {
          changes: res.rowsAffected,
          // libSQL returns a BigInt; every caller wants a plain number.
          lastInsertRowid: res.lastInsertRowid === undefined ? 0 : Number(res.lastInsertRowid),
        };
      },
    };
  },

  async exec(sql: string) {
    const active = txContext.getStore();
    if (active) {
      await active.execute(sql);
      return;
    }
    await client.executeMultiple(sql);
  },
};

/** Wrap a mutation so it either fully applies or not at all. */
export async function tx<T>(fn: () => Promise<T> | T): Promise<T> {
  // Nested tx() calls join the outer transaction rather than deadlocking.
  const existing = txContext.getStore();
  if (existing) return fn();

  const transaction = await client.transaction('write');
  try {
    const out = await txContext.run(transaction, async () => fn());
    await transaction.commit();
    return out;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* already closed */
    }
    throw err;
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so new columns need an explicit ALTER. Additive-only by design —
 * enough for this app, and it means an existing database keeps its data.
 */
async function ensureColumn(table: string, column: string, definition: string) {
  const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`migrated: ${table}.${column} added`);
}

export async function migrate() {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await db.exec(sql);

  // Reminders are sent relative to each meeting's own time; these record which
  // ones have already gone out so a 15-minute cron cannot send duplicates.
  await ensureColumn('meeting', 'reminded_day_before_at', 'TEXT');
  await ensureColumn('meeting', 'reminded_hours_before_at', 'TEXT');
  await ensureColumn('meeting', 'agreed_with_contact', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('meeting', 'ics_sequence', 'INTEGER NOT NULL DEFAULT 0');
  // Google Calendar event id, so a reschedule patches the same event rather
  // than creating a second one on the salesman's calendar.
  await ensureColumn('meeting', 'google_event_id', 'TEXT');
  await ensureColumn('meeting', 'google_sync_error', 'TEXT');
}

/** Rows come back as plain objects; SQLite has no booleans, so callers coerce. */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { client as rawClient };

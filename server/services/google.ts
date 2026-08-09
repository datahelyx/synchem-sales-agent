import crypto from 'node:crypto';
import { db } from '../db/index.js';

/**
 * Google Calendar integration.
 *
 * Meetings are pushed to the salesman's real Google Calendar, so reminders,
 * notifications and the phone app are Google's job rather than ours. The .ics
 * path stays as the fallback for anyone who has not connected an account.
 *
 * Deliberately written against the REST API with `fetch` instead of pulling in
 * `googleapis` — we use four endpoints, and that package is enormous.
 *
 * Tokens are stored per salesman because the agent pushes events from cron
 * runs when nobody is logged in.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

/** calendar.events to write, readonly for free/busy when suggesting slots. */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `http://localhost:${process.env.API_PORT ?? 4310}/api/google/callback`;
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret) };
}

/* ------------------------------------------------------------ oauth state */

/**
 * The `state` parameter comes back from Google untrusted, so it is signed.
 * Without this, anyone could complete the callback and bind their own Google
 * account to another salesman's row.
 */
function stateSecret(): string {
  const row = db.prepare(`SELECT value FROM setting WHERE key = 'oauth_state_secret'`).get() as any;
  if (row?.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO setting (key, value) VALUES ('oauth_state_secret', ?)`).run(secret);
  return secret;
}

function signState(salesmanId: number): string {
  const payload = `${salesmanId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyState(state: string): number | null {
  try {
    const raw = Buffer.from(state, 'base64url').toString('utf8');
    const [id, ts, sig] = raw.split('.');
    const expect = crypto.createHmac('sha256', stateSecret()).update(`${id}.${ts}`).digest('hex').slice(0, 32);
    if (!sig || sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() - Number(ts) > 15 * 60_000) return null; // 15-minute window
    return Number(id);
  } catch {
    return null;
  }
}

export function authUrl(salesmanId: number): string | null {
  const { clientId, redirectUri, configured } = googleConfig();
  if (!configured) return null;
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId!);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');   // we need a refresh token
  u.searchParams.set('prompt', 'consent');        // force one, even on re-connect
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', signState(salesmanId));
  return u.toString();
}

/* ---------------------------------------------------------------- tokens */

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(json.error_description ?? json.error ?? `Google token error ${res.status}`);
  return json as TokenResponse;
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeCode(code: string, salesmanId: number) {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  const tok = await postForm(TOKEN_URL, {
    code,
    client_id: clientId!,
    client_secret: clientSecret!,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  db.prepare(
    `INSERT INTO google_account (salesman_id, google_email, access_token, refresh_token, expires_at, scope, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(salesman_id) DO UPDATE SET
       google_email  = excluded.google_email,
       access_token  = excluded.access_token,
       -- Google only returns a refresh token on first consent; keep the old one.
       refresh_token = COALESCE(excluded.refresh_token, google_account.refresh_token),
       expires_at    = excluded.expires_at,
       scope         = excluded.scope,
       last_error    = NULL,
       updated_at    = datetime('now')`,
  ).run(
    salesmanId,
    emailFromIdToken(tok.id_token),
    tok.access_token,
    tok.refresh_token ?? null,
    expiresAt,
    tok.scope ?? null,
  );

  return { email: emailFromIdToken(tok.id_token) };
}

export function googleAccount(salesmanId: number): any | null {
  return db.prepare('SELECT * FROM google_account WHERE salesman_id = ?').get(salesmanId) ?? null;
}

/** A valid access token, refreshing when the stored one has expired. */
async function accessTokenFor(salesmanId: number): Promise<string | null> {
  const acct = googleAccount(salesmanId);
  if (!acct?.refresh_token && !acct?.access_token) return null;

  const stillValid = acct.expires_at && new Date(acct.expires_at).getTime() > Date.now();
  if (stillValid && acct.access_token) return acct.access_token;
  if (!acct.refresh_token) return null;

  const { clientId, clientSecret } = googleConfig();
  try {
    const tok = await postForm(TOKEN_URL, {
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token',
    });
    const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
    db.prepare(
      `UPDATE google_account SET access_token = ?, expires_at = ?, last_error = NULL, updated_at = datetime('now')
        WHERE salesman_id = ?`,
    ).run(tok.access_token, expiresAt, salesmanId);
    return tok.access_token;
  } catch (err) {
    // A revoked or expired refresh token is a disconnect, not a transient error.
    db.prepare(`UPDATE google_account SET last_error = ?, updated_at = datetime('now') WHERE salesman_id = ?`)
      .run(`Reconnect needed: ${(err as Error).message}`, salesmanId);
    return null;
  }
}

export function disconnect(salesmanId: number) {
  db.prepare('DELETE FROM google_account WHERE salesman_id = ?').run(salesmanId);
  db.prepare('UPDATE meeting SET google_event_id = NULL WHERE salesman_id = ?').run(salesmanId);
}

/* ----------------------------------------------------------------- events */

const TZ = process.env.TZ_NAME ?? 'Asia/Karachi';

function eventBody(m: any) {
  const start = new Date(m.scheduled_at);
  const end = new Date(start.getTime() + (m.duration_min ?? 30) * 60_000);
  const contact = [m.contact_title, m.contact_name].filter(Boolean).join(' ');
  const isVisit = (m.mode ?? 'onsite') === 'onsite';

  return {
    summary: `SynChem — ${isVisit ? 'visit' : m.mode === 'call' ? 'call' : 'video call'} with ${m.company_name}`,
    location: m.location || m.area || undefined,
    description: [
      `${isVisit ? 'In-person visit' : 'Meeting'} on behalf of SynChem Global.`,
      `Company: ${m.company_name}`,
      contact ? `Contact: ${contact}${m.phone_e164 ? ` (${m.phone_e164})` : ''}` : '',
      m.booking_url ? `Reschedule: ${m.booking_url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end: { dateTime: end.toISOString(), timeZone: TZ },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 24 * 60 },
        { method: 'popup', minutes: 120 },
      ],
    },
    // Attendees are omitted on purpose: adding one makes Google email them,
    // which would bypass the outbound guard and reach a real customer.
    extendedProperties: { private: { salesAgentMeetingId: String(m.id) } },
  };
}

function meetingForSync(meetingId: number) {
  return db
    .prepare(
      `SELECT m.*, c.name AS company_name, c.area, c.contact_name, c.contact_title, c.phone_e164
         FROM meeting m JOIN company c ON c.id = m.company_id WHERE m.id = ?`,
    )
    .get(meetingId) as any;
}

async function calFetch(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${CAL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error?.message ?? `Google Calendar ${res.status}`);
  return json;
}

export interface SyncResult {
  synced: boolean;
  reason?: string;
  eventId?: string;
  htmlLink?: string;
}

/** Create or update the meeting on the salesman's Google Calendar. */
export async function pushMeeting(meetingId: number): Promise<SyncResult> {
  const m = meetingForSync(meetingId);
  if (!m) return { synced: false, reason: 'Meeting not found' };
  if (!googleConfig().configured) return { synced: false, reason: 'Google is not configured' };

  const token = await accessTokenFor(m.salesman_id);
  if (!token) return { synced: false, reason: 'This salesman has not connected Google Calendar' };

  const acct = googleAccount(m.salesman_id);
  const calId = encodeURIComponent(acct?.calendar_id ?? 'primary');

  try {
    let out: any;
    if (m.google_event_id) {
      out = await calFetch(token, `/calendars/${calId}/events/${encodeURIComponent(m.google_event_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(eventBody(m)),
      });
    } else {
      out = await calFetch(token, `/calendars/${calId}/events`, {
        method: 'POST',
        body: JSON.stringify(eventBody(m)),
      });
    }
    db.prepare(`UPDATE meeting SET google_event_id = ?, google_sync_error = NULL WHERE id = ?`).run(out.id, meetingId);
    return { synced: true, eventId: out.id, htmlLink: out.htmlLink };
  } catch (err) {
    const message = (err as Error).message;
    // A 404 means the event was deleted in Google; drop our id so the next
    // push recreates it instead of failing forever.
    if (/404|not found/i.test(message)) {
      db.prepare(`UPDATE meeting SET google_event_id = NULL WHERE id = ?`).run(meetingId);
    }
    db.prepare(`UPDATE meeting SET google_sync_error = ? WHERE id = ?`).run(message, meetingId);
    return { synced: false, reason: message };
  }
}

export async function removeMeeting(meetingId: number): Promise<SyncResult> {
  const m = meetingForSync(meetingId);
  if (!m?.google_event_id) return { synced: false, reason: 'Nothing on Google to remove' };

  const token = await accessTokenFor(m.salesman_id);
  if (!token) return { synced: false, reason: 'Not connected' };

  const acct = googleAccount(m.salesman_id);
  const calId = encodeURIComponent(acct?.calendar_id ?? 'primary');
  try {
    await calFetch(token, `/calendars/${calId}/events/${encodeURIComponent(m.google_event_id)}`, { method: 'DELETE' });
  } catch (err) {
    if (!/404|not found|410|deleted/i.test((err as Error).message)) {
      return { synced: false, reason: (err as Error).message };
    }
  }
  db.prepare(`UPDATE meeting SET google_event_id = NULL WHERE id = ?`).run(meetingId);
  return { synced: true };
}

/**
 * Busy blocks straight from Google, so the slot picker knows about the
 * salesman's real diary — dentist appointments included — not just meetings
 * this app happens to know about.
 */
export async function busyBlocks(salesmanId: number, fromIso: string, toIso: string): Promise<Array<{ start: string; end: string }>> {
  const token = await accessTokenFor(salesmanId);
  if (!token) return [];
  const acct = googleAccount(salesmanId);
  try {
    const out: any = await calFetch(token, '/freeBusy', {
      method: 'POST',
      body: JSON.stringify({
        timeMin: fromIso,
        timeMax: toIso,
        timeZone: TZ,
        items: [{ id: acct?.calendar_id ?? 'primary' }],
      }),
    });
    const cal = Object.values(out.calendars ?? {})[0] as any;
    return (cal?.busy ?? []).map((b: any) => ({ start: b.start, end: b.end }));
  } catch {
    return [];
  }
}

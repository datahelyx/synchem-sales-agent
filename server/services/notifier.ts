import { db } from '../db/index.js';
import { renderEmail, type EmailBlocks } from './email-template.js';

/**
 * Every outbound message is written to the `notification` outbox first, then a
 * channel adapter tries to deliver it. Two consequences that matter:
 *
 *  1. The pipeline runs end-to-end with zero credentials configured — messages
 *     just sit in the outbox where the manager can read them.
 *  2. Swapping WhatsApp for Odoo's mail queue later is one adapter, and the
 *     call sites do not change.
 *
 * Default channel for salesmen is `inapp` (their notification bell). WhatsApp
 * is the only channel that can reach company contacts, because 97.8% of the
 * imported companies have no email address at all.
 */

export type Channel = 'inapp' | 'whatsapp' | 'email' | 'console';
export type RecipientType = 'salesman' | 'contact' | 'manager';

/*
 * ---------------------------------------------------------------------------
 * Outbound guard — the thing standing between testing and messaging a real
 * business.
 *
 * The imported companies are real: real people, real WhatsApp numbers. Booking
 * a test meeting queues a real invite to them. Without a guard, that message
 * sits in the outbox looking harmless until someone adds a WhatsApp token and
 * clicks "Retry queued messages" — and then months of test data goes out at
 * once to actual customers.
 *
 * So delivery to EXTERNAL recipients is off unless deliberately switched on:
 *
 *   OUTBOUND_MODE=off        (default) never deliver to company contacts
 *   OUTBOUND_MODE=redirect   deliver, but re-addressed to OUTBOUND_REDIRECT_TO
 *   OUTBOUND_MODE=allowlist  deliver only to OUTBOUND_ALLOWLIST entries
 *   OUTBOUND_MODE=live       deliver to anyone — real customers included
 *
 * `redirect` is the one to test with: the whole pipeline runs for real, the
 * message is genuinely sent, but it lands in your own inbox with a banner
 * naming the company it was addressed to. No customer can receive anything
 * even if every credential is configured correctly.
 *
 * Blocked messages are stored as `suppressed`, not `queued`, so the outbox
 * drain can never pick them up later. They are still fully readable in the UI,
 * which is the point: you can check exactly what the agent would have said.
 *
 * Internal messages (a salesman's own inbox) are never restricted.
 */

export type OutboundMode = 'off' | 'redirect' | 'allowlist' | 'live';

export function outboundMode(): OutboundMode {
  const raw = (process.env.OUTBOUND_MODE ?? 'off').toLowerCase();
  if (raw === 'live' || raw === 'allowlist' || raw === 'redirect') return raw;
  return 'off';
}

export function redirectTarget(): string | null {
  return process.env.OUTBOUND_REDIRECT_TO?.trim() || null;
}

export function redirectPhone(): string | null {
  return process.env.OUTBOUND_REDIRECT_PHONE?.trim() || null;
}

/**
 * The redirect target has to suit the channel: rerouting a WhatsApp message to
 * an email address would just fail at the API, and a failure is not a safety
 * guarantee. Email redirects to OUTBOUND_REDIRECT_TO; WhatsApp needs its own
 * OUTBOUND_REDIRECT_PHONE, and is suppressed outright when that is missing.
 */
export function redirectTargetFor(channel: Channel): string | null {
  if (channel === 'whatsapp') return redirectPhone();
  return redirectTarget();
}

/**
 * Where a message should actually go, and how to label it. Returning a
 * different address than requested is the whole point in redirect mode.
 */
export function resolveRecipient(
  recipientType: RecipientType,
  toAddr: string | null | undefined,
  body: string,
  channel: Channel = 'email',
): { toAddr: string | null; body: string; redirected: boolean; bannerText?: string } {
  if (recipientType !== 'contact' || outboundMode() !== 'redirect') {
    return { toAddr: toAddr ?? null, body, redirected: false };
  }
  const target = redirectTargetFor(channel);
  if (!target) return { toAddr: toAddr ?? null, body, redirected: false };

  const banner =
    `[TEST REDIRECT] This message was addressed to ${toAddr ?? 'an unknown recipient'} ` +
    `and was rerouted to you. The real contact was NOT messaged.\n` +
    `${'-'.repeat(64)}\n\n`;
  return {
    toAddr: target,
    body: banner + body,
    redirected: true,
    bannerText: `Test redirect — addressed to ${toAddr ?? 'an unknown recipient'}, who was not contacted.`,
  };
}

function allowlist(): string[] {
  return (process.env.OUTBOUND_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Why a message may not be delivered, or null when it may. */
export function blockReason(
  recipientType: RecipientType,
  toAddr: string | null | undefined,
  channel: Channel = 'email',
): string | null {
  if (recipientType !== 'contact') return null; // internal recipients are always fine

  const mode = outboundMode();
  if (mode === 'live') return null;
  if (mode === 'off') {
    return 'Blocked: OUTBOUND_MODE is "off", so nothing is delivered to real company contacts.';
  }
  if (mode === 'redirect') {
    // Safe by construction — resolveRecipient has already re-addressed it.
    if (redirectTargetFor(channel)) return null;
    return channel === 'whatsapp'
      ? 'Blocked: no OUTBOUND_REDIRECT_PHONE is set, so this WhatsApp message has nowhere safe to go.'
      : 'Blocked: OUTBOUND_MODE is "redirect" but OUTBOUND_REDIRECT_TO is not set.';
  }

  const to = (toAddr ?? '').trim().toLowerCase();
  if (to && allowlist().includes(to)) return null;
  return `Blocked: ${toAddr ?? 'this recipient'} is not in OUTBOUND_ALLOWLIST.`;
}

export interface Attachment {
  filename: string;
  content: string;
  /** e.g. 'text/calendar; charset=utf-8; method=REQUEST' */
  contentType: string;
}

export interface OutboundMessage {
  channel: Channel;
  template: string;
  recipientType: RecipientType;
  recipientId?: number | null;
  toAddr?: string | null;
  subject?: string | null;
  body: string;
  payload?: unknown;
  /** Email only — a calendar invite rides along here. Never persisted. */
  attachments?: Attachment[];
  /**
   * Structured content for the HTML email. The plain `body` is still required
   * and is what gets stored and shown in the in-app outbox; this only changes
   * how the email itself looks.
   */
  email?: EmailBlocks;
}

export interface ChannelAdapter {
  name: Channel;
  /** Returns true when the message actually went out. Throw to mark it failed. */
  send(msg: OutboundMessage & { id: number }): Promise<boolean> | boolean;
}

const adapters = new Map<Channel, ChannelAdapter>();

export function registerAdapter(a: ChannelAdapter) {
  adapters.set(a.name, a);
}

/** In-app messages are "delivered" the moment they are in the table. */
registerAdapter({ name: 'inapp', send: () => true });

registerAdapter({
  name: 'console',
  send: (m) => {
    console.log(`[notify:console] ${m.template} -> ${m.toAddr ?? m.recipientType}\n${m.body}\n`);
    return true;
  },
});

/**
 * WhatsApp Cloud API. Left unconfigured on purpose: without
 * WHATSAPP_TOKEN + WHATSAPP_PHONE_ID the message stays queued and shows up in
 * the manager's outbox as "would have sent", which is what you want before a
 * real number is allow-listed.
 */
registerAdapter({
  name: 'whatsapp',
  send: async (m) => {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId || !m.toAddr) return false;

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: m.toAddr.replace('+', ''),
        type: 'text',
        text: { body: m.body },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
    return true;
  },
});

/**
 * SMTP. Stays queued until SMTP_HOST + SMTP_USER + SMTP_PASS are set, so no
 * credentials live in this repo. With OUTBOUND_MODE=redirect the recipient has
 * already been rewritten by the time we get here, so a correctly configured
 * mailbox still cannot reach a real customer.
 */
registerAdapter({
  name: 'email',
  send: async (m) => {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass || !m.toAddr) return false;

    const nodemailer = await import('nodemailer');
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 587 upgrades via STARTTLS instead
      auth: { user, pass },
    });

    await transport.sendMail({
      from: `SynChem Global <${process.env.SMTP_FROM ?? user}>`,
      to: m.toAddr,
      subject: m.subject ?? 'Message from SynChem',
      text: m.body,
      ...(m.email ? { html: renderEmail(m.email) } : {}),
      // A text/calendar part is what makes Gmail and Outlook show "Add to
      // calendar" and then run their own reminders on the recipient's device.
      ...(m.attachments?.length
        ? {
            icalEvent: m.attachments.find((a) => a.contentType.startsWith('text/calendar'))
              ? {
                  method: /method=(\w+)/i.exec(m.attachments.find((a) => a.contentType.startsWith('text/calendar'))!.contentType)?.[1] ?? 'REQUEST',
                  content: m.attachments.find((a) => a.contentType.startsWith('text/calendar'))!.content,
                }
              : undefined,
            attachments: m.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          }
        : {}),
    });
    return true;
  },
});

export async function notify(msg: OutboundMessage): Promise<number> {
  // Re-address BEFORE storing, so the outbox shows where the message really
  // went rather than where it was originally aimed.
  const routed = resolveRecipient(msg.recipientType, msg.toAddr, msg.body, msg.channel);
  const subject = routed.redirected ? `[TEST] ${msg.subject ?? ''}`.trim() : msg.subject ?? null;
  const outgoing: OutboundMessage = {
    ...msg,
    toAddr: routed.toAddr,
    body: routed.body,
    subject,
    email: msg.email ? { ...msg.email, banner: routed.bannerText ?? msg.email.banner } : undefined,
  };

  const row = await db
    .prepare(
      `INSERT INTO notification (channel, template, recipient_type, recipient_id, to_addr, subject, body, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      outgoing.channel,
      outgoing.template,
      outgoing.recipientType,
      outgoing.recipientId ?? null,
      outgoing.toAddr,
      outgoing.subject ?? null,
      outgoing.body,
      JSON.stringify({
        ...(typeof msg.payload === 'object' && msg.payload ? msg.payload : {}),
        ...(routed.redirected ? { redirectedFrom: msg.toAddr } : {}),
      }),
    );

  const id = Number(row.lastInsertRowid);

  // Never hand a real company contact to an adapter unless explicitly enabled.
  const blocked = blockReason(outgoing.recipientType, msg.toAddr, outgoing.channel);
  if (blocked) {
    await db.prepare(`UPDATE notification SET status = 'suppressed', error = ? WHERE id = ?`).run(blocked, id);
    return id;
  }

  const adapter = adapters.get(outgoing.channel);
  if (!adapter) return id;

  try {
    const sent = await adapter.send({ ...outgoing, id });
    if (sent) {
      await db.prepare(`UPDATE notification SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(id);
    }
  } catch (err) {
    await db.prepare(`UPDATE notification SET status = 'failed', error = ? WHERE id = ?`).run(String(err), id);
  }
  return id;
}

/** Regenerate the calendar invite for a stored row, when it had one. */
async function rebuildAttachments(row: any): Promise<Attachment[] | undefined> {
  if (row.channel !== 'email') return undefined;
  let meetingId: number | undefined;
  try {
    meetingId = JSON.parse(row.payload_json ?? '{}')?.meetingId;
  } catch {
    return undefined;
  }
  if (!meetingId) return undefined;

  const { icsForMeeting } = await import('./calendar.js');
  const ics = await icsForMeeting(meetingId, { method: 'REQUEST' });
  if (!ics) return undefined;
  return [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }];
}

/**
 * Retry anything still queued/failed on a channel that is now configured.
 *
 * `suppressed` rows are deliberately NOT picked up — a message blocked when it
 * was created stays blocked, so switching credentials on later cannot flush a
 * backlog of test messages at real customers. The guard is re-evaluated on
 * every attempt anyway, in case the mode was tightened since.
 */
export async function drainOutbox(limit = 50) {
  const rows = await db
    .prepare(`SELECT * FROM notification WHERE status IN ('queued','failed') ORDER BY id LIMIT ?`)
    .all(limit) as any[];

  let sent = 0;
  let blocked = 0;
  for (const r of rows) {
    const reason = blockReason(r.recipient_type as RecipientType, r.to_addr, r.channel as Channel);
    if (reason) {
      await db.prepare(`UPDATE notification SET status = 'suppressed', error = ? WHERE id = ?`).run(reason, r.id);
      blocked++;
      continue;
    }
    const adapter = adapters.get(r.channel as Channel);
    if (!adapter) continue;
    try {
      // Attachments are never stored, so a queued calendar invite has to be
      // rebuilt at send time — otherwise a message that waited for SMTP would
      // arrive without the .ics that makes it a calendar entry.
      const attachments = await rebuildAttachments(r);
      const ok = await adapter.send({
        ...r,
        body: r.body,
        toAddr: r.to_addr,
        recipientType: r.recipient_type,
        attachments,
      });
      if (ok) {
        await db.prepare(`UPDATE notification SET status = 'sent', sent_at = datetime('now'), error = NULL WHERE id = ?`).run(r.id);
        sent++;
      }
    } catch (err) {
      await db.prepare(`UPDATE notification SET status = 'failed', error = ? WHERE id = ?`).run(String(err), r.id);
    }
  }
  return { attempted: rows.length, sent, blocked };
}

/** A wa.me link is the fallback when the API is not configured — it always works. */
export function waLink(e164: string | null, text: string): string | null {
  if (!e164) return null;
  return `https://wa.me/${e164.replace('+', '')}?text=${encodeURIComponent(text)}`;
}

import { db, migrate } from '../db/index.js';
import { blockReason, drainOutbox, notify, outboundMode, resolveRecipient } from '../services/notifier.js';
import { seedIfEmpty } from './seed-data.js';

/**
 * Proves the outbound guard holds: a real company contact must never be
 * delivered to while OUTBOUND_MODE is off or allowlist, including via the
 * outbox drain after credentials appear.
 */

await migrate();
await seedIfEmpty();

const REAL_CONTACT = '+924200000000'; // a genuine number from the imported CSV
const MY_TEST_NUMBER = '+923001112222';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const statusOf = async (id: number) => (await db.prepare('SELECT status FROM notification WHERE id = ?').get(id) as any).status;

// The test drives each mode itself; .env must not decide the outcome.
process.env.OUTBOUND_MODE = 'off';
delete process.env.OUTBOUND_REDIRECT_TO;

console.log(`\n--- mode: ${outboundMode()} ---`);
check('a real contact is blocked', blockReason('contact', REAL_CONTACT) !== null, true);
check('a salesman is never blocked', blockReason('salesman', null), null);

const blockedId = await notify({
  channel: 'whatsapp', template: 'test', recipientType: 'contact',
  toAddr: REAL_CONTACT, body: 'test message to a real company',
});
check('message to a real contact is suppressed, not queued', await statusOf(blockedId), 'suppressed');

// The dangerous path: credentials turn up later and someone hits "retry".
process.env.WHATSAPP_TOKEN = 'fake-token-for-this-test';
process.env.WHATSAPP_PHONE_ID = '000000';
const drained = await drainOutbox();
check('outbox drain does not release suppressed messages', await statusOf(blockedId), 'suppressed');
check('drain reported nothing sent', drained.sent, 0);
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_ID;

console.log('\n--- mode: redirect ---');
process.env.OUTBOUND_MODE = 'redirect';
process.env.OUTBOUND_REDIRECT_TO = 'you@example.com';

const routed = resolveRecipient('contact', 'contact@example-industries.test', 'Original invite text.');
check('recipient is rewritten to the test inbox', routed.toAddr, 'you@example.com');
check('redirect is flagged', routed.redirected, true);
check('body carries a banner naming the real recipient', routed.body.includes('contact@example-industries.test'), true);
check('banner states the contact was not messaged', routed.body.includes('was NOT messaged'), true);

const redirectedId = await notify({
  channel: 'email', template: 'test', recipientType: 'contact',
  toAddr: 'contact@example-industries.test', subject: 'Meeting confirmation', body: 'Original invite text.',
});
const stored = await db.prepare('SELECT to_addr, subject FROM notification WHERE id = ?').get(redirectedId) as any;
check('the OUTBOX ROW stores the test inbox, not the company', stored.to_addr, 'you@example.com');
check('subject is marked as a test', stored.subject.startsWith('[TEST]'), true);
check(
  'no row anywhere is addressed to the real company',
  (await db.prepare("SELECT COUNT(*) AS n FROM notification WHERE to_addr LIKE '%example-industries.test'").get() as any).n,
  0,
);
check('a salesman message is NOT redirected', resolveRecipient('salesman', null, 'hi').redirected, false);

// An email inbox is not a valid WhatsApp destination — better to hold the
// message than to reroute it somewhere that cannot receive it.
check(
  'WhatsApp is blocked when only an email redirect is configured',
  blockReason('contact', REAL_CONTACT, 'whatsapp') !== null,
  true,
);
const waId = await notify({
  channel: 'whatsapp', template: 'test', recipientType: 'contact',
  toAddr: REAL_CONTACT, body: 'wa test',
});
check('that WhatsApp message is suppressed', await statusOf(waId), 'suppressed');

process.env.OUTBOUND_REDIRECT_PHONE = MY_TEST_NUMBER;
check('with a redirect phone set, WhatsApp is allowed', blockReason('contact', REAL_CONTACT, 'whatsapp'), null);
check(
  'and it is re-addressed to the test number',
  resolveRecipient('contact', REAL_CONTACT, 'wa test', 'whatsapp').toAddr,
  MY_TEST_NUMBER,
);
delete process.env.OUTBOUND_REDIRECT_PHONE;

console.log('\n--- mode: allowlist ---');
process.env.OUTBOUND_MODE = 'allowlist';
process.env.OUTBOUND_ALLOWLIST = MY_TEST_NUMBER;
check('real contact still blocked', blockReason('contact', REAL_CONTACT) !== null, true);
check('my own number is allowed', blockReason('contact', MY_TEST_NUMBER), null);
check('allowlist match ignores case/space', blockReason('contact', ` ${MY_TEST_NUMBER} `), null);

console.log('\n--- mode: live ---');
process.env.OUTBOUND_MODE = 'live';
check('live mode allows a real contact', blockReason('contact', REAL_CONTACT), null);

process.env.OUTBOUND_MODE = 'off';
delete process.env.OUTBOUND_REDIRECT_TO;
await db.prepare('DELETE FROM notification WHERE template = ?').run('test');

console.log(`\n${failures === 0 ? 'All guard checks passed.' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

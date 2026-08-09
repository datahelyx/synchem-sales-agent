import '../env.js';
import { outboundMode, redirectTarget } from '../services/notifier.js';

/**
 * Verifies the SMTP settings in .env by sending one message to your own
 * address. Deliberately refuses to send anywhere except OUTBOUND_REDIRECT_TO,
 * so this script can never touch a company contact.
 */

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT ?? 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM ?? user;
const to = redirectTarget();

const missing = [
  !host && 'SMTP_HOST',
  !user && 'SMTP_USER',
  !pass && 'SMTP_PASS',
].filter(Boolean);

if (missing.length) {
  console.error(`\nStill missing in .env: ${missing.join(', ')}`);
  console.error('SMTP_PASS must be a Google app password (16 characters), not your Gmail password.');
  console.error('Generate one at https://myaccount.google.com/apppasswords\n');
  process.exit(1);
}
if (!to) {
  console.error('\nOUTBOUND_REDIRECT_TO is not set, and this script will not send anywhere else.\n');
  process.exit(1);
}

console.log(`\nSending a test message`);
console.log(`  from : ${from}`);
console.log(`  to   : ${to}`);
console.log(`  via  : ${host}:${port}`);
console.log(`  mode : OUTBOUND_MODE=${outboundMode()}\n`);

const nodemailer = await import('nodemailer');
const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user: user!, pass: pass! },
});

try {
  await transport.verify();
  console.log('Login accepted.');
} catch (err) {
  const msg = (err as Error).message;
  console.error(`\nLogin failed: ${msg}\n`);
  if (/535|credentials|auth/i.test(msg)) {
    console.error('That usually means the password is a normal account password rather than an');
    console.error('app password, or 2-Step Verification is not switched on yet.');
    console.error('Fix: https://myaccount.google.com/apppasswords\n');
  }
  process.exit(1);
}

const info = await transport.sendMail({
  from,
  to,
  subject: '[TEST] AI Sales Manager — SMTP is working',
  text:
    'If you are reading this, the SMTP settings in .env are correct.\n\n' +
    'Meeting invites will now be delivered — and while OUTBOUND_MODE=redirect they all\n' +
    'arrive here rather than at the company they were addressed to.\n',
});

console.log(`Sent. Message id: ${info.messageId}`);
console.log(`Check ${to} — it may take a minute, and look in spam the first time.\n`);

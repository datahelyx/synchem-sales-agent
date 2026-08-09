import { db, tx } from '../db/index.js';
import { today } from '../lib/dates.js';
import { logActivity, setStage } from '../services/pipeline.js';

/** Samples and invoices — the two things that come out of a logged meeting. */

export interface SampleLineInput {
  productId: number;
  qty: number;
}

export function createOrReplaceSampleRequest(input: {
  feedbackId: number | null;
  companyId: number;
  salesmanId: number;
  lines: SampleLineInput[];
  courier?: string | null;
  trackingRef?: string | null;
}) {
  return tx(() => {
    // Editing feedback can change the sample list, so replace rather than
    // append — and reverse the old stock movements first so on-hand is right.
    const existing = input.feedbackId
      ? (db.prepare('SELECT * FROM sample_request WHERE feedback_id = ?').get(input.feedbackId) as any)
      : null;

    let requestId: number;
    if (existing) {
      requestId = existing.id;
      reverseStock('sample_request', requestId);
      db.prepare('DELETE FROM sample_line WHERE sample_request_id = ?').run(requestId);
      db.prepare(
        `UPDATE sample_request SET courier = ?, tracking_ref = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(input.courier ?? null, input.trackingRef ?? null, requestId);
    } else {
      const r = db
        .prepare(
          `INSERT INTO sample_request (feedback_id, company_id, salesman_id, courier, tracking_ref)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.feedbackId, input.companyId, input.salesmanId, input.courier ?? null, input.trackingRef ?? null);
      requestId = Number(r.lastInsertRowid);
    }

    const insLine = db.prepare(
      'INSERT INTO sample_line (sample_request_id, product_id, qty) VALUES (?, ?, ?)',
    );
    for (const l of input.lines) {
      if (!l.productId || !(l.qty > 0)) continue;
      insLine.run(requestId, l.productId, l.qty);
      moveStock(l.productId, -l.qty, 'sample_dispatch', 'sample_request', requestId);
    }

    if (input.lines.length) {
      setStage(input.companyId, 'sample_sent', { salesmanId: input.salesmanId, actor: 'salesman' });
      logActivity({
        companyId: input.companyId,
        salesmanId: input.salesmanId,
        kind: 'sample',
        summary: `Sample request with ${input.lines.length} product${input.lines.length === 1 ? '' : 's'}`,
        detail: input.lines,
        actor: 'salesman',
      });
    }
    return requestId;
  });
}

export function deleteSampleRequestForFeedback(feedbackId: number) {
  const existing = db.prepare('SELECT * FROM sample_request WHERE feedback_id = ?').get(feedbackId) as any;
  if (!existing) return;
  tx(() => {
    reverseStock('sample_request', existing.id);
    db.prepare('DELETE FROM sample_request WHERE id = ?').run(existing.id);
  });
}

function moveStock(productId: number, qty: number, reason: string, refTable: string, refId: number) {
  db.prepare(
    'INSERT INTO stock_move (product_id, qty, reason, ref_table, ref_id) VALUES (?, ?, ?, ?, ?)',
  ).run(productId, qty, reason, refTable, refId);
  db.prepare(`UPDATE product SET stock_qty = stock_qty + ?, updated_at = datetime('now') WHERE id = ?`).run(qty, productId);
}

/** Undo every movement tied to a record, so an edit cannot double-count stock. */
function reverseStock(refTable: string, refId: number) {
  const moves = db
    .prepare('SELECT product_id, SUM(qty) AS qty FROM stock_move WHERE ref_table = ? AND ref_id = ? GROUP BY product_id')
    .all(refTable, refId) as any[];
  for (const m of moves) {
    if (!m.qty) continue;
    moveStock(m.product_id, -m.qty, 'adjustment', refTable, refId);
  }
}

function nextInvoiceNumber(): string {
  const year = today().slice(0, 4);
  const row = db
    .prepare(`SELECT number FROM invoice WHERE number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`INV-${year}-%`) as any;
  const seq = row ? Number(String(row.number).split('-').pop()) + 1 : 1;
  return `INV-${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * "Approved auto-closes the deal and generates an invoice." Idempotent: editing
 * an approved feedback updates the existing invoice instead of issuing a second
 * one, and flipping the outcome away from approved cancels it (never deletes —
 * a cancelled invoice is auditable, a missing one is not).
 */
export function syncInvoiceForFeedback(feedbackId: number) {
  const f = db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId) as any;
  if (!f) return null;

  const existing = db.prepare('SELECT * FROM invoice WHERE feedback_id = ?').get(feedbackId) as any;

  if (f.outcome !== 'approved') {
    if (existing && existing.status !== 'cancelled') {
      db.prepare(`UPDATE invoice SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(existing.id);
      logActivity({
        companyId: f.company_id,
        salesmanId: f.salesman_id,
        kind: 'invoice',
        summary: `Invoice ${existing.number} cancelled — outcome changed to ${f.outcome}`,
        actor: 'salesman',
      });
    }
    return null;
  }

  const amount = Number(f.deal_value ?? 0);
  const taxRate = Number(process.env.TAX_RATE ?? 0);
  const total = amount * (1 + taxRate);

  return tx(() => {
    let invoiceId: number;
    if (existing) {
      invoiceId = existing.id;
      db.prepare(
        `UPDATE invoice SET subtotal = ?, tax_rate = ?, total = ?, status = CASE WHEN status = 'cancelled' THEN 'draft' ELSE status END,
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(amount, taxRate, total, invoiceId);
      db.prepare('DELETE FROM invoice_line WHERE invoice_id = ?').run(invoiceId);

      // Without this the timeline's last word on an invoice stays "cancelled"
      // even after the outcome flips back to approved.
      const reinstated = existing.status === 'cancelled';
      const repriced = Number(existing.subtotal) !== amount;
      if (reinstated || repriced) {
        logActivity({
          companyId: f.company_id,
          salesmanId: f.salesman_id,
          kind: 'invoice',
          summary: reinstated
            ? `Invoice ${existing.number} reinstated for PKR ${total.toLocaleString('en-PK')}`
            : `Invoice ${existing.number} updated to PKR ${total.toLocaleString('en-PK')}`,
          detail: { invoiceId, from: existing.subtotal, to: amount },
          actor: 'salesman',
        });
      }
    } else {
      const number = nextInvoiceNumber();
      const r = db
        .prepare(
          `INSERT INTO invoice (number, company_id, salesman_id, feedback_id, due_date, subtotal, tax_rate, total)
           VALUES (?, ?, ?, ?, date('now', '+30 day'), ?, ?, ?)`,
        )
        .run(number, f.company_id, f.salesman_id, feedbackId, amount, taxRate, total);
      invoiceId = Number(r.lastInsertRowid);
      logActivity({
        companyId: f.company_id,
        salesmanId: f.salesman_id,
        kind: 'invoice',
        summary: `Deal approved — invoice ${number} generated for PKR ${total.toLocaleString('en-PK')}`,
        detail: { invoiceId, amount },
        actor: 'agent',
      });
    }

    /*
     * One line for the agreed value.
     *
     * It is tempting to itemise the sample products here, but a sample is what
     * the customer asked to *evaluate* — not what they bought, and not at the
     * quantity they bought. Spreading the deal value across 1 kg of sample
     * produces a unit price that is simply untrue. Until the app captures a
     * real order (quantities against SKUs), the honest invoice is the agreed
     * figure, with the samples named for context only.
     */
    const sample = db.prepare('SELECT * FROM sample_request WHERE feedback_id = ?').get(feedbackId) as any;
    const sampled = sample
      ? (db
          .prepare(
            `SELECT p.name FROM sample_line sl JOIN product p ON p.id = sl.product_id
              WHERE sl.sample_request_id = ?`,
          )
          .all(sample.id) as any[]).map((r) => r.name)
      : [];

    const description = sampled.length
      ? `Agreed supply following evaluation of ${sampled.join(', ')}`
      : 'Agreed supply — see meeting notes';

    db.prepare(
      'INSERT INTO invoice_line (invoice_id, product_id, description, qty, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(invoiceId, null, description, 1, amount, amount);

    setStage(f.company_id, 'won', { salesmanId: f.salesman_id, actor: 'salesman' });
    return invoiceId;
  });
}

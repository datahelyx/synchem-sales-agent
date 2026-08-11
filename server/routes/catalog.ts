import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { asyncRoute, HttpError, intParam, parseBody } from '../lib/http.js';
import { logActivity, recordRevision } from '../services/pipeline.js';

export const catalogRouter = Router();

/* -------------------------------------------------------------- products */

catalogRouter.get(
  '/products',
  asyncRoute(async (req, res) => {
    const { q, category, inStock } = req.query as Record<string, string>;
    const where = ['active = 1'];
    const params: any[] = [];
    if (q) { where.push('(name LIKE ? OR sku LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (inStock === 'true') where.push('stock_qty > 0');
    res.json(await db.prepare(`SELECT * FROM product WHERE ${where.join(' AND ')} ORDER BY category, name`).all(...params));
  }),
);

const productInput = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  pack_size: z.string().nullable().optional(),
  uom: z.string().default('kg'),
  unit_price: z.number().nonnegative().default(0),
  stock_qty: z.number().default(0),
  sample_qty: z.number().positive().default(1),
});

catalogRouter.post(
  '/products',
  asyncRoute(async (req, res) => {
    const p = parseBody(productInput, req.body);
    const existing = await db.prepare('SELECT id FROM product WHERE sku = ?').get(p.sku);
    if (existing) throw new HttpError(409, `SKU ${p.sku} already exists`);
    const r = await db
      .prepare(
        `INSERT INTO product (sku, name, category, pack_size, uom, unit_price, stock_qty, sample_qty)
         VALUES (@sku, @name, @category, @pack_size, @uom, @unit_price, @stock_qty, @sample_qty)`,
      )
      .run({ ...p, category: p.category ?? null, pack_size: p.pack_size ?? null });
    const id = Number(r.lastInsertRowid);
    if (p.stock_qty) {
      await db.prepare(`INSERT INTO stock_move (product_id, qty, reason) VALUES (?, ?, 'restock')`).run(id, p.stock_qty);
    }
    res.status(201).json(await db.prepare('SELECT * FROM product WHERE id = ?').get(id));
  }),
);

catalogRouter.patch(
  '/products/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(productInput.partial().extend({ active: z.boolean().optional() }), req.body);
    const before = await db.prepare('SELECT * FROM product WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Product not found');

    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'stock_qty') continue; // stock only moves via stock_move
      sets.push(`${k} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) {
      sets.push(`updated_at = datetime('now')`);
      await db.prepare(`UPDATE product SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    if (patch.stock_qty !== undefined && patch.stock_qty !== before.stock_qty) {
      const delta = patch.stock_qty - before.stock_qty;
      await db.prepare(`INSERT INTO stock_move (product_id, qty, reason) VALUES (?, ?, 'adjustment')`).run(id, delta);
      await db.prepare(`UPDATE product SET stock_qty = stock_qty + ? WHERE id = ?`).run(delta, id);
    }
    const after = await db.prepare('SELECT * FROM product WHERE id = ?').get(id);
    await recordRevision('product', id, before, after);
    res.json(after);
  }),
);

/* --------------------------------------------------------------- samples */

catalogRouter.get(
  '/samples',
  asyncRoute(async (req, res) => {
    const { status } = req.query as Record<string, string>;
    const clause = status ? 'WHERE sr.status = ?' : '';
    const rows = await db
      .prepare(
        `SELECT sr.*, c.name AS company_name, s.name AS salesman_name
           FROM sample_request sr
           JOIN company  c ON c.id = sr.company_id
           JOIN salesman s ON s.id = sr.salesman_id
           ${clause}
           ORDER BY sr.id DESC LIMIT 200`,
      )
      .all(...(status ? [status] : [])) as any[];
    const lines = await db.prepare(
      `SELECT sl.sample_request_id, sl.qty, p.name, p.uom, p.sku FROM sample_line sl JOIN product p ON p.id = sl.product_id`,
    ).all() as any[];
    for (const r of rows) r.lines = lines.filter((l) => l.sample_request_id === r.id);
    res.json(rows);
  }),
);

catalogRouter.patch(
  '/samples/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(
      z.object({
        status: z.enum(['draft', 'dispatched', 'delivered', 'cancelled']).optional(),
        courier: z.string().nullable().optional(),
        trackingRef: z.string().nullable().optional(),
      }),
      req.body,
    );
    const before = await db.prepare('SELECT * FROM sample_request WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Sample request not found');

    await db.prepare(
      `UPDATE sample_request SET status = COALESCE(?, status), courier = COALESCE(?, courier),
              tracking_ref = COALESCE(?, tracking_ref),
              dispatched_at = CASE WHEN ? = 'dispatched' THEN datetime('now') ELSE dispatched_at END,
              delivered_at  = CASE WHEN ? = 'delivered'  THEN datetime('now') ELSE delivered_at  END,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(patch.status ?? null, patch.courier ?? null, patch.trackingRef ?? null, patch.status ?? '', patch.status ?? '', id);

    if (patch.status) {
      await logActivity({
        companyId: before.company_id, salesmanId: before.salesman_id, kind: 'sample',
        summary: `Sample request ${patch.status}`, actor: 'manager',
      });
    }
    res.json(await db.prepare('SELECT * FROM sample_request WHERE id = ?').get(id));
  }),
);

/* -------------------------------------------------------------- invoices */

catalogRouter.get(
  '/invoices',
  asyncRoute(async (req, res) => {
    const { status } = req.query as Record<string, string>;
    const clause = status ? 'WHERE i.status = ?' : '';
    const rows = await db
      .prepare(
        `SELECT i.*, c.name AS company_name, s.name AS salesman_name
           FROM invoice i JOIN company c ON c.id = i.company_id JOIN salesman s ON s.id = i.salesman_id
           ${clause} ORDER BY i.id DESC LIMIT 200`,
      )
      .all(...(status ? [status] : [])) as any[];
    for (const r of rows) r.lines = await db.prepare('SELECT * FROM invoice_line WHERE invoice_id = ?').all(r.id);
    res.json(rows);
  }),
);

catalogRouter.patch(
  '/invoices/:id',
  asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    const patch = parseBody(
      z.object({
        status: z.enum(['draft', 'sent', 'paid', 'cancelled']).optional(),
        subtotal: z.number().nonnegative().optional(),
        taxRate: z.number().min(0).max(1).optional(),
        dueDate: z.string().nullable().optional(),
      }),
      req.body,
    );
    const before = await db.prepare('SELECT * FROM invoice WHERE id = ?').get(id) as any;
    if (!before) throw new HttpError(404, 'Invoice not found');

    const subtotal = patch.subtotal ?? before.subtotal;
    const taxRate = patch.taxRate ?? before.tax_rate;
    await db.prepare(
      `UPDATE invoice SET status = COALESCE(?, status), subtotal = ?, tax_rate = ?, total = ?,
              due_date = COALESCE(?, due_date), updated_at = datetime('now') WHERE id = ?`,
    ).run(patch.status ?? null, subtotal, taxRate, subtotal * (1 + taxRate), patch.dueDate ?? null, id);

    const after = await db.prepare('SELECT * FROM invoice WHERE id = ?').get(id);
    await recordRevision('invoice', id, before, after);
    await logActivity({
      companyId: before.company_id, salesmanId: before.salesman_id, kind: 'invoice',
      summary: `Invoice ${before.number} updated${patch.status ? ` → ${patch.status}` : ''}`, actor: 'manager',
    });
    res.json(after);
  }),
);

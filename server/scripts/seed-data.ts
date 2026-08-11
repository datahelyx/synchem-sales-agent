import { db, tx } from '../db/index.js';

/**
 * First-run seed: the reason codes the feedback form offers, a small sales
 * team, and a starter product catalogue.
 *
 * The products are placeholders shaped like a specialty-chemicals catalogue —
 * replace them from Products → Add, or by editing this file, once the real
 * SynChem SKU list is available. Nothing depends on these specific rows.
 */

const REASONS: Array<[string, string, string, number]> = [
  ['positive', 'needs_sample', 'Wants to evaluate a sample first', 1],
  ['positive', 'price_discussion', 'Interested, negotiating price', 2],
  ['positive', 'needs_approval', 'Needs internal approval', 3],
  ['positive', 'future_requirement', 'Requirement expected later', 4],
  ['positive', 'wants_more_info', 'Asked for technical documentation', 5],

  ['approved', 'trial_order', 'Placed a trial order', 1],
  ['approved', 'full_order', 'Placed a full order', 2],
  ['approved', 'contract', 'Signed a supply agreement', 3],
  ['approved', 'switched_supplier', 'Switching from current supplier', 4],

  ['rejected', 'price_too_high', 'Our price is too high', 1],
  ['rejected', 'existing_supplier', 'Happy with existing supplier', 2],
  ['rejected', 'no_requirement', 'No requirement for our products', 3],
  ['rejected', 'quality_concern', 'Concerns about quality or specs', 4],
  ['rejected', 'budget_frozen', 'Budget frozen / company not buying', 5],
  ['rejected', 'unresponsive', 'Contact went unresponsive', 6],
  ['rejected', 'wrong_contact', 'Not the right person to decide', 7],
];

const PRODUCTS: Array<[string, string, string, string, string, number, number]> = [
  // sku, name, category, pack_size, uom, unit_price (PKR), stock
  ['SC-ACD-001', 'Acetic Acid Glacial 99.8%', 'Acids', '30 kg carboy', 'kg', 480, 1200],
  ['SC-ACD-002', 'Hydrochloric Acid 33%', 'Acids', '35 kg carboy', 'kg', 210, 900],
  ['SC-SOL-001', 'Isopropyl Alcohol 99.9%', 'Solvents', '160 kg drum', 'kg', 720, 640],
  ['SC-SOL-002', 'Toluene Industrial Grade', 'Solvents', '180 kg drum', 'kg', 560, 400],
  ['SC-SOL-003', 'Ethyl Acetate 99%', 'Solvents', '180 kg drum', 'kg', 640, 300],
  ['SC-DYE-001', 'Reactive Red 195', 'Dyes & Pigments', '25 kg bag', 'kg', 3200, 180],
  ['SC-DYE-002', 'Disperse Blue 79', 'Dyes & Pigments', '25 kg bag', 'kg', 2950, 140],
  ['SC-TEX-001', 'Softener Silicone Emulsion', 'Textile Auxiliaries', '50 kg drum', 'kg', 890, 500],
  ['SC-TEX-002', 'Wetting Agent NP-9', 'Textile Auxiliaries', '50 kg drum', 'kg', 760, 420],
  ['SC-TEX-003', 'Sequestering Agent SQ-40', 'Textile Auxiliaries', '50 kg drum', 'kg', 640, 380],
  ['SC-SUR-001', 'Sodium Lauryl Ether Sulphate 70%', 'Surfactants', '200 kg drum', 'kg', 690, 700],
  ['SC-SUR-002', 'Linear Alkyl Benzene Sulphonic Acid', 'Surfactants', '215 kg drum', 'kg', 730, 550],
  ['SC-POL-001', 'Titanium Dioxide Rutile', 'Pigments & Fillers', '25 kg bag', 'kg', 1450, 800],
  ['SC-POL-002', 'Calcium Carbonate Coated', 'Pigments & Fillers', '25 kg bag', 'kg', 95, 2400],
  ['SC-FOO-001', 'Citric Acid Monohydrate (Food Grade)', 'Food Grade', '25 kg bag', 'kg', 520, 900],
  ['SC-FOO-002', 'Sodium Benzoate (Food Grade)', 'Food Grade', '25 kg bag', 'kg', 780, 350],
  ['SC-PHR-001', 'Propylene Glycol USP', 'Pharma Grade', '215 kg drum', 'kg', 810, 260],
  ['SC-PHR-002', 'Glycerine USP 99.7%', 'Pharma Grade', '250 kg drum', 'kg', 690, 300],
  ['SC-WTR-001', 'Poly Aluminium Chloride', 'Water Treatment', '25 kg bag', 'kg', 175, 1600],
  ['SC-WTR-002', 'Antiscalant AS-200', 'Water Treatment', '30 kg carboy', 'kg', 940, 220],
];

const TEAM: Array<[string, string, string | null, string, number, string | null]> = [
  // name, role, phone, email, quota, areas
  ['Sales Manager', 'manager', null, 'manager@synchem.example', 0, null],
  ['Ahmed Raza', 'salesman', null, 'ahmed.raza@synchem.example', 2, 'Gulberg,Johar Town'],
  ['Bilal Hussain', 'salesman', null, 'bilal.hussain@synchem.example', 2, 'Kot Lakhpat,Multan Road'],
  ['Farhan Sheikh', 'salesman', null, 'farhan.sheikh@synchem.example', 2, 'Raiwind,Sundar Industrial Estate'],
];

export async function seedIfEmpty() {
  const reasonCount = (await db.prepare('SELECT COUNT(*) AS n FROM reason_code').get() as any).n;
  if (reasonCount === 0) {
    const ins = db.prepare('INSERT INTO reason_code (outcome, code, label, sort) VALUES (?, ?, ?, ?)');
    await tx(async () => { for (const r of REASONS) await ins.run(...r); });
  }

  const productCount = (await db.prepare('SELECT COUNT(*) AS n FROM product').get() as any).n;
  if (productCount === 0) {
    const ins = db.prepare(
      `INSERT INTO product (sku, name, category, pack_size, uom, unit_price, stock_qty, sample_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const move = db.prepare(`INSERT INTO stock_move (product_id, qty, reason) VALUES (?, ?, 'restock')`);
    await tx(async () => {
      for (const p of PRODUCTS) {
        const r = await ins.run(...p);
        await move.run(Number(r.lastInsertRowid), p[6]);
      }
    });
  }

  const teamCount = (await db.prepare('SELECT COUNT(*) AS n FROM salesman').get() as any).n;
  if (teamCount === 0) {
    const ins = db.prepare(
      'INSERT INTO salesman (name, role, phone_e164, email, weekly_quota, areas) VALUES (?, ?, ?, ?, ?, ?)',
    );
    await tx(async () => { for (const t of TEAM) await ins.run(...t); });
  }

  const settings = await db.prepare('SELECT COUNT(*) AS n FROM setting').get() as any;
  if (settings.n === 0) {
    const ins = db.prepare('INSERT INTO setting (key, value) VALUES (?, ?)');
    await tx(async () => {
      await ins.run('scheduling_provider', process.env.CALENDLY_LINK ? 'calendly' : 'manual');
      await ins.run('company_name', 'SynChem');
    });
  }
}

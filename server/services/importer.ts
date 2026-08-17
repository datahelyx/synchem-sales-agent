import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { db, tx } from '../db/index.js';
import {
  cleanEmail,
  dataQuality,
  isMangledPhone,
  isPlaceholderPhone,
  nameKey,
  normalizeIndustry,
  parseNotes,
  splitContact,
  squash,
  titleCaseName,
  titleCasePlace,
  toE164Pk,
} from '../lib/normalize.js';

export interface ImportRowResult {
  row: number;
  name: string;
  action: 'insert' | 'update' | 'skip';
  warnings: string[];
}

export interface ImportSummary {
  batchId: number | null;
  filename: string;
  encoding: string;
  rowsRead: number;
  inserted: number;
  updated: number;
  skipped: number;
  warnings: Array<{ row: number; name: string; message: string }>;
  sample: Array<Record<string, unknown>>;
}

/**
 * The SynChem export is Windows-1252, not UTF-8 — decoding it as UTF-8 turns
 * "Nestlé" into a replacement char (and, with a strict decoder, throws). We
 * try UTF-8 first and fall back the moment it produces replacement chars.
 */
export function decodeBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('�')) return { text: asUtf8, encoding: 'utf-8' };
  return { text: iconv.decode(buf, 'win1252'), encoding: 'windows-1252' };
}

/** Header aliases, so a slightly different export still imports. */
const FIELD_ALIASES: Record<string, string[]> = {
  name: ['name', 'company', 'company name', 'partner', 'business name'],
  area: ['city', 'area', 'locality', 'town', 'location'],
  phone: ['phone', 'mobile', 'contact number', 'phone number', 'cell'],
  email: ['email', 'e-mail', 'email address'],
  notes: ['notes', 'note', 'remarks', 'description', 'comment'],
};

function buildHeaderMap(headers: string[]): Record<string, string | undefined> {
  const lower = headers.map((h) => squash(h).toLowerCase());
  const map: Record<string, string | undefined> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = lower.findIndex((h) => aliases.includes(h));
    map[field] = idx >= 0 ? headers[idx] : undefined;
  }
  return map;
}

export function parseCompanyCsv(buf: Buffer) {
  const { text, encoding } = decodeBuffer(buf);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;

  if (!records.length) return { encoding, headers: [] as string[], rows: [] as PreparedRow[], headerMap: {} };

  const headers = Object.keys(records[0]);
  const headerMap = buildHeaderMap(headers);
  const rows = records.map((rec, i) => prepareRow(rec, headerMap, i + 2)); // +2: 1-based + header line
  return { encoding, headers, rows, headerMap };
}

export interface PreparedRow {
  rowNumber: number;
  ok: boolean;
  warnings: string[];
  values: {
    name: string;
    name_key: string;
    area: string | null;
    phone: string | null;
    phone_e164: string | null;
    email: string | null;
    industry: string | null;
    industry_raw: string | null;
    contact_name: string | null;
    contact_title: string | null;
    notes: string | null;
    data_quality: number;
  };
}

function prepareRow(
  rec: Record<string, string>,
  map: Record<string, string | undefined>,
  rowNumber: number,
): PreparedRow {
  const get = (field: string) => (map[field] ? squash(rec[map[field]!]) : '');
  const warnings: string[] = [];

  const rawName = get('name');
  const name = titleCaseName(rawName);
  const parsed = parseNotes(get('notes'));
  const contact = splitContact(parsed.contactRaw ?? '');

  const rawPhoneCell = get('phone');
  // Treat the `____-_______` placeholder as genuinely blank, not as bad data.
  const rawPhone = isPlaceholderPhone(rawPhoneCell) ? '' : rawPhoneCell;
  let phoneE164 = toE164Pk(rawPhone);
  const { email, strayPhone } = cleanEmail(get('email'));

  if (isMangledPhone(rawPhoneCell)) {
    warnings.push(`Phone "${rawPhoneCell}" was corrupted by Excel into scientific notation — the number is unrecoverable.`);
  } else if (rawPhone && !phoneE164) {
    warnings.push(`Phone "${rawPhone}" is not a valid PK number — kept as text.`);
  }
  if (strayPhone) {
    // 20 rows in the SynChem file put a phone number in the Email column.
    const recovered = toE164Pk(strayPhone);
    if (recovered && !phoneE164) {
      phoneE164 = recovered;
      warnings.push(`Email column held a phone number (${strayPhone}) — used it as the phone.`);
    } else {
      warnings.push(`Email column held a phone number (${strayPhone}) — ignored.`);
    }
  }
  if (!rawPhone && !email) warnings.push('No phone and no email — cannot be contacted.');

  const industry = normalizeIndustry(parsed.industryRaw);
  const values = {
    name,
    name_key: nameKey(rawName),
    area: get('area') ? titleCasePlace(get('area')) : null,
    phone: rawPhone || null,
    phone_e164: phoneE164,
    email,
    industry,
    industry_raw: parsed.industryRaw,
    contact_name: contact.name || null,
    contact_title: contact.title || null,
    notes: parsed.leftover,
    data_quality: 0,
  };
  values.data_quality = dataQuality(values);

  const ok = Boolean(values.name && values.name_key);
  if (!ok) warnings.push('Row has no usable company name — skipped.');

  return { rowNumber, ok, warnings, values };
}

const INSERT_SQL = `
  INSERT INTO company (name, name_key, area, phone, phone_e164, email, industry, industry_raw,
                       contact_name, contact_title, notes, data_quality, import_batch_id)
  VALUES (@name, @name_key, @area, @phone, @phone_e164, @email, @industry, @industry_raw,
          @contact_name, @contact_title, @notes, @data_quality, @batch_id)
`;

/**
 * Re-importing the same file must not create 5,119 duplicates, and must not
 * wipe work already done. So: match on name_key, and on conflict only fill in
 * fields the existing row is missing. Stage/owner/follow-up are never touched.
 */
const UPDATE_SQL = `
  UPDATE company SET
    area          = COALESCE(NULLIF(area, ''), @area),
    phone         = COALESCE(NULLIF(phone, ''), @phone),
    phone_e164    = COALESCE(NULLIF(phone_e164, ''), @phone_e164),
    email         = COALESCE(NULLIF(email, ''), @email),
    industry      = COALESCE(NULLIF(industry, ''), @industry),
    industry_raw  = COALESCE(NULLIF(industry_raw, ''), @industry_raw),
    contact_name  = COALESCE(NULLIF(contact_name, ''), @contact_name),
    contact_title = COALESCE(NULLIF(contact_title, ''), @contact_title),
    -- 154 companies appear twice under different spellings. When the duplicate
    -- carries a *different* phone, keep it in notes rather than throwing it away.
    notes         = CASE
                      WHEN @phone_e164 IS NOT NULL
                       AND phone_e164 IS NOT NULL
                       AND phone_e164 <> @phone_e164
                       AND (notes IS NULL OR notes NOT LIKE '%' || @phone_e164 || '%')
                      THEN TRIM(COALESCE(notes || ' | ', '') || 'Alt phone: ' || @phone_e164)
                      ELSE COALESCE(NULLIF(notes, ''), @notes)
                    END,
    data_quality  = MAX(data_quality, @data_quality),
    updated_at    = datetime('now')
  WHERE name_key = @name_key
`;

export async function importCompanies(buf: Buffer, filename: string, opts: { dryRun?: boolean } = {}): Promise<ImportSummary> {
  const { encoding, rows } = parseCompanyCsv(buf);
  const warnings: ImportSummary['warnings'] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const existing = new Set<string>(
    (await db.prepare('SELECT name_key FROM company').all()).map((r: any) => r.name_key as string),
  );
  // A file can contain the same company twice; the second one is an update.
  const seen = new Set<string>();

  const plan = rows.map((row) => {
    for (const w of row.warnings) warnings.push({ row: row.rowNumber, name: row.values.name, message: w });
    if (!row.ok) {
      skipped++;
      return { row, action: 'skip' as const };
    }
    const isUpdate = existing.has(row.values.name_key) || seen.has(row.values.name_key);
    seen.add(row.values.name_key);
    if (isUpdate) updated++;
    else inserted++;
    return { row, action: isUpdate ? ('update' as const) : ('insert' as const) };
  });

  let batchId: number | null = null;

  if (!opts.dryRun) {
    await tx(async () => {
      const batch = await db
        .prepare(
          `INSERT INTO import_batch (filename, encoding, rows_read, inserted, updated, skipped, warnings_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(filename, encoding, rows.length, inserted, updated, skipped, JSON.stringify(warnings.slice(0, 500)));
      batchId = Number(batch.lastInsertRowid);

      const ins = db.prepare(INSERT_SQL);
      const upd = db.prepare(UPDATE_SQL);
      for (const { row, action } of plan) {
        if (action === 'skip') continue;
        if (action === 'insert') await ins.run({ ...row.values, batch_id: batchId });
        else await upd.run(row.values);
      }
    });
  }

  return {
    batchId,
    filename,
    encoding,
    rowsRead: rows.length,
    inserted,
    updated,
    skipped,
    warnings: warnings.slice(0, 200),
    sample: plan.slice(0, 12).map(({ row, action }) => ({ action, row: row.rowNumber, ...row.values })),
  };
}

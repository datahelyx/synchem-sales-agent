/**
 * Cleanup for the SynChem export. The source file is messy in specific,
 * repeatable ways, so each fix below exists because the real data needed it:
 *
 *  - 5,006 of 5,119 rows have no email at all, and 20 of the "emails" that do
 *    exist are bare phone numbers (e.g. 3008466302).
 *  - Phones are Pakistani mobiles written as 0321-4004998 / 0321 4004998 /
 *    03214004998, and some cells hold two numbers separated by / or ,.
 *  - `Notes` only ever contains "Industry: X" and/or "Primary contact: Y",
 *    pipe-separated. 137 distinct industry spellings collapse to ~25 buckets.
 *  - `City` is a Lahore locality, blank for 2,445 rows.
 */

export function squash(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function titleCaseName(s: string): string {
  const clean = squash(s);
  if (!clean) return '';
  // Source is SHOUTING; only re-case if there are no lowercase letters at all.
  if (/[a-z]/.test(clean)) return clean;
  return clean
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Pvt|Ltd|Llc|Uae|Uk|Usa|Ksa)\b/g, (m) => m.toUpperCase());
}

/** Place names are always title-cased — the source mixes "Kot lakhpat" and "KOT LAKHPAT". */
export function titleCasePlace(s: string): string {
  const clean = squash(s);
  if (!clean) return '';
  return clean
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Gt|Ii|Iii)\b/g, (m) => m.toUpperCase());
}

/**
 * Collapses punctuation/case so re-importing the same file updates, not
 * duplicates. Diacritics are folded first, otherwise "Nestlé Pakistan" and
 * "Nestle Pakistan Limited" stay two separate companies.
 */
export function nameKey(name: string): string {
  return squash(name)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\((PVT|PRIVATE)\.?\)/g, '')
    .replace(/\b(PVT|PRIVATE|LIMITED|LTD|LLC|CO|COMPANY|INC)\b\.?/g, '')
    .replace(/[^A-Z0-9]+/g, '');
}

const TITLES = ['MR.', 'MRS.', 'MS.', 'MISS', 'DR.', 'ENGR.', 'MR', 'MRS', 'MS', 'DR', 'ENGR'];

export function splitContact(raw: string): { title: string; name: string } {
  const clean = squash(raw);
  if (!clean) return { title: '', name: '' };
  const upper = clean.toUpperCase();
  for (const t of TITLES) {
    if (upper.startsWith(t + ' ') || upper === t) {
      return { title: t.replace(/\.?$/, '.'), name: titleCaseName(clean.slice(t.length)) };
    }
  }
  return { title: '', name: titleCaseName(clean) };
}

/** 179 rows use `____-_______` as an empty-phone placeholder. */
export function isPlaceholderPhone(raw: string | null | undefined): boolean {
  const clean = squash(raw);
  return clean.length > 0 && /^[_\-.\s]+$/.test(clean);
}

/** Excel turned some phone cells into `9.23018E+11`; the digits are gone for good. */
export function isMangledPhone(raw: string | null | undefined): boolean {
  return /^\d(\.\d+)?[eE][+-]?\d+$/.test(squash(raw));
}

/**
 * Pakistani mobile/landline -> E.164. Returns null when the digits cannot be a
 * real PK number, which is how we keep junk out of wa.me links.
 */
export function toE164Pk(raw: string | null | undefined): string | null {
  if (isPlaceholderPhone(raw) || isMangledPhone(raw)) return null;
  const first = squash(raw).split(/[/,;]| or /i)[0] ?? '';
  let d = first.replace(/[^\d+]/g, '');
  if (!d) return null;

  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);

  if (!/^\d+$/.test(d)) return null;
  // Mobiles are 3xxxxxxxxx (10 digits). Landlines are area code + 6-8 digits.
  if (d.startsWith('3')) return d.length === 10 ? `+92${d}` : null;
  if (d.length >= 9 && d.length <= 11) return `+92${d}`;
  return null;
}

export function prettyPhone(e164: string | null): string {
  if (!e164) return '';
  const d = e164.replace('+92', '');
  return d.startsWith('3') ? `0${d.slice(0, 3)}-${d.slice(3)}` : `0${d}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns the email only when it really is one — several cells hold phone numbers. */
export function cleanEmail(raw: string | null | undefined): { email: string | null; strayPhone: string | null } {
  const clean = squash(raw).toLowerCase();
  if (!clean) return { email: null, strayPhone: null };
  if (EMAIL_RE.test(clean)) return { email: clean, strayPhone: null };
  if (/^\+?\d[\d\s\-()]{7,}$/.test(clean)) return { email: null, strayPhone: clean };
  return { email: null, strayPhone: null };
}

const INDUSTRY_MAP: Array<[RegExp, string]> = [
  [/textile|apparel|garment|hosiery|weav|spinn|dyeing|embroider/i, 'Textiles & Apparel'],
  [/cotton|ginn/i, 'Cotton & Ginning'],
  [/pharma|medicine|drug|surgical|medical|healthcare|hospital/i, 'Pharma & Healthcare'],
  [/chemical|dye|ink|paint|adhesive|resin/i, 'Chemicals'],
  [/food|beverage|bakery|sweet|dairy|confection|flour|rice|sugar|meat|poultry|tea|spice/i, 'Food & Beverage'],
  [/plastic|polymer|pvc|rubber/i, 'Plastics & Polymers'],
  [/packag|carton|corrugat|label|printing|print/i, 'Packaging & Printing'],
  [/engineer|machin|fabricat|foundry|steel|metal|iron|casting/i, 'Engineering & Metals'],
  [/leather|tann|footwear|shoe/i, 'Leather & Footwear'],
  [/paper|board|pulp/i, 'Paper & Board'],
  [/energy|oil|gas|petrol|fuel|power|solar|electric power/i, 'Energy & Fuels'],
  [/construct|cement|marble|tile|glass|ceramic|real estate|builder/i, 'Construction & Materials'],
  [/technolog|software|it services|telecom|electronic|computer/i, 'Technology'],
  [/transport|logistic|freight|courier|shipping|automotive|auto|vehicle/i, 'Transport & Auto'],
  [/agri|farm|seed|fertiliz|pesticid|feed/i, 'Agriculture'],
  [/hotel|catering|tourism|restaurant|travel/i, 'Hospitality & Travel'],
  [/bank|financ|insur|invest|leasing/i, 'Financial Services'],
  [/educat|school|college|university|institute|academy/i, 'Education'],
  [/cosmetic|soap|detergent|personal care|toiletr/i, 'Cosmetics & Detergents'],
  [/furnitur|wood|timber/i, 'Furniture & Wood'],
  [/trading|trader|import|export|distribut|supplier|dealer/i, 'Trading & Distribution'],
  [/manufactur|industr|mills?|factory/i, 'General Manufacturing'],
  [/service|consult|advertis|media|marketing|security|hr /i, 'Services'],
];

export function normalizeIndustry(raw: string | null | undefined): string | null {
  const clean = squash(raw);
  if (!clean) return null;
  for (const [re, bucket] of INDUSTRY_MAP) if (re.test(clean)) return bucket;
  return 'Other';
}

export interface ParsedNotes {
  industryRaw: string | null;
  contactRaw: string | null;
  leftover: string | null;
}

/** `Industry: Chemical | Primary contact: MR. ABDUL QAYYUM KHAN` */
export function parseNotes(notes: string | null | undefined): ParsedNotes {
  const parts = squash(notes)
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

  let industryRaw: string | null = null;
  let contactRaw: string | null = null;
  const leftover: string[] = [];

  for (const part of parts) {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(part);
    if (!m) {
      leftover.push(part);
      continue;
    }
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'industry') industryRaw = val || null;
    else if (key === 'primary contact' || key === 'contact') contactRaw = val || null;
    else leftover.push(part);
  }

  return { industryRaw, contactRaw, leftover: leftover.length ? leftover.join(' | ') : null };
}

/**
 * 0-100 score for how workable a lead is. The agent hands out the best-scoring
 * companies first, so salesmen are not sent to dial a blank phone field.
 */
export function dataQuality(c: {
  phone_e164: string | null;
  email: string | null;
  contact_name: string | null;
  industry: string | null;
  area: string | null;
}): number {
  let score = 0;
  if (c.phone_e164) score += 40;
  if (c.email) score += 20;
  if (c.contact_name) score += 20;
  if (c.industry && c.industry !== 'Other') score += 12;
  if (c.area) score += 8;
  return score;
}

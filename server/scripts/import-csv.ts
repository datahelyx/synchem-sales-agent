import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../db/index.js';
import { importCompanies } from '../services/importer.js';
import { seedIfEmpty } from './seed-data.js';

/** CLI import, for loading the big file without going through the browser. */

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import:csv -- "C:\\path\\to\\companies.csv" [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

await migrate();
await seedIfEmpty();

const dryRun = process.argv.includes('--dry-run');
const buf = fs.readFileSync(file);
const t0 = Date.now();
const summary = await importCompanies(buf, path.basename(file), { dryRun });

console.log(`\n${dryRun ? 'DRY RUN — nothing written' : 'Imported'}: ${summary.filename}`);
console.log(`  encoding : ${summary.encoding}`);
console.log(`  rows     : ${summary.rowsRead}`);
console.log(`  inserted : ${summary.inserted}`);
console.log(`  updated  : ${summary.updated}`);
console.log(`  skipped  : ${summary.skipped}`);
console.log(`  warnings : ${summary.warnings.length}${summary.warnings.length >= 200 ? '+ (capped)' : ''}`);
console.log(`  took     : ${Date.now() - t0} ms`);

for (const w of summary.warnings.slice(0, 10)) {
  console.log(`   · row ${w.row} ${w.name}: ${w.message}`);
}

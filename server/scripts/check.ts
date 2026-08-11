import { db } from '../db/index.js';

/** Quick data sanity report — handy after an import. */
const one = async (sql: string) => JSON.stringify(await db.prepare(sql).get());
const many = async (sql: string) => JSON.stringify(await db.prepare(sql).all());

console.log('companies    ', await one('SELECT COUNT(*) n FROM company'));
console.log('contactable  ', await one('SELECT COUNT(*) n FROM company WHERE phone_e164 IS NOT NULL'));
console.log('with email   ', await one('SELECT COUNT(*) n FROM company WHERE email IS NOT NULL'));
console.log('unreachable  ', await one('SELECT COUNT(*) n FROM company WHERE phone_e164 IS NULL AND email IS NULL'));
console.log('alt phones   ', await one("SELECT COUNT(*) n FROM company WHERE notes LIKE '%Alt phone%'"));
console.log('mojibake     ', await one("SELECT COUNT(*) n FROM company WHERE name LIKE '%�%'"));
console.log('accented     ', await many("SELECT name FROM company WHERE name LIKE '%estl%' LIMIT 3"));
console.log('quality      ', await many('SELECT data_quality, COUNT(*) n FROM company GROUP BY 1 ORDER BY 1 DESC LIMIT 6'));
console.log('industries   ', await many('SELECT industry, COUNT(*) n FROM company GROUP BY 1 ORDER BY n DESC LIMIT 6'));
console.log('areas        ', await many("SELECT area, COUNT(*) n FROM company WHERE area IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 5"));
console.log('sample row   ', await one('SELECT name, area, phone, phone_e164, industry, contact_title, contact_name, data_quality FROM company WHERE data_quality >= 80 LIMIT 1'));

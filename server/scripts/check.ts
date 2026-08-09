import { db } from '../db/index.js';

/** Quick data sanity report — handy after an import. */
const one = (sql: string) => JSON.stringify(db.prepare(sql).get());
const many = (sql: string) => JSON.stringify(db.prepare(sql).all());

console.log('companies    ', one('SELECT COUNT(*) n FROM company'));
console.log('contactable  ', one('SELECT COUNT(*) n FROM company WHERE phone_e164 IS NOT NULL'));
console.log('with email   ', one('SELECT COUNT(*) n FROM company WHERE email IS NOT NULL'));
console.log('unreachable  ', one('SELECT COUNT(*) n FROM company WHERE phone_e164 IS NULL AND email IS NULL'));
console.log('alt phones   ', one("SELECT COUNT(*) n FROM company WHERE notes LIKE '%Alt phone%'"));
console.log('mojibake     ', one("SELECT COUNT(*) n FROM company WHERE name LIKE '%�%'"));
console.log('accented     ', many("SELECT name FROM company WHERE name LIKE '%estl%' LIMIT 3"));
console.log('quality      ', many('SELECT data_quality, COUNT(*) n FROM company GROUP BY 1 ORDER BY 1 DESC LIMIT 6'));
console.log('industries   ', many('SELECT industry, COUNT(*) n FROM company GROUP BY 1 ORDER BY n DESC LIMIT 6'));
console.log('areas        ', many("SELECT area, COUNT(*) n FROM company WHERE area IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 5"));
console.log('sample row   ', one('SELECT name, area, phone, phone_e164, industry, contact_title, contact_name, data_quality FROM company WHERE data_quality >= 80 LIMIT 1'));

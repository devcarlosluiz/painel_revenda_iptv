import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(ROOT, 'src', 'schema.sql'), 'utf8'));

// --- helpers -------------------------------------------------
const clean = (row) => (row ? { ...row } : row);          // tira o prototype null

export const all = (sql, ...p) => db.prepare(sql).all(...p).map(clean);
export const get = (sql, ...p) => clean(db.prepare(sql).get(...p));
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const one = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? Object.values(r)[0] : null; };

/** Executa fn dentro de uma transacao. */
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// --- settings ------------------------------------------------
export const getSetting = (key, def = null) => {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
};
export const setSetting = (key, value) =>
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value));

export default db;

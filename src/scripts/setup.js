/**
 * Configuracao inicial do painel:
 *   node src/scripts/setup.js [--user admin] [--pass senha] [--import] [--reset]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, config } from '../config.js';

// ---- .env antes de tocar no banco ----------------------------------
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(envPath, example.replace('JWT_SECRET=troque-esta-chave',
    `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`));
  console.log('.env criado a partir de .env.example (JWT_SECRET gerado)');
}

const { db, all, get, run, tx } = await import('../db.js');
const { hashPassword, randomString } = await import('../lib/auth.js');
const { now } = await import('../lib/helpers.js');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return !v || v.startsWith('--') ? true : v;
};

if (arg('reset')) {
  db.exec(`DELETE FROM connections; DELETE FROM activity; DELETE FROM credit_log;
           DELETE FROM line_bouquets; DELETE FROM lines; DELETE FROM plan_bouquets;
           DELETE FROM plans; DELETE FROM bouquet_categories; DELETE FROM bouquets;
           DELETE FROM users;`);
  console.log('dados do painel apagados (conteudo importado foi mantido)');
}

// ---- admin ---------------------------------------------------------
const username = String(arg('user', 'admin'));
let password = arg('pass');
const existing = get('SELECT * FROM users WHERE username = ?', username);

if (existing) {
  if (password) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), existing.id);
    console.log(`senha do usuario "${username}" atualizada`);
  } else {
    console.log(`usuario "${username}" ja existe (use --pass para trocar a senha)`);
  }
} else {
  password = password || randomString(10);
  run(`INSERT INTO users(username,password_hash,role,name,credits,can_trial,created_at)
       VALUES(?,?,'admin','Administrador',999999,1,?)`, username, hashPassword(password), now());
  console.log(`admin criado -> usuario: ${username} | senha: ${password}`);
}

// ---- pacotes padrao ------------------------------------------------
function bouquetFor(name, description, filter) {
  let b = get('SELECT * FROM bouquets WHERE name = ?', name);
  if (!b) {
    const r = run('INSERT INTO bouquets(name,description,created_at) VALUES(?,?,?)', name, description, now());
    b = get('SELECT * FROM bouquets WHERE id = ?', Number(r.lastInsertRowid));
  }
  const cats = all('SELECT id, type FROM categories').filter(filter);
  tx(() => {
    run('DELETE FROM bouquet_categories WHERE bouquet_id = ?', b.id);
    for (const c of cats) run('INSERT OR IGNORE INTO bouquet_categories(bouquet_id,category_id) VALUES(?,?)', b.id, c.id);
  });
  return { ...b, total: cats.length };
}

if (get('SELECT COUNT(*) AS n FROM categories').n > 0) {
  const full   = bouquetFor('Completo', 'Todos os canais, filmes e series', () => true);
  const live   = bouquetFor('Somente Canais', 'Apenas canais ao vivo', (c) => c.type === 'live');
  const noSer  = bouquetFor('Canais + Filmes', 'Canais ao vivo e filmes', (c) => c.type !== 'series');
  console.log(`pacotes: Completo (${full.total} cat.), Somente Canais (${live.total}), Canais + Filmes (${noSer.total})`);
} else {
  console.log('nenhuma categoria encontrada - rode "npm run import" e depois "npm run setup" de novo para criar os pacotes');
}

// ---- planos padrao -------------------------------------------------
const completo = get("SELECT id FROM bouquets WHERE name = 'Completo'");
const PLANOS = [
  { name: 'Teste',       days: 1,   credits_cost: 0, max_connections: 1, is_trial: 1 },
  { name: 'Mensal',      days: 30,  credits_cost: 1, max_connections: 1, is_trial: 0 },
  { name: 'Trimestral',  days: 90,  credits_cost: 3, max_connections: 1, is_trial: 0 },
  { name: 'Semestral',   days: 180, credits_cost: 6, max_connections: 2, is_trial: 0 },
  { name: 'Anual',       days: 365, credits_cost: 12, max_connections: 2, is_trial: 0 },
];
for (const p of PLANOS) {
  if (get('SELECT 1 AS x FROM plans WHERE name = ?', p.name)) continue;
  const r = run(
    'INSERT INTO plans(name,days,credits_cost,max_connections,is_trial,created_at) VALUES(?,?,?,?,?,?)',
    p.name, p.days, p.credits_cost, p.max_connections, p.is_trial, now());
  if (completo) run('INSERT OR IGNORE INTO plan_bouquets(plan_id,bouquet_id) VALUES(?,?)', Number(r.lastInsertRowid), completo.id);
}
console.log(`planos disponiveis: ${all('SELECT name FROM plans ORDER BY days').map((p) => p.name).join(', ')}`);

// ---- importacao opcional -------------------------------------------
if (arg('import')) {
  const { importFromFile } = await import('../services/importer.js');
  console.log(`importando ${config.m3uPath} ...`);
  console.log(importFromFile(config.m3uPath, { reset: false }));
}

console.log('\npronto. Suba o painel com:  npm start');
db.close();

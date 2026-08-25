import express from 'express';
import fs from 'node:fs';
import { all, get, run, tx, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { now, clientIp, bool } from '../lib/helpers.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, randomString } from '../lib/auth.js';
import { ownerScope, lineUrls, lineStatus, createLine, renewLine, moveCredits } from '../services/lines.js';
import { pruneConnections } from '../services/access.js';
import { importFromFile, importFromUrl, importM3U, importState } from '../services/importer.js';

export const router = express.Router();
router.use(express.json({ limit: '20mb' }));

// ----------------------------------------------------------------
// autenticacao do painel
// ----------------------------------------------------------------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'sessao expirada' });
  const user = get('SELECT * FROM users WHERE id = ? AND status = 1', payload.uid);
  if (!user) return res.status(401).json({ error: 'usuario invalido' });
  req.user = user;
  next();
}

const admin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'somente administrador' });

/** filtro de propriedade das linhas conforme o papel */
function scope(user, alias = 'l') {
  const ids = ownerScope(user);
  if (ids === null) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.owner_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function ownedLine(user, id) {
  const line = get('SELECT * FROM lines WHERE id = ?', Number(id));
  if (!line) return null;
  if (user.role === 'admin') return line;
  return ownerScope(user).includes(line.owner_id) ? line : null;
}

const safeUser = (u) => ({
  id: u.id, username: u.username, role: u.role, name: u.name, email: u.email,
  whatsapp: u.whatsapp, credits: u.credits, parent_id: u.parent_id,
  status: u.status, can_trial: u.can_trial, created_at: u.created_at, last_login: u.last_login,
});

// ----------------------------------------------------------------
// login
// ----------------------------------------------------------------
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE username = ?', String(username || ''));
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'usuario ou senha invalidos' });
  }
  if (!user.status) return res.status(403).json({ error: 'conta desativada' });
  run('UPDATE users SET last_login = ? WHERE id = ?', now(), user.id);
  res.json({ token: issueToken({ uid: user.id, role: user.role }), user: safeUser(user) });
});

router.use(auth);

router.get('/me', (req, res) => res.json({ user: safeUser(req.user), publicUrl: config.publicUrl }));

router.post('/me/password', (req, res) => {
  const { current, novo } = req.body || {};
  if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: 'senha atual incorreta' });
  if (!novo || String(novo).length < 4) return res.status(400).json({ error: 'senha muito curta' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(novo), req.user.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// dashboard
// ----------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  pruneConnections();
  const s = scope(req.user);
  const count = (sql, ...p) => get(sql, ...p).n;
  const t = now();

  const lines = count(`SELECT COUNT(*) AS n FROM lines l WHERE 1=1 ${s.sql}`, ...s.params);
  const ativos = count(
    `SELECT COUNT(*) AS n FROM lines l WHERE l.status = 'active' AND (l.exp_date IS NULL OR l.exp_date > ?) ${s.sql}`,
    t, ...s.params);
  const vencidos = count(
    `SELECT COUNT(*) AS n FROM lines l WHERE l.exp_date IS NOT NULL AND l.exp_date <= ? ${s.sql}`, t, ...s.params);
  const testes = count(`SELECT COUNT(*) AS n FROM lines l WHERE l.is_trial = 1 ${s.sql}`, ...s.params);
  const vencendo = count(
    `SELECT COUNT(*) AS n FROM lines l WHERE l.exp_date BETWEEN ? AND ? ${s.sql}`, t, t + 3 * 86400, ...s.params);
  const online = count(
    `SELECT COUNT(DISTINCT c.line_id) AS n FROM connections c JOIN lines l ON l.id = c.line_id WHERE 1=1 ${s.sql}`,
    ...s.params);

  res.json({
    lines, ativos, vencidos, testes, vencendo, online,
    credits: req.user.credits,
    conteudo: {
      canais: count('SELECT COUNT(*) AS n FROM streams WHERE enabled = 1'),
      filmes: count('SELECT COUNT(*) AS n FROM movies WHERE enabled = 1'),
      series: count('SELECT COUNT(*) AS n FROM series WHERE enabled = 1'),
      episodios: count('SELECT COUNT(*) AS n FROM episodes'),
      categorias: count('SELECT COUNT(*) AS n FROM categories'),
    },
    ultimos: all(
      `SELECT l.id, l.username, l.customer_name, l.exp_date, l.status, l.is_trial, l.created_at, u.username AS owner
         FROM lines l JOIN users u ON u.id = l.owner_id
        WHERE 1=1 ${s.sql} ORDER BY l.created_at DESC LIMIT 8`, ...s.params)
      .map((l) => ({ ...l, estado: lineStatus(l) })),
    atividade: all(
      `SELECT a.* FROM activity a
        WHERE a.line_id IN (SELECT l.id FROM lines l WHERE 1=1 ${s.sql})
        ORDER BY a.at DESC LIMIT 10`, ...s.params),
  });
});

// ----------------------------------------------------------------
// linhas (clientes)
// ----------------------------------------------------------------
router.get('/lines', (req, res) => {
  const s = scope(req.user);
  const params = [...s.params];
  let where = `WHERE 1=1 ${s.sql}`;

  if (req.query.search) {
    where += ' AND (l.username LIKE ? OR l.customer_name LIKE ? OR l.whatsapp LIKE ? OR l.note LIKE ?)';
    const q = `%${req.query.search}%`;
    params.push(q, q, q, q);
  }
  const st = req.query.status;
  if (st === 'ativo')    { where += " AND l.status = 'active' AND (l.exp_date IS NULL OR l.exp_date > ?)"; params.push(now()); }
  if (st === 'vencido')  { where += ' AND l.exp_date IS NOT NULL AND l.exp_date <= ?'; params.push(now()); }
  if (st === 'teste')    { where += ' AND l.is_trial = 1'; }
  if (st === 'desativado') { where += " AND l.status != 'active'"; }
  if (req.query.owner_id) { where += ' AND l.owner_id = ?'; params.push(Number(req.query.owner_id)); }

  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = get(`SELECT COUNT(*) AS n FROM lines l ${where}`, ...params).n;

  const rows = all(
    `SELECT l.*, u.username AS owner, p.name AS plan_name,
            (SELECT COUNT(*) FROM connections c WHERE c.line_id = l.id) AS online
       FROM lines l
       JOIN users u ON u.id = l.owner_id
       LEFT JOIN plans p ON p.id = l.plan_id
       ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, (page - 1) * limit);

  res.json({
    total, page, limit,
    data: rows.map((l) => ({ ...l, estado: lineStatus(l), urls: lineUrls(l) })),
  });
});

router.get('/lines/:id', (req, res) => {
  const line = ownedLine(req.user, req.params.id);
  if (!line) return res.status(404).json({ error: 'linha nao encontrada' });
  res.json({
    ...line,
    estado: lineStatus(line),
    urls: lineUrls(line),
    owner: get('SELECT username FROM users WHERE id = ?', line.owner_id)?.username,
    bouquets: all('SELECT bouquet_id FROM line_bouquets WHERE line_id = ?', line.id).map((b) => b.bouquet_id),
    conexoes: all('SELECT * FROM connections WHERE line_id = ?', line.id),
    atividade: all('SELECT * FROM activity WHERE line_id = ? ORDER BY at DESC LIMIT 50', line.id),
  });
});

router.post('/lines', (req, res) => {
  try {
    const line = createLine(req.user, req.body || {});
    res.json({ ...line, estado: lineStatus(line), urls: lineUrls(line) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/lines/:id', (req, res) => {
  const line = ownedLine(req.user, req.params.id);
  if (!line) return res.status(404).json({ error: 'linha nao encontrada' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  const setIf = (key, value) => { if (value !== undefined) { fields.push(`${key} = ?`); params.push(value); } };

  setIf('password', b.password);
  setIf('customer_name', b.customer_name);
  setIf('whatsapp', b.whatsapp);
  setIf('note', b.note);
  setIf('allowed_ips', b.allowed_ips);
  setIf('status', b.status);
  setIf('max_connections', b.max_connections !== undefined ? Number(b.max_connections) : undefined);
  setIf('exp_date', b.exp_date !== undefined ? (b.exp_date ? Number(b.exp_date) : null) : undefined);
  if (b.username && b.username !== line.username) {
    if (get('SELECT 1 AS x FROM lines WHERE username = ?', b.username)) {
      return res.status(400).json({ error: 'usuario ja existe' });
    }
    setIf('username', b.username);
  }
  if (req.user.role === 'admin' && b.owner_id) setIf('owner_id', Number(b.owner_id));

  tx(() => {
    if (fields.length) run(`UPDATE lines SET ${fields.join(', ')} WHERE id = ?`, ...params, line.id);
    if (Array.isArray(b.bouquets)) {
      run('DELETE FROM line_bouquets WHERE line_id = ?', line.id);
      for (const x of b.bouquets) run('INSERT OR IGNORE INTO line_bouquets(line_id,bouquet_id) VALUES(?,?)', line.id, Number(x));
    }
  });
  const fresh = get('SELECT * FROM lines WHERE id = ?', line.id);
  res.json({ ...fresh, estado: lineStatus(fresh), urls: lineUrls(fresh) });
});

router.delete('/lines/:id', (req, res) => {
  const line = ownedLine(req.user, req.params.id);
  if (!line) return res.status(404).json({ error: 'linha nao encontrada' });
  run('DELETE FROM lines WHERE id = ?', line.id);
  res.json({ ok: true });
});

router.post('/lines/:id/renew', (req, res) => {
  const line = ownedLine(req.user, req.params.id);
  if (!line) return res.status(404).json({ error: 'linha nao encontrada' });
  try {
    const fresh = renewLine(req.user, line.id, req.body?.plan_id);
    res.json({ ...fresh, estado: lineStatus(fresh), urls: lineUrls(fresh) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/lines/:id/kill', (req, res) => {
  const line = ownedLine(req.user, req.params.id);
  if (!line) return res.status(404).json({ error: 'linha nao encontrada' });
  run('DELETE FROM connections WHERE line_id = ?', line.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// revendedores
// ----------------------------------------------------------------
router.get('/users', (req, res) => {
  const rows = req.user.role === 'admin'
    ? all('SELECT * FROM users ORDER BY role, username')
    : all('SELECT * FROM users WHERE parent_id = ? OR id = ? ORDER BY username', req.user.id, req.user.id);
  res.json(rows.map((u) => ({
    ...safeUser(u),
    linhas: get('SELECT COUNT(*) AS n FROM lines WHERE owner_id = ?', u.id).n,
  })));
});

router.post('/users', admin, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!username) return res.status(400).json({ error: 'informe o usuario' });
  if (get('SELECT 1 AS x FROM users WHERE username = ?', username)) {
    return res.status(400).json({ error: 'usuario ja existe' });
  }
  const password = b.password || randomString(8);
  const r = run(
    `INSERT INTO users(username,password_hash,role,name,email,whatsapp,credits,parent_id,can_trial,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    username, hashPassword(password), b.role === 'admin' ? 'admin' : 'reseller',
    b.name || null, b.email || null, b.whatsapp || null, Number(b.credits) || 0,
    b.parent_id ? Number(b.parent_id) : (req.user.role === 'admin' ? null : req.user.id),
    bool(b.can_trial ?? true) ? 1 : 0, now());
  res.json({ ...safeUser(get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid))), password });
});

router.patch('/users/:id', admin, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'usuario nao encontrado' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  const setIf = (k, v) => { if (v !== undefined) { fields.push(`${k} = ?`); params.push(v); } };
  setIf('name', b.name); setIf('email', b.email); setIf('whatsapp', b.whatsapp);
  setIf('status', b.status !== undefined ? (bool(b.status) ? 1 : 0) : undefined);
  setIf('can_trial', b.can_trial !== undefined ? (bool(b.can_trial) ? 1 : 0) : undefined);
  setIf('role', b.role);
  if (b.password) setIf('password_hash', hashPassword(b.password));
  if (fields.length) run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params, u.id);
  res.json(safeUser(get('SELECT * FROM users WHERE id = ?', u.id)));
});

router.delete('/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'voce nao pode excluir a si mesmo' });
  run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
});

router.post('/users/:id/credits', admin, (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!amount) return res.status(400).json({ error: 'valor invalido' });
    const balance = moveCredits(Number(req.params.id), amount, req.body?.reason || 'Ajuste manual', req.user.id);
    res.json({ ok: true, balance });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/credits', (req, res) => {
  const uid = req.user.role === 'admin' && req.query.user_id ? Number(req.query.user_id) : req.user.id;
  res.json(all(
    `SELECT cl.*, u.username AS user, a.username AS actor
       FROM credit_log cl
       JOIN users u ON u.id = cl.user_id
       LEFT JOIN users a ON a.id = cl.actor_id
      WHERE cl.user_id = ? ORDER BY cl.at DESC LIMIT 200`, uid));
});

// ----------------------------------------------------------------
// categorias / pacotes / planos
// ----------------------------------------------------------------
router.get('/categories', (req, res) => {
  const type = req.query.type;
  const rows = type
    ? all('SELECT * FROM categories WHERE type = ? ORDER BY type, sort_order, name', String(type))
    : all('SELECT * FROM categories ORDER BY type, sort_order, name');
  const counts = {
    live:   Object.fromEntries(all('SELECT category_id AS c, COUNT(*) AS n FROM streams  WHERE enabled=1 GROUP BY category_id').map((r) => [r.c, r.n])),
    movie:  Object.fromEntries(all('SELECT category_id AS c, COUNT(*) AS n FROM movies   WHERE enabled=1 GROUP BY category_id').map((r) => [r.c, r.n])),
    series: Object.fromEntries(all('SELECT category_id AS c, COUNT(*) AS n FROM series   WHERE enabled=1 GROUP BY category_id').map((r) => [r.c, r.n])),
  };
  res.json(rows.map((c) => ({ ...c, itens: counts[c.type]?.[c.id] || 0 })));
});

router.get('/bouquets', (req, res) => {
  res.json(all('SELECT * FROM bouquets ORDER BY name').map((b) => ({
    ...b,
    categories: all('SELECT category_id FROM bouquet_categories WHERE bouquet_id = ?', b.id).map((r) => r.category_id),
    lines: get('SELECT COUNT(*) AS n FROM line_bouquets WHERE bouquet_id = ?', b.id).n,
  })));
});

router.post('/bouquets', admin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'informe o nome' });
  try {
    const id = tx(() => {
      const r = run('INSERT INTO bouquets(name,description,created_at) VALUES(?,?,?)', b.name, b.description || null, now());
      const bid = Number(r.lastInsertRowid);
      for (const c of b.categories || []) run('INSERT OR IGNORE INTO bouquet_categories(bouquet_id,category_id) VALUES(?,?)', bid, Number(c));
      return bid;
    });
    res.json(get('SELECT * FROM bouquets WHERE id = ?', id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/bouquets/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  tx(() => {
    if (b.name) run('UPDATE bouquets SET name = ?, description = ? WHERE id = ?', b.name, b.description || null, id);
    if (Array.isArray(b.categories)) {
      run('DELETE FROM bouquet_categories WHERE bouquet_id = ?', id);
      for (const c of b.categories) run('INSERT OR IGNORE INTO bouquet_categories(bouquet_id,category_id) VALUES(?,?)', id, Number(c));
    }
  });
  res.json({ ok: true });
});

router.delete('/bouquets/:id', admin, (req, res) => {
  run('DELETE FROM bouquets WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

router.get('/plans', (req, res) => {
  res.json(all('SELECT * FROM plans ORDER BY days, name').map((p) => ({
    ...p,
    bouquets: all('SELECT bouquet_id FROM plan_bouquets WHERE plan_id = ?', p.id).map((r) => r.bouquet_id),
  })));
});

router.post('/plans', admin, (req, res) => {
  const b = req.body || {};
  const id = tx(() => {
    const r = run(
      'INSERT INTO plans(name,days,credits_cost,max_connections,is_trial,created_at) VALUES(?,?,?,?,?,?)',
      b.name || 'Plano', Number(b.days) || 30, Number(b.credits_cost) || 1,
      Number(b.max_connections) || 1, bool(b.is_trial) ? 1 : 0, now());
    const pid = Number(r.lastInsertRowid);
    for (const x of b.bouquets || []) run('INSERT OR IGNORE INTO plan_bouquets(plan_id,bouquet_id) VALUES(?,?)', pid, Number(x));
    return pid;
  });
  res.json(get('SELECT * FROM plans WHERE id = ?', id));
});

router.patch('/plans/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  tx(() => {
    const fields = [];
    const params = [];
    const setIf = (k, v) => { if (v !== undefined) { fields.push(`${k} = ?`); params.push(v); } };
    setIf('name', b.name);
    setIf('days', b.days !== undefined ? Number(b.days) : undefined);
    setIf('credits_cost', b.credits_cost !== undefined ? Number(b.credits_cost) : undefined);
    setIf('max_connections', b.max_connections !== undefined ? Number(b.max_connections) : undefined);
    setIf('active', b.active !== undefined ? (bool(b.active) ? 1 : 0) : undefined);
    if (fields.length) run(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
    if (Array.isArray(b.bouquets)) {
      run('DELETE FROM plan_bouquets WHERE plan_id = ?', id);
      for (const x of b.bouquets) run('INSERT OR IGNORE INTO plan_bouquets(plan_id,bouquet_id) VALUES(?,?)', id, Number(x));
    }
  });
  res.json({ ok: true });
});

router.delete('/plans/:id', admin, (req, res) => {
  run('DELETE FROM plans WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// conteudo
// ----------------------------------------------------------------
const TABLES = { live: 'streams', movie: 'movies', series: 'series' };

router.get('/content', (req, res) => {
  const type = String(req.query.type || 'live');
  const table = TABLES[type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });

  const params = [];
  let where = 'WHERE 1=1';
  if (req.query.search) { where += ' AND t.name LIKE ?'; params.push(`%${req.query.search}%`); }
  if (req.query.category_id) { where += ' AND t.category_id = ?'; params.push(Number(req.query.category_id)); }
  if (req.query.enabled === '0') where += ' AND t.enabled = 0';

  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = get(`SELECT COUNT(*) AS n FROM ${table} t ${where}`, ...params).n;
  const extra = type === 'series' ? ', (SELECT COUNT(*) FROM episodes e WHERE e.series_id = t.id) AS episodios' : '';

  res.json({
    total, page, limit,
    data: all(
      `SELECT t.*, c.name AS categoria ${extra} FROM ${table} t
         LEFT JOIN categories c ON c.id = t.category_id
         ${where} ORDER BY t.name LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit),
  });
});

router.get('/content/:type/:id', (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });
  const row = get(
    `SELECT t.*, c.name AS categoria FROM ${table} t
       LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'nao encontrado' });
  if (req.params.type === 'series') {
    row.episodios = all('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode', row.id);
  }
  res.json(row);
});

router.patch('/content/:type/:id', admin, (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  const setIf = (k, v) => { if (v !== undefined) { fields.push(`${k} = ?`); params.push(v); } };
  setIf('name', b.name);
  setIf('category_id', b.category_id !== undefined ? Number(b.category_id) : undefined);
  setIf('logo', b.logo);
  setIf('enabled', b.enabled !== undefined ? (bool(b.enabled) ? 1 : 0) : undefined);
  if (table !== 'series') {
    setIf('source_url', b.source_url);
    setIf('proxy_mode', b.proxy_mode === null ? null : (b.proxy_mode !== undefined ? (bool(b.proxy_mode) ? 1 : 0) : undefined));
  }
  if (table === 'streams') setIf('epg_id', b.epg_id);
  if (!fields.length) return res.json({ ok: true });
  run(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`, ...params, Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/content/:type/:id', admin, (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });
  run(`DELETE FROM ${table} WHERE id = ?`, Number(req.params.id));
  res.json({ ok: true });
});

router.post('/content/live', admin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.source_url) return res.status(400).json({ error: 'informe nome e url' });
  let catId = b.category_id ? Number(b.category_id) : null;
  if (!catId && b.category_name) {
    run('INSERT OR IGNORE INTO categories(name,type,sort_order) VALUES(?,?,0)', b.category_name, 'live');
    catId = get('SELECT id FROM categories WHERE name = ? AND type = ?', b.category_name, 'live').id;
  }
  const r = run(
    'INSERT INTO streams(name,category_id,logo,epg_id,source_url,container,sort_order,added_at) VALUES(?,?,?,?,?,?,?,?)',
    b.name, catId, b.logo || null, b.epg_id || null, b.source_url,
    String(b.source_url).includes('.m3u8') ? 'm3u8' : 'ts', 9999, now());
  res.json(get('SELECT * FROM streams WHERE id = ?', Number(r.lastInsertRowid)));
});

/** testa se a fonte responde */
router.post('/content/:type/:id/test', admin, async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table || table === 'series') return res.status(400).json({ error: 'tipo invalido' });
  const row = get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'nao encontrado' });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(row.source_url, {
      method: 'GET', signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Range: 'bytes=0-1024' },
    });
    clearTimeout(timer);
    r.body?.cancel?.();
    res.json({ ok: r.ok || r.status === 206, status: r.status, ms: Date.now() - t0, type: r.headers.get('content-type') });
  } catch (e) {
    res.json({ ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - t0 });
  }
});

// ----------------------------------------------------------------
// conexoes e logs
// ----------------------------------------------------------------
router.get('/connections', (req, res) => {
  pruneConnections();
  const s = scope(req.user);
  res.json(all(
    `SELECT c.*, l.username, l.max_connections, u.username AS owner
       FROM connections c
       JOIN lines l ON l.id = c.line_id
       JOIN users u ON u.id = l.owner_id
      WHERE 1=1 ${s.sql} ORDER BY c.started_at DESC`, ...s.params));
});

router.delete('/connections/:id', (req, res) => {
  const c = get('SELECT * FROM connections WHERE id = ?', Number(req.params.id));
  if (!c || !ownedLine(req.user, c.line_id)) return res.status(404).json({ error: 'conexao nao encontrada' });
  run('DELETE FROM connections WHERE id = ?', c.id);
  res.json({ ok: true });
});

router.get('/activity', (req, res) => {
  const s = scope(req.user);
  const params = [...s.params];
  let where = `WHERE a.line_id IN (SELECT l.id FROM lines l WHERE 1=1 ${s.sql})`;
  if (req.query.kind) { where += ' AND a.kind = ?'; params.push(String(req.query.kind)); }
  if (req.query.line_id) { where += ' AND a.line_id = ?'; params.push(Number(req.query.line_id)); }
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json(all(`SELECT a.* FROM activity a ${where} ORDER BY a.at DESC LIMIT ?`, ...params, limit));
});

// ----------------------------------------------------------------
// importacao da lista
// ----------------------------------------------------------------
router.get('/import/status', admin, (req, res) => res.json(importState));

router.post('/import', admin, async (req, res) => {
  if (importState.running) return res.status(409).json({ error: 'ja existe uma importacao em andamento' });
  const b = req.body || {};
  const opts = { reset: bool(b.reset), prune: bool(b.prune) };
  try {
    let result;
    if (b.url) result = await importFromUrl(String(b.url), opts);
    else if (b.content) result = importM3U(String(b.content), opts);
    else {
      const file = b.path ? String(b.path) : config.m3uPath;
      if (!fs.existsSync(file)) return res.status(400).json({ error: `arquivo nao encontrado: ${file}` });
      result = importFromFile(file, opts);
    }
    if (b.url) setSetting('m3u_source_url', String(b.url));
    setSetting('last_import', String(now()));
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------------------------------------------
// configuracoes
// ----------------------------------------------------------------
router.get('/settings', admin, (req, res) => {
  res.json({
    publicUrl: config.publicUrl,
    streamMode: config.streamMode,
    trialHours: config.trialHours,
    connectionTtl: config.connectionTtl,
    port: config.port,
    m3uPath: config.m3uPath,
    db: Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value])),
  });
});

router.put('/settings', admin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v);
  res.json({ ok: true });
});

export default router;

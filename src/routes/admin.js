import express from 'express';
import { all, get, run, tx, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { now, clientIp, bool } from '../lib/helpers.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, randomString } from '../lib/auth.js';
import { ownerScope, lineUrls, lineStatus, createLine, renewLine, moveCredits } from '../services/lines.js';
import { pruneConnections } from '../services/access.js';
import { importFromUrl, importM3U, importState } from '../services/importer.js';
import { systemStats } from '../services/system.js';

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

/** tabela de conteudo de cada tipo de categoria */
const TABLES = { live: 'streams', movie: 'movies', series: 'series' };
const TIPOS = Object.keys(TABLES);

/** quantos itens usam a categoria */
const itensDaCategoria = (cat) =>
  get(`SELECT COUNT(*) AS n FROM ${TABLES[cat.type]} WHERE category_id = ?`, cat.id).n;

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

router.post('/categories', admin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const type = String(b.type || 'live');
  if (!name) return res.status(400).json({ error: 'informe o nome da categoria' });
  if (!TIPOS.includes(type)) return res.status(400).json({ error: 'tipo invalido' });
  if (get('SELECT id FROM categories WHERE name = ? AND type = ?', name, type)) {
    return res.status(409).json({ error: 'ja existe uma categoria com esse nome neste tipo' });
  }
  const r = run('INSERT INTO categories(name,type,sort_order) VALUES(?,?,?)', name, type, Number(b.sort_order) || 0);
  res.json(get('SELECT * FROM categories WHERE id = ?', Number(r.lastInsertRowid)));
});

router.patch('/categories/:id', admin, (req, res) => {
  const cat = get('SELECT * FROM categories WHERE id = ?', Number(req.params.id));
  if (!cat) return res.status(404).json({ error: 'categoria nao encontrada' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : cat.name;
  const type = b.type !== undefined ? String(b.type) : cat.type;
  const order = b.sort_order !== undefined ? Number(b.sort_order) : cat.sort_order;
  if (!name) return res.status(400).json({ error: 'informe o nome da categoria' });
  if (!TIPOS.includes(type)) return res.status(400).json({ error: 'tipo invalido' });
  if (get('SELECT id FROM categories WHERE name = ? AND type = ? AND id <> ?', name, type, cat.id)) {
    return res.status(409).json({ error: 'ja existe uma categoria com esse nome neste tipo' });
  }
  // o conteudo de cada tipo vive em uma tabela propria, entao trocar o tipo esconderia os itens
  const itens = itensDaCategoria(cat);
  if (type !== cat.type && itens) {
    return res.status(409).json({ error: `a categoria tem ${itens} item(ns) - mova o conteudo antes de trocar o tipo` });
  }
  run('UPDATE categories SET name = ?, type = ?, sort_order = ? WHERE id = ?', name, type, order, cat.id);
  res.json(get('SELECT * FROM categories WHERE id = ?', cat.id));
});

/** move o conteudo de uma categoria para outra do mesmo tipo */
router.post('/categories/:id/move', admin, (req, res) => {
  const cat = get('SELECT * FROM categories WHERE id = ?', Number(req.params.id));
  if (!cat) return res.status(404).json({ error: 'categoria nao encontrada' });
  const dest = get('SELECT * FROM categories WHERE id = ?', Number((req.body || {}).to));
  if (!dest || dest.type !== cat.type) return res.status(400).json({ error: 'escolha uma categoria de destino do mesmo tipo' });
  if (dest.id === cat.id) return res.status(400).json({ error: 'destino igual a origem' });
  const r = run(`UPDATE ${TABLES[cat.type]} SET category_id = ? WHERE category_id = ?`, dest.id, cat.id);
  res.json({ ok: true, movidos: Number(r.changes) });
});

/**
 * Exclui a categoria. Tendo conteudo dentro, precisa dizer o que fazer com ele:
 *   ?move_to=<id>        move para outra categoria do mesmo tipo
 *   ?delete_content=1    apaga o conteudo junto (series levam os episodios por cascade)
 */
router.delete('/categories/:id', admin, (req, res) => {
  const cat = get('SELECT * FROM categories WHERE id = ?', Number(req.params.id));
  if (!cat) return res.status(404).json({ error: 'categoria nao encontrada' });

  const destino = req.query.move_to ? get('SELECT * FROM categories WHERE id = ?', Number(req.query.move_to)) : null;
  if (req.query.move_to && (!destino || destino.type !== cat.type || destino.id === cat.id)) {
    return res.status(400).json({ error: 'escolha uma categoria de destino do mesmo tipo' });
  }
  const apagarConteudo = bool(req.query.delete_content);
  if (destino && apagarConteudo) {
    return res.status(400).json({ error: 'escolha mover o conteudo ou apagar, nao os dois' });
  }

  const itens = itensDaCategoria(cat);
  if (itens && !destino && !apagarConteudo) {
    return res.status(409).json({
      error: `a categoria tem ${itens} item(ns) - mova o conteudo (move_to) ou apague junto (delete_content)`,
    });
  }

  let movidos = 0;
  let excluidos = 0;
  tx(() => {
    if (destino) {
      run(`UPDATE ${TABLES[cat.type]} SET category_id = ? WHERE category_id = ?`, destino.id, cat.id);
      movidos = itens;
    } else if (apagarConteudo) {
      excluidos = Number(run(`DELETE FROM ${TABLES[cat.type]} WHERE category_id = ?`, cat.id).changes);
    }
    run('DELETE FROM categories WHERE id = ?', cat.id);   // bouquet_categories sai por cascade
  });
  res.json({ ok: true, movidos, excluidos });
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

/** filtro da listagem de conteudo (o mesmo usado na busca da tela) */
function filtroConteudo(q = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (q.search) { where += ' AND t.name LIKE ?'; params.push(`%${q.search}%`); }
  if (q.category_id) { where += ' AND t.category_id = ?'; params.push(Number(q.category_id)); }
  if (String(q.enabled) === '0') where += ' AND t.enabled = 0';
  return { where, params };
}

/** resolve a categoria de destino informada por id ou por nome novo */
function categoriaDestino(body, type) {
  if (body.category_name) {
    const nome = String(body.category_name).trim();
    if (!nome) return { erro: 'informe o nome da categoria' };
    run('INSERT OR IGNORE INTO categories(name,type,sort_order) VALUES(?,?,0)', nome, type);
    return { id: get('SELECT id FROM categories WHERE name = ? AND type = ?', nome, type).id };
  }
  if (body.category_id === null) return { id: null };
  if (body.category_id === undefined) return {};
  const cat = get('SELECT * FROM categories WHERE id = ?', Number(body.category_id));
  if (!cat || cat.type !== type) return { erro: 'categoria de destino invalida para este tipo' };
  return { id: cat.id };
}

router.get('/content', (req, res) => {
  const type = String(req.query.type || 'live');
  const table = TABLES[type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });

  const { where, params } = filtroConteudo(req.query);

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

/** troca a categoria de varios itens: os selecionados (ids) ou todos os do filtro (all) */
router.post('/content/:type/category', admin, (req, res) => {
  const type = req.params.type;
  const table = TABLES[type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });
  const b = req.body || {};

  const destino = categoriaDestino(b, type);
  if (destino.erro) return res.status(400).json({ error: destino.erro });
  if (destino.id === undefined) return res.status(400).json({ error: 'escolha a categoria de destino' });

  const ids = Array.isArray(b.ids)
    ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length && !bool(b.all)) return res.status(400).json({ error: 'nenhum item selecionado' });

  let movidos = 0;
  tx(() => {
    if (ids.length) {
      for (let i = 0; i < ids.length; i += 400) {           // sqlite tem limite de parametros por statement
        const parte = ids.slice(i, i + 400);
        const r = run(`UPDATE ${table} SET category_id = ? WHERE id IN (${parte.map(() => '?').join(',')})`,
          destino.id, ...parte);
        movidos += Number(r.changes);
      }
    } else {
      const { where, params } = filtroConteudo(b.filtro || {});
      const r = run(`UPDATE ${table} SET category_id = ? WHERE id IN (SELECT t.id FROM ${table} t ${where})`,
        destino.id, ...params);
      movidos = Number(r.changes);
    }
  });
  res.json({ ok: true, movidos, category_id: destino.id });
});

router.patch('/content/:type/:id', admin, (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'tipo invalido' });
  const b = req.body || {};
  // categoria existente, ou criada na hora pelo nome, direto na tela de edicao
  const destino = categoriaDestino(b, req.params.type);
  if (destino.erro) return res.status(400).json({ error: destino.erro });
  const catId = destino.id;
  const fields = [];
  const params = [];
  const setIf = (k, v) => { if (v !== undefined) { fields.push(`${k} = ?`); params.push(v); } };
  setIf('name', b.name);
  setIf('category_id', catId);
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

/** o painel envia o arquivo anexado no corpo cru da requisicao */
const listaAnexada = express.raw({ type: () => true, limit: `${config.importMaxMb}mb` });

/** playlists costumam vir em utf-8, mas ainda aparece muita lista em latin1 */
function decodeLista(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

router.post('/import/upload', admin, listaAnexada, (req, res) => {
  if (importState.running) return res.status(409).json({ error: 'ja existe uma importacao em andamento' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'nenhum arquivo recebido' });
  }
  const content = decodeLista(req.body);
  if (!/#EXTM3U|#EXTINF/i.test(content)) {
    return res.status(400).json({ error: 'o arquivo enviado nao parece ser uma lista M3U' });
  }
  try {
    const result = importM3U(content, { reset: bool(req.query.reset), prune: bool(req.query.prune) });
    setSetting('last_import', String(now()));
    setSetting('last_import_source', req.query.name ? `arquivo: ${String(req.query.name)}` : 'arquivo anexado');
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/import', admin, async (req, res) => {
  if (importState.running) return res.status(409).json({ error: 'ja existe uma importacao em andamento' });
  const b = req.body || {};
  const opts = { reset: bool(b.reset), prune: bool(b.prune) };
  try {
    let result;
    if (b.url) result = await importFromUrl(String(b.url), opts);
    else if (b.content) result = importM3U(String(b.content), opts);
    else return res.status(400).json({ error: 'envie um arquivo, uma URL ou o conteudo da lista' });

    if (b.url) {
      setSetting('m3u_source_url', String(b.url));
      setSetting('last_import_source', String(b.url));
    } else {
      setSetting('last_import_source', 'conteudo colado no painel');
    }
    setSetting('last_import', String(now()));
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------------------------------------------
// exportacao da lista organizada (somente admin)
// ----------------------------------------------------------------
const pad2 = (n) => String(n ?? 1).padStart(2, '0');
const attr = (v) => String(v ?? '').replace(/"/g, "'");

/** nome que faz o episodio voltar como serie/temporada/episodio numa reimportacao */
const nomeEpisodio = (e) =>
  (/S\d{1,3}\s*[\sEx]\s*E?\d{1,4}\s*$/i.test(e.name)
    ? e.name
    : `${e.sname} S${pad2(e.season)} E${pad2(e.episode)}`);

/** filtro comum da exportacao */
function filtroExport(q = {}) {
  const tipo = TIPOS.includes(String(q.type)) ? String(q.type) : 'all';
  const ativos = q.only_enabled === undefined ? true : bool(q.only_enabled);
  const cond = (alias) => {
    const params = [];
    let sql = '';
    if (ativos) sql += ` AND ${alias}.enabled = 1`;
    if (q.category_id) { sql += ` AND ${alias}.category_id = ?`; params.push(Number(q.category_id)); }
    if (q.search) { sql += ` AND ${alias}.name LIKE ?`; params.push(`%${q.search}%`); }
    return { sql, params };
  };
  return { tipo, cond };
}

/** conteudo do painel na mesma ordem em que aparece no player */
function* itensExport(q = {}) {
  const { tipo, cond } = filtroExport(q);

  if (tipo === 'all' || tipo === 'live') {
    const f = cond('s');
    for (const s of all(
      `SELECT s.*, c.name AS cat FROM streams s LEFT JOIN categories c ON c.id = s.category_id
        WHERE 1=1 ${f.sql} ORDER BY s.sort_order, s.name`, ...f.params)) {
      yield { tipo: 'canal', id: s.id, name: s.name, group: s.cat || 'Canais',
              logo: s.logo, epgId: s.epg_id, url: s.source_url, duration: null, enabled: s.enabled };
    }
  }
  if (tipo === 'all' || tipo === 'movie') {
    const f = cond('m');
    for (const m of all(
      `SELECT m.*, c.name AS cat FROM movies m LEFT JOIN categories c ON c.id = m.category_id
        WHERE 1=1 ${f.sql} ORDER BY m.name`, ...f.params)) {
      yield { tipo: 'filme', id: m.id, name: m.name, group: m.cat || 'Filmes',
              logo: m.logo, epgId: null, url: m.source_url, duration: m.duration, enabled: m.enabled };
    }
  }
  if (tipo === 'all' || tipo === 'series') {
    const f = cond('s');   // o filtro vale para a serie, os episodios vem junto
    for (const e of all(
      `SELECT e.*, s.name AS sname, s.enabled AS senabled, c.name AS cat FROM episodes e
         JOIN series s ON s.id = e.series_id
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE 1=1 ${f.sql} ORDER BY s.name, e.season, e.episode`, ...f.params)) {
      yield { tipo: 'episodio', id: e.id, name: nomeEpisodio(e), group: e.cat || 'Series',
              logo: e.logo, epgId: null, url: e.source_url, duration: e.duration, enabled: e.senabled };
    }
  }
}

/** quantos itens a exportacao vai gerar (o painel mostra antes de baixar) */
router.get('/export/resumo', admin, (req, res) => {
  const { tipo, cond } = filtroExport(req.query);
  const conta = (t, table, alias) => {
    if (tipo !== 'all' && tipo !== t) return 0;
    const f = cond(alias);
    return get(`SELECT COUNT(*) AS n FROM ${table} ${alias} WHERE 1=1 ${f.sql}`, ...f.params).n;
  };
  const live = conta('live', 'streams', 's');
  const movie = conta('movie', 'movies', 'm');
  let series = 0;
  if (tipo === 'all' || tipo === 'series') {
    const f = cond('s');
    series = get(`SELECT COUNT(*) AS n FROM episodes e JOIN series s ON s.id = e.series_id
                   WHERE 1=1 ${f.sql}`, ...f.params).n;
  }
  res.json({ live, movie, series, total: live + movie + series });
});

const nomeExport = (q, ext) => {
  const tipo = TIPOS.includes(String(q.type)) ? String(q.type) : 'tudo';
  return `lista-${tipo}-${new Date().toISOString().slice(0, 10)}.${ext}`;
};

router.get('/export/m3u', admin, (req, res) => {
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeExport(req.query, 'm3u')}"`);
  res.write('#EXTM3U\n');
  let n = 0;
  for (const it of itensExport(req.query)) {
    res.write(`#EXTINF:${it.duration || -1} tvg-id="${attr(it.epgId)}" tvg-name="${attr(it.name)}" ` +
              `tvg-logo="${attr(it.logo)}" group-title="${attr(it.group)}",${it.name}\n`);
    res.write(`${it.url}\n`);
    n++;
  }
  res.end(`# ${n} item(ns) exportados pelo painel em ${new Date().toISOString()}\n`);
});

const csv = (v) => {
  const t = String(v ?? '');
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

router.get('/export/csv', admin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeExport(req.query, 'csv')}"`);
  res.write('\uFEFF');                    // BOM: o Excel abre os acentos certo
  res.write('tipo;id;nome;categoria;status;url;logo;tvg_id\n');
  for (const it of itensExport(req.query)) {
    res.write([it.tipo, it.id, it.name, it.group, it.enabled ? 'ativo' : 'oculto',
               it.url, it.logo, it.epgId].map(csv).join(';') + '\n');
  }
  res.end();
});

// ----------------------------------------------------------------
// maquina onde o painel roda (somente admin)
// ----------------------------------------------------------------
router.get('/system', admin, (req, res) => res.json(systemStats()));

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
    importMaxMb: config.importMaxMb,
    db: Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value])),
  });
});

router.put('/settings', admin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v);
  res.json({ ok: true });
});

// corpo grande demais (lista anexada ou texto colado) -> resposta em json
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    const mb = Math.round((err.limit || 0) / (1024 * 1024)) || config.importMaxMb;
    return res.status(413).json({ error: `conteudo maior que o limite de ${mb} MB` });
  }
  next(err);
});

export default router;

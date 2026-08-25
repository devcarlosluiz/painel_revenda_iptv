import { all, get, run, tx } from '../db.js';
import { config } from '../config.js';
import { now } from '../lib/helpers.js';
import { randomString } from '../lib/auth.js';

/** Ids de usuarios que o ator enxerga (ele mesmo + sub-revendas). */
export function ownerScope(user) {
  if (user.role === 'admin') return null;                  // null = todos
  const ids = [user.id];
  let frontier = [user.id];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const rows = all(
      `SELECT id FROM users WHERE parent_id IN (${frontier.map(() => '?').join(',')})`, ...frontier);
    frontier = rows.map((r) => r.id).filter((id) => !ids.includes(id));
    ids.push(...frontier);
  }
  return ids;
}

export function lineUrls(line) {
  const base = config.publicUrl;
  const u = encodeURIComponent(line.username);
  const p = encodeURIComponent(line.password);
  return {
    m3u:      `${base}/get.php?username=${u}&password=${p}&type=m3u_plus&output=ts`,
    m3u8:     `${base}/get.php?username=${u}&password=${p}&type=m3u_plus&output=m3u8`,
    epg:      `${base}/xmltv.php?username=${u}&password=${p}`,
    api:      `${base}/player_api.php?username=${u}&password=${p}`,
    server:   base,
    username: line.username,
    password: line.password,
  };
}

export function lineStatus(line) {
  if (line.status === 'banned')   return 'banido';
  if (line.status === 'disabled') return 'desativado';
  if (line.exp_date && line.exp_date < now()) return 'vencido';
  if (line.is_trial) return 'teste';
  return 'ativo';
}

/** Debita/credita creditos e registra no historico. */
export function moveCredits(userId, amount, reason, actorId, lineId = null) {
  const u = get('SELECT id, credits FROM users WHERE id = ?', userId);
  if (!u) throw new Error('Usuario nao encontrado');
  const balance = Math.round((u.credits + amount) * 100) / 100;
  if (balance < 0) throw new Error('Creditos insuficientes');
  run('UPDATE users SET credits = ? WHERE id = ?', balance, userId);
  run(`INSERT INTO credit_log(user_id,amount,balance,reason,line_id,actor_id,at) VALUES(?,?,?,?,?,?,?)`,
      userId, amount, balance, reason, lineId, actorId, now());
  return balance;
}

function planOrThrow(planId) {
  const plan = get('SELECT * FROM plans WHERE id = ? AND active = 1', planId);
  if (!plan) throw new Error('Plano invalido');
  return plan;
}

/** Cria uma linha (cliente). Consome creditos do revendedor. */
export function createLine(actor, data) {
  const username = (data.username || `cli${randomString(6)}`).trim();
  const password = (data.password || randomString(8)).trim();
  if (get('SELECT 1 AS x FROM lines WHERE username = ?', username)) throw new Error('Usuario ja existe');

  const isTrial = !!data.is_trial;
  let plan = null, days, maxConn, cost = 0;

  if (isTrial) {
    if (actor.role !== 'admin' && !actor.can_trial) throw new Error('Voce nao tem permissao para gerar testes');
    days = (data.trial_hours ?? config.trialHours) / 24;
    maxConn = Number(data.max_connections) || 1;
  } else {
    plan = planOrThrow(data.plan_id);
    days = plan.days;
    maxConn = Number(data.max_connections) || plan.max_connections;
    cost = actor.role === 'admin' ? 0 : plan.credits_cost;
  }

  const ownerId = actor.role === 'admin' && data.owner_id ? Number(data.owner_id) : actor.id;
  const expDate = data.exp_date ? Number(data.exp_date) : now() + Math.round(days * 86400);

  return tx(() => {
    if (cost > 0) moveCredits(ownerId, -cost, `Criacao da linha ${username}`, actor.id);

    const r = run(
      `INSERT INTO lines(username,password,owner_id,plan_id,max_connections,exp_date,status,is_trial,
                         allowed_ips,note,customer_name,whatsapp,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      username, password, ownerId, plan?.id ?? null, maxConn, expDate,
      data.status || 'active', isTrial ? 1 : 0, data.allowed_ips || null, data.note || null,
      data.customer_name || null, data.whatsapp || null, now());

    const lineId = Number(r.lastInsertRowid);
    const bouquets = data.bouquets?.length
      ? data.bouquets
      : (plan ? all('SELECT bouquet_id FROM plan_bouquets WHERE plan_id = ?', plan.id).map((b) => b.bouquet_id) : []);
    for (const b of bouquets) run('INSERT OR IGNORE INTO line_bouquets(line_id,bouquet_id) VALUES(?,?)', lineId, Number(b));

    return get('SELECT * FROM lines WHERE id = ?', lineId);
  });
}

/** Renova a linha somando os dias do plano a partir de hoje (ou do vencimento futuro). */
export function renewLine(actor, lineId, planId) {
  const line = get('SELECT * FROM lines WHERE id = ?', lineId);
  if (!line) throw new Error('Linha nao encontrada');
  const plan = planOrThrow(planId || line.plan_id);
  const cost = actor.role === 'admin' ? 0 : plan.credits_cost;

  return tx(() => {
    if (cost > 0) moveCredits(actor.id, -cost, `Renovacao da linha ${line.username}`, actor.id, line.id);
    const base = line.exp_date && line.exp_date > now() ? line.exp_date : now();
    const exp = base + plan.days * 86400;
    run(`UPDATE lines SET exp_date = ?, plan_id = ?, status = 'active', is_trial = 0,
                          max_connections = ? WHERE id = ?`,
        exp, plan.id, Math.max(line.max_connections, plan.max_connections), line.id);
    return get('SELECT * FROM lines WHERE id = ?', line.id);
  });
}

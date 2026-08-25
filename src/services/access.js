import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { now } from '../lib/helpers.js';

export const DENY = {
  NOT_FOUND: 'usuario ou senha invalidos',
  DISABLED:  'linha desativada',
  BANNED:    'linha bloqueada',
  EXPIRED:   'assinatura vencida',
  IP:        'ip nao autorizado',
  MAX_CONN:  'limite de conexoes atingido',
  NO_ACCESS: 'conteudo fora do seu pacote',
  NO_STREAM: 'conteudo indisponivel',
};

/** Autentica a linha do cliente (usuario/senha do player). */
export function authLine(username, password, ip) {
  const line = get('SELECT * FROM lines WHERE username = ?', String(username ?? ''));
  if (!line || line.password !== String(password ?? '')) return { ok: false, reason: DENY.NOT_FOUND };
  if (line.status === 'banned')   return { ok: false, reason: DENY.BANNED, line };
  if (line.status !== 'active')   return { ok: false, reason: DENY.DISABLED, line };
  if (line.exp_date && line.exp_date < now()) return { ok: false, reason: DENY.EXPIRED, line };
  if (line.allowed_ips) {
    const list = line.allowed_ips.split(/[,\s]+/).filter(Boolean);
    if (list.length && ip && !list.includes(ip)) return { ok: false, reason: DENY.IP, line };
  }
  return { ok: true, line };
}

/** Ids de categoria liberados para a linha. null = acesso total. */
export function allowedCategories(lineId) {
  const rows = all(
    `SELECT DISTINCT bc.category_id AS id
       FROM line_bouquets lb
       JOIN bouquet_categories bc ON bc.bouquet_id = lb.bouquet_id
      WHERE lb.line_id = ?`, lineId);
  const hasBouquet = get('SELECT 1 AS x FROM line_bouquets WHERE line_id = ? LIMIT 1', lineId);
  if (!hasBouquet) return null;                       // sem pacote definido => tudo liberado
  return new Set(rows.map((r) => r.id));
}

export const categoryAllowed = (allowed, categoryId) => allowed === null || allowed.has(categoryId);

/** Remove conexoes sem heartbeat. */
export function pruneConnections() {
  run('DELETE FROM connections WHERE last_beat < ?', now() - config.connectionTtl);
}

export function activeConnections(lineId) {
  pruneConnections();
  return all('SELECT * FROM connections WHERE line_id = ? ORDER BY started_at', lineId);
}

/**
 * Abre (ou renova) uma conexao respeitando o limite da linha.
 * @returns {{ok:boolean, id?:number, reason?:string}}
 */
export function openConnection(line, kind, contentId, contentName, ip, ua) {
  pruneConnections();
  const same = get(
    'SELECT * FROM connections WHERE line_id = ? AND ip = ? AND kind = ? AND content_id = ?',
    line.id, ip, kind, contentId);
  if (same) {
    run('UPDATE connections SET last_beat = ? WHERE id = ?', now(), same.id);
    return { ok: true, id: same.id };
  }
  const count = get('SELECT COUNT(*) AS n FROM connections WHERE line_id = ?', line.id).n;
  if (count >= line.max_connections) return { ok: false, reason: DENY.MAX_CONN };

  const r = run(
    `INSERT INTO connections(line_id,kind,content_id,content_name,ip,user_agent,started_at,last_beat)
     VALUES(?,?,?,?,?,?,?,?)`,
    line.id, kind, contentId, contentName, ip, ua, now(), now());
  return { ok: true, id: Number(r.lastInsertRowid) };
}

export function heartbeat(id, bytes = 0) {
  run('UPDATE connections SET last_beat = ?, bytes = bytes + ? WHERE id = ?', now(), bytes, id);
}

export function closeConnection(id) {
  run('DELETE FROM connections WHERE id = ?', id);
}

export function touchLine(line, ip, ua) {
  run('UPDATE lines SET last_seen = ?, last_ip = ?, last_ua = ? WHERE id = ?', now(), ip, ua, line.id);
}

export function logActivity({ line, username, kind, contentId, contentName, ip, ua, detail }) {
  run(`INSERT INTO activity(line_id,username,kind,content_id,content_name,ip,user_agent,detail,at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      line?.id ?? null, username ?? line?.username ?? null, kind, contentId ?? null,
      contentName ?? null, ip ?? null, ua ?? null, detail ?? null, now());
}

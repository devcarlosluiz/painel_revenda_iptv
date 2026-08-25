import express from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { get } from '../db.js';
import { config } from '../config.js';
import { now, clientIp } from '../lib/helpers.js';
import {
  authLine, allowedCategories, openConnection, heartbeat, closeConnection,
  touchLine, logActivity, DENY,
} from '../services/access.js';

export const router = express.Router();

const UA_FONTE = 'VLC/3.0.20 LibVLC/3.0.20';

// ----------------------------------------------------------------
// resolucao do conteudo
// ----------------------------------------------------------------
function resolveContent(kind, id) {
  if (kind === 'live') {
    const s = get('SELECT *, category_id AS cat FROM streams WHERE id = ? AND enabled = 1', id);
    return s && { id: s.id, name: s.name, url: s.source_url, container: s.container, cat: s.category_id, proxy: s.proxy_mode };
  }
  if (kind === 'movie') {
    const m = get('SELECT * FROM movies WHERE id = ? AND enabled = 1', id);
    return m && { id: m.id, name: m.name, url: m.source_url, container: m.container, cat: m.category_id, proxy: m.proxy_mode };
  }
  const e = get(
    `SELECT e.*, s.category_id AS cat, s.name AS sname
       FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE e.id = ? AND s.enabled = 1`, id);
  return e && { id: e.id, name: `${e.sname} - ${e.name}`, url: e.source_url, container: e.container, cat: e.cat, proxy: e.proxy_mode };
}

const useProxy = (item) => (item.proxy === null || item.proxy === undefined
  ? config.streamMode === 'proxy'
  : Boolean(item.proxy));

// ----------------------------------------------------------------
// assinatura de URLs internas de HLS (evita virar proxy aberto)
// ----------------------------------------------------------------
const hmac = (s) => crypto.createHmac('sha256', config.jwtSecret).update(s).digest('base64url');

function signHls(url, lineId, connId) {
  const payload = Buffer.from(JSON.stringify({ u: url, l: lineId, c: connId, e: now() + 7200 })).toString('base64url');
  return `${config.publicUrl}/hls/${payload}.${hmac(payload)}`;
}

function openHls(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = hmac(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.e > now() ? data : null;
  } catch { return null; }
}

// ----------------------------------------------------------------
// proxy de midia
// ----------------------------------------------------------------
async function pipeSource(req, res, sourceUrl, lineId, connId) {
  if (connId) heartbeat(connId);
  const ctrl = new AbortController();
  const kill = () => ctrl.abort();
  req.on('close', kill);

  const headers = { 'User-Agent': req.headers['user-agent'] || UA_FONTE, Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(sourceUrl, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    if (!res.headersSent) res.status(502).type('text/plain').send('fonte indisponivel');
    return;
  }
  if (!upstream.ok && upstream.status !== 206) {
    if (!res.headersSent) res.status(upstream.status).type('text/plain').send('fonte respondeu erro');
    return;
  }

  const ctype = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.url || sourceUrl;
  const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8$/i.test(new URL(finalUrl).pathname);

  // ---- playlist HLS: reescreve os segmentos para passarem pelo painel ----
  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = text.split('\n').map((raw) => {
      const l = raw.trim();
      if (!l) return raw;
      if (l.startsWith('#')) {
        // URI="..." dentro de tags (chaves AES, media alternativa)
        return raw.replace(/URI="([^"]+)"/g, (_, u) => `URI="${signHls(new URL(u, finalUrl).href, lineId, connId)}"`);
      }
      return signHls(new URL(l, finalUrl).href, lineId, connId);
    }).join('\n');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    return res.end(rewritten);
  }

  // ---- midia binaria ----
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', 'video/mp2t');
  res.status(upstream.status === 206 ? 206 : 200);

  const body = Readable.fromWeb(upstream.body);
  let bytes = 0;
  let lastBeat = now();
  body.on('data', (chunk) => {
    bytes += chunk.length;
    if (connId && now() - lastBeat >= 20) { heartbeat(connId, bytes); bytes = 0; lastBeat = now(); }
  });
  body.on('error', () => { try { res.end(); } catch {} });
  res.on('close', () => { body.destroy(); });
  body.pipe(res);
}

// ----------------------------------------------------------------
// handler principal: /live|/movie|/series/:user/:pass/:file
// ----------------------------------------------------------------
async function serve(kind, req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const { username, password } = req.params;
  const file = String(req.params.file || '');
  const id = parseInt(file, 10);

  const auth = authLine(username, password, ip);
  if (!auth.ok) {
    logActivity({ line: auth.line, username, kind: 'denied', ip, ua, detail: `${kind}: ${auth.reason}` });
    return res.status(403).type('text/plain').send(auth.reason);
  }
  const line = auth.line;

  const item = isNaN(id) ? null : resolveContent(kind, id);
  if (!item) return res.status(404).type('text/plain').send(DENY.NO_STREAM);

  const allowed = allowedCategories(line.id);
  if (allowed !== null && !allowed.has(item.cat)) {
    logActivity({ line, kind: 'denied', contentId: item.id, contentName: item.name, ip, ua, detail: DENY.NO_ACCESS });
    return res.status(403).type('text/plain').send(DENY.NO_ACCESS);
  }

  const conn = openConnection(line, kind, item.id, item.name, ip, ua);
  if (!conn.ok) {
    logActivity({ line, kind: 'denied', contentId: item.id, contentName: item.name, ip, ua, detail: conn.reason });
    return res.status(403).type('text/plain').send(conn.reason);
  }

  touchLine(line, ip, ua);
  logActivity({ line, kind, contentId: item.id, contentName: item.name, ip, ua });

  if (!useProxy(item)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.redirect(302, item.url);
  }

  res.on('close', () => { if (kind !== 'live') closeConnection(conn.id); });
  return pipeSource(req, res, item.url, line.id, conn.id);
}

router.get('/live/:username/:password/:file',   (req, res) => serve('live', req, res));
router.get('/movie/:username/:password/:file',  (req, res) => serve('movie', req, res));
router.get('/series/:username/:password/:file', (req, res) => serve('series', req, res));

// segmentos/playlists internas do proxy HLS
router.get('/hls/:token', async (req, res) => {
  const data = openHls(String(req.params.token));
  if (!data) return res.status(403).type('text/plain').send('token expirado');
  // mantem a conexao viva enquanto o player consome os segmentos
  if (data.c && !get('SELECT 1 AS x FROM connections WHERE id = ?', data.c)) {
    return res.status(403).type('text/plain').send('conexao encerrada');
  }
  return pipeSource(req, res, data.u, data.l, data.c || null);
});

// formato antigo: /usuario/senha/1234
router.get('/:username/:password/:file', (req, res, next) => {
  if (['api', 'hls', 'live', 'movie', 'series', 'painel'].includes(req.params.username)) return next();
  return serve('live', req, res);
});

export default router;

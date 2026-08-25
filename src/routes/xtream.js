import express from 'express';
import { all, get } from '../db.js';
import { config } from '../config.js';
import { now, clientIp, escapeXml } from '../lib/helpers.js';
import { authLine, allowedCategories, activeConnections, touchLine, logActivity } from '../services/access.js';
import { lineStatus } from '../services/lines.js';

export const router = express.Router();

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------
const creds = (req) => ({
  username: req.query.username ?? req.body?.username ?? '',
  password: req.query.password ?? req.body?.password ?? '',
});

/** Monta o fragmento "AND category_id IN (...)" conforme o pacote da linha. */
function catFilter(lineId, column = 'category_id') {
  const allowed = allowedCategories(lineId);
  if (allowed === null) return { sql: '', params: [] };
  if (allowed.size === 0) return { sql: ' AND 1 = 0', params: [] };
  const ids = [...allowed];
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function serverInfo() {
  const u = new URL(config.publicUrl);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    xui: true,
    version: '1.5.5',
    revision: null,
    url: u.hostname,
    port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    https_port: u.protocol === 'https:' ? (u.port || '443') : '443',
    server_protocol: u.protocol.replace(':', ''),
    rtmp_port: '1935',
    timestamp_now: now(),
    time_now: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
  };
}

function userInfo(line) {
  const st = lineStatus(line);
  return {
    username: line.username,
    password: line.password,
    message: '',
    auth: 1,
    status: st === 'vencido' ? 'Expired' : (st === 'ativo' || st === 'teste') ? 'Active' : 'Disabled',
    exp_date: line.exp_date ? String(line.exp_date) : null,
    is_trial: line.is_trial ? '1' : '0',
    active_cons: String(activeConnections(line.id).length),
    created_at: String(line.created_at),
    max_connections: String(line.max_connections),
    allowed_output_formats: ['m3u8', 'ts', 'rtmp'],
  };
}

const denied = (res, msg) =>
  res.json({
    user_info: {
      username: '', password: '', message: msg, auth: 0, status: 'Disabled',
      exp_date: null, is_trial: '0', active_cons: '0', created_at: '0',
      max_connections: '0', allowed_output_formats: ['m3u8', 'ts'],
    },
  });

// ----------------------------------------------------------------
// player_api.php  (API principal usada pelos apps)
// ----------------------------------------------------------------
function playerApi(req, res) {
  const { username, password } = creds(req);
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const auth = authLine(username, password, ip);

  if (!auth.ok) {
    logActivity({ line: auth.line, username, kind: 'denied', ip, ua, detail: auth.reason });
    return denied(res, auth.reason);
  }
  const line = auth.line;
  touchLine(line, ip, ua);

  const action = String(req.query.action ?? req.body?.action ?? '');
  if (!action) {
    logActivity({ line, kind: 'login', ip, ua, detail: 'player_api' });
    return res.json({ user_info: userInfo(line), server_info: serverInfo() });
  }

  const enc = encodeURIComponent;
  const streamBase = (kind) => `${config.publicUrl}/${kind}/${enc(line.username)}/${enc(line.password)}`;

  switch (action) {
    // ---------------- AO VIVO ----------------
    case 'get_live_categories': {
      const f = catFilter(line.id, 'c.id');
      return res.json(all(
        `SELECT c.id, c.name, c.sort_order FROM categories c
          WHERE c.type = 'live'
            AND EXISTS (SELECT 1 FROM streams s WHERE s.category_id = c.id AND s.enabled = 1)
            ${f.sql}
          ORDER BY c.sort_order, c.name`, ...f.params)
        .map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 })));
    }

    case 'get_live_streams': {
      const f = catFilter(line.id, 's.category_id');
      const cat = req.query.category_id;
      const rows = all(
        `SELECT s.* FROM streams s
          WHERE s.enabled = 1 ${f.sql} ${cat ? 'AND s.category_id = ?' : ''}
          ORDER BY s.sort_order, s.name`,
        ...f.params, ...(cat ? [Number(cat)] : []));
      return res.json(rows.map((s, i) => ({
        num: i + 1, name: s.name, stream_type: 'live', stream_id: s.id,
        stream_icon: s.logo || '', epg_channel_id: s.epg_id || null,
        added: String(s.added_at), is_adult: '0',
        category_id: String(s.category_id), category_ids: [s.category_id],
        custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0, thumbnail: '',
      })));
    }

    // ---------------- FILMES ----------------
    case 'get_vod_categories': {
      const f = catFilter(line.id, 'c.id');
      return res.json(all(
        `SELECT c.id, c.name FROM categories c
          WHERE c.type = 'movie'
            AND EXISTS (SELECT 1 FROM movies m WHERE m.category_id = c.id AND m.enabled = 1)
            ${f.sql}
          ORDER BY c.sort_order, c.name`, ...f.params)
        .map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 })));
    }

    case 'get_vod_streams': {
      const f = catFilter(line.id, 'm.category_id');
      const cat = req.query.category_id;
      const rows = all(
        `SELECT m.* FROM movies m
          WHERE m.enabled = 1 ${f.sql} ${cat ? 'AND m.category_id = ?' : ''}
          ORDER BY m.name`,
        ...f.params, ...(cat ? [Number(cat)] : []));
      return res.json(rows.map((m, i) => ({
        num: i + 1, name: m.name, stream_type: 'movie', stream_id: m.id,
        stream_icon: m.logo || '', rating: m.rating ? String(m.rating) : '0',
        rating_5based: m.rating ? Number(m.rating) / 2 : 0,
        added: String(m.added_at), is_adult: '0',
        category_id: String(m.category_id), category_ids: [m.category_id],
        container_extension: m.container, custom_sid: '', direct_source: '',
      })));
    }

    case 'get_vod_info': {
      const id = Number(req.query.vod_id);
      const m = get('SELECT * FROM movies WHERE id = ? AND enabled = 1', id);
      if (!m) return res.json({});
      const allowed = allowedCategories(line.id);
      if (allowed !== null && !allowed.has(m.category_id)) return res.json({});
      return res.json({
        info: {
          movie_image: m.logo || '', cover_big: m.logo || '', tmdb_id: '',
          backdrop_path: [], plot: m.plot || '', cast: '', director: '', genre: '',
          releasedate: m.year || '', rating: m.rating ? String(m.rating) : '0',
          duration_secs: m.duration || 0,
          duration: new Date((m.duration || 0) * 1000).toISOString().slice(11, 19),
          video: [], audio: [], bitrate: 0,
        },
        movie_data: {
          stream_id: m.id, name: m.name, added: String(m.added_at),
          category_id: String(m.category_id), container_extension: m.container,
          custom_sid: '', direct_source: `${streamBase('movie')}/${m.id}.${m.container}`,
        },
      });
    }

    // ---------------- SERIES ----------------
    case 'get_series_categories': {
      const f = catFilter(line.id, 'c.id');
      return res.json(all(
        `SELECT c.id, c.name FROM categories c
          WHERE c.type = 'series'
            AND EXISTS (SELECT 1 FROM series s WHERE s.category_id = c.id AND s.enabled = 1)
            ${f.sql}
          ORDER BY c.sort_order, c.name`, ...f.params)
        .map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 })));
    }

    case 'get_series': {
      const f = catFilter(line.id, 's.category_id');
      const cat = req.query.category_id;
      const rows = all(
        `SELECT s.* FROM series s
          WHERE s.enabled = 1 ${f.sql} ${cat ? 'AND s.category_id = ?' : ''}
          ORDER BY s.name`,
        ...f.params, ...(cat ? [Number(cat)] : []));
      return res.json(rows.map((s, i) => ({
        num: i + 1, name: s.name, series_id: s.id, cover: s.logo || '',
        plot: s.plot || '', cast: '', director: '', genre: '',
        releaseDate: s.year || '', last_modified: String(s.added_at),
        rating: s.rating ? String(s.rating) : '0', rating_5based: s.rating ? Number(s.rating) / 2 : 0,
        backdrop_path: [], youtube_trailer: '', episode_run_time: '0',
        category_id: String(s.category_id), category_ids: [s.category_id],
      })));
    }

    case 'get_series_info': {
      const id = Number(req.query.series_id);
      const s = get('SELECT * FROM series WHERE id = ? AND enabled = 1', id);
      if (!s) return res.json({});
      const allowed = allowedCategories(line.id);
      if (allowed !== null && !allowed.has(s.category_id)) return res.json({});

      const eps = all('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode', id);
      const episodes = {};
      const seasons = new Map();
      for (const e of eps) {
        const key = String(e.season);
        (episodes[key] ||= []).push({
          id: String(e.id), episode_num: e.episode, title: e.name,
          container_extension: e.container, custom_sid: '', added: String(e.added_at),
          season: e.season, direct_source: `${streamBase('series')}/${e.id}.${e.container}`,
          info: {
            movie_image: e.logo || s.logo || '', plot: '', duration_secs: e.duration || 0,
            duration: new Date((e.duration || 0) * 1000).toISOString().slice(11, 19),
            bitrate: 0, rating: 0, season: String(e.season), video: [], audio: [],
          },
        });
        seasons.set(e.season, (seasons.get(e.season) || 0) + 1);
      }
      return res.json({
        seasons: [...seasons.entries()].map(([n, count]) => ({
          air_date: '', episode_count: count, id: n, name: `Temporada ${n}`,
          overview: '', season_number: n, cover: s.logo || '', cover_big: s.logo || '',
        })),
        info: {
          name: s.name, cover: s.logo || '', plot: s.plot || '', cast: '', director: '',
          genre: '', releaseDate: s.year || '', last_modified: String(s.added_at),
          rating: s.rating ? String(s.rating) : '0', rating_5based: s.rating ? Number(s.rating) / 2 : 0,
          backdrop_path: [], youtube_trailer: '', episode_run_time: '0',
          category_id: String(s.category_id),
        },
        episodes,
      });
    }

    // ---------------- EPG ----------------
    case 'get_short_epg': {
      const sid = Number(req.query.stream_id);
      const limit = Math.min(Number(req.query.limit) || 4, 50);
      const s = get('SELECT * FROM streams WHERE id = ?', sid);
      if (!s || !s.epg_id) return res.json({ epg_listings: [] });
      const rows = all(
        'SELECT * FROM epg_programmes WHERE channel_id = ? AND stop_ts > ? ORDER BY start_ts LIMIT ?',
        s.epg_id, now(), limit);
      return res.json({ epg_listings: rows.map((p) => epgRow(p, sid)) });
    }

    case 'get_simple_data_table': {
      const sid = Number(req.query.stream_id);
      const s = get('SELECT * FROM streams WHERE id = ?', sid);
      if (!s || !s.epg_id) return res.json({ epg_listings: [] });
      const rows = all('SELECT * FROM epg_programmes WHERE channel_id = ? ORDER BY start_ts LIMIT 200', s.epg_id);
      return res.json({ epg_listings: rows.map((p) => epgRow(p, sid)) });
    }

    case 'get_account_info':
      return res.json({ user_info: userInfo(line), server_info: serverInfo() });

    default:
      return res.json({ user_info: userInfo(line), server_info: serverInfo() });
  }
}

function epgRow(p, streamId) {
  const b64 = (s) => Buffer.from(String(s || '')).toString('base64');
  const fmt = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return {
    id: String(p.id), epg_id: p.channel_id, title: b64(p.title), lang: 'pt',
    start: fmt(p.start_ts), end: fmt(p.stop_ts), description: b64(p.description),
    channel_id: p.channel_id, start_timestamp: String(p.start_ts), stop_timestamp: String(p.stop_ts),
    stream_id: String(streamId), now_playing: p.start_ts <= now() && p.stop_ts > now() ? 1 : 0,
    has_archive: 0,
  };
}

router.get('/player_api.php', playerApi);
router.post('/player_api.php', playerApi);
router.get('/panel_api.php', playerApi);
router.post('/panel_api.php', playerApi);

// ----------------------------------------------------------------
// get.php  ->  playlist M3U personalizada do cliente
// ----------------------------------------------------------------
router.get('/get.php', (req, res) => {
  const { username, password } = creds(req);
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const auth = authLine(username, password, ip);

  if (!auth.ok) {
    logActivity({ line: auth.line, username, kind: 'denied', ip, ua, detail: `get.php: ${auth.reason}` });
    return res.status(403).type('text/plain').send(`#EXTM3U\n# ACESSO NEGADO: ${auth.reason}\n`);
  }
  const line = auth.line;
  touchLine(line, ip, ua);
  logActivity({ line, kind: 'login', ip, ua, detail: 'get.php' });

  const output = ['ts', 'm3u8', 'mpegts'].includes(String(req.query.output)) ? String(req.query.output) : 'ts';
  const liveExt = output === 'm3u8' ? 'm3u8' : 'ts';
  const plus = String(req.query.type || 'm3u_plus') !== 'm3u';
  const want = String(req.query.content || 'all');   // all | live | vod | series

  const enc = encodeURIComponent;
  const base = config.publicUrl;
  const up = `${enc(line.username)}/${enc(line.password)}`;

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${line.username}.m3u"`);
  res.write('#EXTM3U\n');

  const emit = (name, logo, group, epgId, url) => {
    if (plus) {
      res.write(`#EXTINF:-1 tvg-id="${epgId || ''}" tvg-name="${String(name).replace(/"/g, "'")}" ` +
                `tvg-logo="${logo || ''}" group-title="${String(group).replace(/"/g, "'")}",${name}\n`);
    } else {
      res.write(`#EXTINF:-1,${name}\n`);
    }
    res.write(`${url}\n`);
  };

  if (want === 'all' || want === 'live') {
    const f = catFilter(line.id, 's.category_id');
    for (const s of all(
      `SELECT s.*, c.name AS cat FROM streams s LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.enabled = 1 ${f.sql} ORDER BY s.sort_order, s.name`, ...f.params)) {
      emit(s.name, s.logo, s.cat || 'Canais', s.epg_id, `${base}/live/${up}/${s.id}.${liveExt}`);
    }
  }
  if (want === 'all' || want === 'vod') {
    const f = catFilter(line.id, 'm.category_id');
    for (const m of all(
      `SELECT m.*, c.name AS cat FROM movies m LEFT JOIN categories c ON c.id = m.category_id
        WHERE m.enabled = 1 ${f.sql} ORDER BY m.name`, ...f.params)) {
      emit(m.name, m.logo, m.cat || 'Filmes', null, `${base}/movie/${up}/${m.id}.${m.container}`);
    }
  }
  if (want === 'all' || want === 'series') {
    const f = catFilter(line.id, 's.category_id');
    for (const e of all(
      `SELECT e.*, s.name AS sname, c.name AS cat FROM episodes e
         JOIN series s ON s.id = e.series_id
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.enabled = 1 ${f.sql} ORDER BY s.name, e.season, e.episode`, ...f.params)) {
      emit(e.name, e.logo, e.cat || 'Series', null, `${base}/series/${up}/${e.id}.${e.container}`);
    }
  }
  res.end();
});

// ----------------------------------------------------------------
// xmltv.php  ->  EPG
// ----------------------------------------------------------------
router.get('/xmltv.php', (req, res) => {
  const { username, password } = creds(req);
  const auth = authLine(username, password, clientIp(req));
  if (!auth.ok) return res.status(403).type('text/plain').send('acesso negado');

  const f = catFilter(auth.line.id, 's.category_id');
  const channels = all(
    `SELECT s.* FROM streams s
      WHERE s.enabled = 1 AND s.epg_id IS NOT NULL AND s.epg_id != '' ${f.sql}`, ...f.params);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="CLM IPTV Panel">\n');

  const seen = new Set();
  for (const c of channels) {
    if (seen.has(c.epg_id)) continue;
    seen.add(c.epg_id);
    res.write(`  <channel id="${escapeXml(c.epg_id)}"><display-name>${escapeXml(c.name)}</display-name>` +
              (c.logo ? `<icon src="${escapeXml(c.logo)}"/>` : '') + '</channel>\n');
  }
  const fmt = (ts) => {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
           `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
  };
  for (const ch of seen) {
    for (const p of all(
      'SELECT * FROM epg_programmes WHERE channel_id = ? AND stop_ts > ? ORDER BY start_ts', ch, now() - 86400)) {
      res.write(`  <programme start="${fmt(p.start_ts)}" stop="${fmt(p.stop_ts)}" channel="${escapeXml(ch)}">` +
                `<title lang="pt">${escapeXml(p.title)}</title>` +
                (p.description ? `<desc lang="pt">${escapeXml(p.description)}</desc>` : '') +
                '</programme>\n');
    }
  }
  res.end('</tv>\n');
});

export default router;

import fs from 'node:fs';
import { db, all, run, get, tx } from '../db.js';
import { parseM3U } from '../lib/m3u.js';
import { now } from '../lib/helpers.js';

/** Estado da ultima importacao (consultado pelo painel). */
export const importState = {
  running: false, phase: 'idle', processed: 0, total: 0,
  stats: null, startedAt: null, finishedAt: null, error: null,
};

function categoryMap(type) {
  const m = new Map();
  for (const c of all('SELECT id, name FROM categories WHERE type = ?', type)) m.set(c.name, c.id);
  return m;
}

function ensureCategory(cache, name, type, order) {
  if (cache.has(name)) return cache.get(name);
  run('INSERT OR IGNORE INTO categories(name, type, sort_order) VALUES(?,?,?)', name, type, order);
  const id = get('SELECT id FROM categories WHERE name = ? AND type = ?', name, type).id;
  cache.set(name, id);
  return id;
}

/**
 * Importa uma playlist para o banco.
 * @param {string} content  conteudo M3U
 * @param {{reset?:boolean, prune?:boolean, onProgress?:Function}} opts
 */
export function importM3U(content, opts = {}) {
  const { reset = false, prune = false } = opts;
  const ts = now();
  const { items, stats } = parseM3U(content);

  importState.running = true;
  importState.phase = 'gravando';
  importState.total = items.length;
  importState.processed = 0;
  importState.error = null;
  importState.startedAt = ts;

  const result = { ...stats, inserted: 0, updated: 0, newSeries: 0, episodes: 0, categories: 0, disabled: 0 };

  try {
    tx(() => {
      if (reset) {
        db.exec('DELETE FROM episodes; DELETE FROM series; DELETE FROM movies; DELETE FROM streams;');
        db.exec("DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM bouquet_categories)");
      }

      const catLive   = categoryMap('live');
      const catMovie  = categoryMap('movie');
      const catSeries = categoryMap('series');
      const catCountBefore = catLive.size + catMovie.size + catSeries.size;

      // indices de deduplicacao por URL de origem
      const liveByUrl  = new Map(all('SELECT id, source_url FROM streams').map((r) => [r.source_url, r.id]));
      const movieByUrl = new Map(all('SELECT id, source_url FROM movies').map((r) => [r.source_url, r.id]));
      const epByUrl    = new Map(all('SELECT id, source_url FROM episodes').map((r) => [r.source_url, r.id]));
      const seriesKey  = new Map(all('SELECT id, name, category_id FROM series').map((r) => [`${r.name}\u0000${r.category_id}`, r.id]));

      const insLive = db.prepare(`INSERT INTO streams(name,category_id,logo,epg_id,source_url,container,sort_order,added_at)
                                  VALUES(?,?,?,?,?,?,?,?)`);
      const updLive = db.prepare(`UPDATE streams SET name=?, category_id=?, logo=?, epg_id=?, container=?, sort_order=?, enabled=1 WHERE id=?`);
      const insMov  = db.prepare(`INSERT INTO movies(name,category_id,logo,source_url,container,duration,added_at)
                                  VALUES(?,?,?,?,?,?,?)`);
      const updMov  = db.prepare(`UPDATE movies SET name=?, category_id=?, logo=?, container=?, enabled=1 WHERE id=?`);
      const insSer  = db.prepare(`INSERT INTO series(name,category_id,logo,added_at) VALUES(?,?,?,?)`);
      const insEp   = db.prepare(`INSERT INTO episodes(series_id,season,episode,name,logo,source_url,container,duration,added_at)
                                  VALUES(?,?,?,?,?,?,?,?,?)`);
      const updEp   = db.prepare(`UPDATE episodes SET series_id=?, season=?, episode=?, name=?, logo=?, container=? WHERE id=?`);

      const seenLive = new Set(), seenMovie = new Set(), seenEp = new Set();
      let i = 0;

      for (const it of items) {
        i++;
        if (i % 2000 === 0) { importState.processed = i; opts.onProgress?.(i, items.length); }

        if (it.kind === 'live') {
          const cid = ensureCategory(catLive, it.group, 'live', 0);
          const exist = liveByUrl.get(it.url);
          if (exist) { updLive.run(it.name, cid, it.logo, it.epgId, it.container, i, exist); seenLive.add(exist); result.updated++; }
          else {
            const r = insLive.run(it.name, cid, it.logo, it.epgId, it.url, it.container, i, ts);
            liveByUrl.set(it.url, Number(r.lastInsertRowid)); seenLive.add(Number(r.lastInsertRowid)); result.inserted++;
          }
        } else if (it.kind === 'movie') {
          const cid = ensureCategory(catMovie, it.group, 'movie', 0);
          const exist = movieByUrl.get(it.url);
          if (exist) { updMov.run(it.name, cid, it.logo, it.container, exist); seenMovie.add(exist); result.updated++; }
          else {
            const r = insMov.run(it.name, cid, it.logo, it.url, it.container, it.duration, ts);
            movieByUrl.set(it.url, Number(r.lastInsertRowid)); seenMovie.add(Number(r.lastInsertRowid)); result.inserted++;
          }
        } else {
          const cid = ensureCategory(catSeries, it.group, 'series', 0);
          const key = `${it.seriesName}\u0000${cid}`;
          let sid = seriesKey.get(key);
          if (!sid) {
            sid = Number(insSer.run(it.seriesName, cid, it.logo, ts).lastInsertRowid);
            seriesKey.set(key, sid); result.newSeries++;
          }
          const exist = epByUrl.get(it.url);
          if (exist) { updEp.run(sid, it.season, it.episode, it.name, it.logo, it.container, exist); seenEp.add(exist); result.updated++; }
          else {
            const r = insEp.run(sid, it.season, it.episode, it.name, it.logo, it.url, it.container, it.duration, ts);
            epByUrl.set(it.url, Number(r.lastInsertRowid)); seenEp.add(Number(r.lastInsertRowid));
            result.episodes++; result.inserted++;
          }
        }
      }

      // conteudo que sumiu da lista nova
      if (prune && !reset) {
        const off = (table, seen) => {
          let n = 0;
          for (const row of all(`SELECT id FROM ${table} WHERE enabled = 1`)) {
            if (!seen.has(row.id)) { run(`UPDATE ${table} SET enabled = 0 WHERE id = ?`, row.id); n++; }
          }
          return n;
        };
        result.disabled = off('streams', seenLive) + off('movies', seenMovie);
      }

      result.categories = (catLive.size + catMovie.size + catSeries.size) - catCountBefore;
    });

    importState.stats = result;
    importState.phase = 'concluido';
  } catch (e) {
    importState.error = e.message;
    importState.phase = 'erro';
    throw e;
  } finally {
    importState.running = false;
    importState.processed = items.length;
    importState.finishedAt = now();
  }
  return result;
}

export function importFromFile(file, opts = {}) {
  if (!fs.existsSync(file)) throw new Error(`Arquivo nao encontrado: ${file}`);
  return importM3U(fs.readFileSync(file, 'utf8'), opts);
}

export async function importFromUrl(url, opts = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' } });
  if (!res.ok) throw new Error(`Fonte respondeu ${res.status}`);
  return importM3U(await res.text(), opts);
}

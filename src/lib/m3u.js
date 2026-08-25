import { containerFromUrl } from './helpers.js';

const ATTR_RE   = /([\w-]+)="([^"]*)"/g;
// "Nome S01 E02", "Nome S01E02", "Nome - 1x02"
const SERIES_RE = /^(.*?)[\s\-_.]+S(\d{1,3})\s*[\sEx]\s*E?(\d{1,4})\s*$/i;
const VOD_EXT   = ['mp4', 'mkv', 'avi', 'mov'];

/**
 * Faz o parse de uma playlist M3U/M3U8 estendida.
 * @returns {{items: Array, stats: object}}
 */
export function parseM3U(content) {
  const lines = String(content).split(/\r?\n/);
  const items = [];
  const stats = { total: 0, live: 0, movie: 0, series: 0, skipped: 0 };

  let pending = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const head  = line.slice(0, line.indexOf(',') === -1 ? line.length : line.indexOf(','));
      let m;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2];
      const title = line.indexOf(',') === -1 ? '' : line.slice(line.indexOf(',') + 1).trim();
      const dur   = parseInt((head.match(/#EXTINF:\s*(-?\d+)/) || [])[1] ?? -1, 10);
      pending = {
        name:  title || attrs['tvg-name'] || 'Sem nome',
        logo:  attrs['tvg-logo'] || null,
        epgId: attrs['tvg-id'] || null,
        group: attrs['group-title'] || 'Sem categoria',
        duration: dur > 0 ? dur : null,
      };
      continue;
    }

    if (line.startsWith('#EXTGRP:') && pending) { pending.group = line.slice(8).trim(); continue; }
    if (line.startsWith('#')) continue;
    if (!pending) { stats.skipped++; continue; }
    if (!/^https?:\/\//i.test(line) && !/^rtmps?:\/\//i.test(line)) { stats.skipped++; pending = null; continue; }

    const item = classify({ ...pending, url: line });
    items.push(item);
    stats.total++; stats[item.kind]++;
    pending = null;
  }
  return { items, stats };
}

/** Decide se a entrada e canal ao vivo, filme ou episodio de serie. */
export function classify(entry) {
  const url  = entry.url;
  const path = url.split('?')[0];
  const ext  = (path.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || '';
  const sm   = SERIES_RE.exec(entry.name);

  if (sm || /\/series\//i.test(path)) {
    return {
      ...entry,
      kind: 'series',
      seriesName: (sm ? sm[1] : entry.name).replace(/[\s\-_.]+$/, '').trim() || entry.group,
      season:  sm ? parseInt(sm[2], 10) : 1,
      episode: sm ? parseInt(sm[3], 10) : 1,
      container: containerFromUrl(url, 'mp4'),
    };
  }

  if (/\/movie\//i.test(path) || VOD_EXT.includes(ext)) {
    return { ...entry, kind: 'movie', container: containerFromUrl(url, 'mp4') };
  }

  return { ...entry, kind: 'live', container: containerFromUrl(url, 'ts') };
}

/** Gera o texto de uma playlist M3U a partir de linhas ja montadas. */
export function buildM3U(entries) {
  const out = ['#EXTM3U'];
  for (const e of entries) {
    const attrs = [
      `tvg-id="${e.epgId || ''}"`,
      `tvg-name="${(e.name || '').replace(/"/g, "'")}"`,
      `tvg-logo="${e.logo || ''}"`,
      `group-title="${(e.group || '').replace(/"/g, "'")}"`,
    ].join(' ');
    out.push(`#EXTINF:-1 ${attrs},${e.name}`);
    out.push(e.url);
  }
  return out.join('\n') + '\n';
}

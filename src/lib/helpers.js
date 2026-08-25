export const now = () => Math.floor(Date.now() / 1000);

export const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

/** IP real do cliente (respeita proxy reverso). */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket?.remoteAddress || '').replace('::ffff:', '');
}

/** dd/mm/aaaa hh:mm */
export function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const escapeXml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** remove acentos e normaliza para busca */
export const slugify = (s = '') =>
  String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Nome do container a partir da URL da fonte. */
export function containerFromUrl(url, fallback = 'ts') {
  const clean = String(url).split('?')[0];
  const m = clean.match(/\.([a-z0-9]{2,5})$/i);
  if (!m) return fallback;
  const ext = m[1].toLowerCase();
  return ['ts', 'm3u8', 'mp4', 'mkv', 'avi', 'mov', 'flv'].includes(ext) ? ext : fallback;
}

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// carrega .env (se existir) sem dependencia externa
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* node < 20.12 */ }
}

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

export const config = {
  port:           num(process.env.PORT, 8080),
  publicUrl:     (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 8080)}`).replace(/\/+$/, ''),
  jwtSecret:      process.env.JWT_SECRET || 'clm-iptv-dev-secret-troque-isto',
  sessionHours:   num(process.env.SESSION_HOURS, 12),
  streamMode:    (process.env.STREAM_MODE || 'redirect').toLowerCase(), // redirect | proxy
  proxyTimeout:   num(process.env.PROXY_TIMEOUT, 15000),
  connectionTtl:  num(process.env.CONNECTION_TTL, 90),
  trialHours:     num(process.env.TRIAL_HOURS, 6),
  dbPath:         path.resolve(ROOT, process.env.DB_PATH || './data/panel.db'),
  m3uPath:        path.resolve(ROOT, process.env.M3U_PATH || './lista.m3u'),
};

export default config;

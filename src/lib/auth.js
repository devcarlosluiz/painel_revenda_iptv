import crypto from 'node:crypto';
import { config } from '../config.js';

// ---------- senhas (scrypt) ----------
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch { return false; }
}

// ---------- token de sessao do painel (JWT-like HS256) ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');

export function issueToken(payload, hours = config.sessionHours) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + hours * 3600 };
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}`;
  return `${data}.${sign(data)}`;
}

export function verifyToken(token) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, s] = token.split('.');
  const expected = sign(`${h}.${p}`);
  if (s.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}

// ---------- geradores ----------
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
export const randomString = (len = 10) =>
  Array.from(crypto.randomBytes(len)).map((b) => ALPHA[b % ALPHA.length]).join('');

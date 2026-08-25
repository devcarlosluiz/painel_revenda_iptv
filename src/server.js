import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, all, get, run } from './db.js';
import { pruneConnections } from './services/access.js';
import adminRouter from './routes/admin.js';
import xtreamRouter from './routes/xtream.js';
import streamRouter from './routes/stream.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.set('query parser', 'simple');

// log simples de requisicoes do player
app.use((req, res, next) => {
  if (process.env.LOG_REQUESTS === '1') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl.slice(0, 120)}`);
  }
  next();
});

// ---- painel web ----
app.use('/painel', express.static(path.join(ROOT, 'src', 'public')));
app.get('/', (req, res) => res.redirect('/painel/'));

// ---- api do painel ----
app.use('/api', adminRouter);

// ---- api compativel Xtream Codes ----
app.use('/', xtreamRouter);

// ---- entrega de midia (rotas curingas por ultimo) ----
app.use('/', streamRouter);

app.get('/healthz', (req, res) => res.json({
  ok: true,
  uptime: Math.round(process.uptime()),
  canais: get('SELECT COUNT(*) AS n FROM streams WHERE enabled = 1').n,
  filmes: get('SELECT COUNT(*) AS n FROM movies WHERE enabled = 1').n,
  online: get('SELECT COUNT(*) AS n FROM connections').n,
}));

app.use((req, res) => res.status(404).type('text/plain').send('nao encontrado'));

// ---- rotinas de manutencao ----
setInterval(() => {
  try {
    pruneConnections();
    // remove logs com mais de 30 dias
    run('DELETE FROM activity WHERE at < ?', Math.floor(Date.now() / 1000) - 30 * 86400);
  } catch (e) { console.error('manutencao:', e.message); }
}, 60_000).unref();

const server = app.listen(config.port, () => {
  const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
  console.log('');
  console.log('  ██ CLM IPTV PANEL');
  console.log(`  painel .......: http://localhost:${config.port}/painel/`);
  console.log(`  url publica ..: ${config.publicUrl}`);
  console.log(`  modo stream ..: ${config.streamMode}`);
  console.log(`  conteudo .....: ${get('SELECT COUNT(*) AS n FROM streams').n} canais | ` +
              `${get('SELECT COUNT(*) AS n FROM movies').n} filmes | ` +
              `${get('SELECT COUNT(*) AS n FROM series').n} series`);
  console.log(`  clientes .....: ${get('SELECT COUNT(*) AS n FROM lines').n}`);
  if (!admins) console.log('  ATENCAO: nenhum admin cadastrado. Rode: npm run setup');
  console.log('');
});

const shutdown = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

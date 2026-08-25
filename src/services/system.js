import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Estado da maquina onde o painel roda (CPU, memoria, disco, uptime).
 * O uso de CPU vem da diferenca entre duas amostras - por isso a coleta
 * periodica: cada chamada da API entrega a medida dos ultimos segundos.
 */
const JANELA = 2000;

const tempos = () => os.cpus().map((c) => ({ ...c.times }));
const totalTempos = (t) => t.user + t.nice + t.sys + t.idle + t.irq;

let antesCpu = tempos();
let antesProc = process.cpuUsage();
let antesHr = process.hrtime.bigint();

/** null enquanto a primeira amostra nao fechou */
let uso = { total: null, cores: [], processo: null };

function amostrar() {
  const agoraCpu = tempos();
  const cores = agoraCpu.map((c, i) => {
    const base = antesCpu[i] || c;
    const dTotal = totalTempos(c) - totalTempos(base);
    const dIdle = c.idle - base.idle;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  });

  const agoraProc = process.cpuUsage();
  const agoraHr = process.hrtime.bigint();
  const janelaUs = Number(agoraHr - antesHr) / 1000;
  const gastoUs = (agoraProc.user - antesProc.user) + (agoraProc.system - antesProc.system);

  uso = {
    total: cores.length ? Math.round(cores.reduce((a, b) => a + b, 0) / cores.length) : 0,
    cores,
    // CPU do processo do painel em relacao a UM nucleo (mesma conta do top)
    processo: janelaUs > 0 ? Math.round((gastoUs / janelaUs) * 1000) / 10 : 0,
  };

  antesCpu = agoraCpu;
  antesProc = agoraProc;
  antesHr = agoraHr;
}

setInterval(amostrar, JANELA).unref();

/** espaco da particao onde fica o banco */
function disco() {
  try {
    const s = fs.statfsSync(path.dirname(config.dbPath));
    const total = Number(s.blocks) * Number(s.bsize);
    const livre = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return { total, livre, usado: total - livre, pct: Math.round(((total - livre) / total) * 100) };
  } catch { return null; }               // statfs nao disponivel no sistema
}

/** banco = arquivo principal + wal + shm */
function banco() {
  let bytes = 0;
  for (const sufixo of ['', '-wal', '-shm']) {
    try { bytes += fs.statSync(config.dbPath + sufixo).size; } catch { /* pode nao existir */ }
  }
  return bytes;
}

export function systemStats() {
  const cpus = os.cpus();
  const total = os.totalmem();
  const livre = os.freemem();
  const carga = os.loadavg();

  return {
    cpu: {
      modelo: cpus[0]?.model?.trim() || 'desconhecido',
      nucleos: cpus.length,
      velocidade: cpus[0]?.speed || null,             // MHz
      pct: uso.total,
      cores: uso.cores,
      processo: uso.processo,
      // loadavg zera no Windows; nesse caso nao mostra
      carga: carga.some((v) => v > 0) ? carga.map((v) => Math.round(v * 100) / 100) : null,
    },
    memoria: { total, livre, usado: total - livre, pct: Math.round(((total - livre) / total) * 100) },
    processo: {
      rss: process.memoryUsage.rss(),
      heap: process.memoryUsage().heapUsed,
      uptime: Math.round(process.uptime()),
      pid: process.pid,
    },
    disco: disco(),
    banco: banco(),
    host: {
      hostname: os.hostname(),
      plataforma: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      uptime: Math.round(os.uptime()),
    },
  };
}

export default systemStats;

/**
 * Importa a lista M3U para o banco do painel.
 *
 *   npm run import                          -> usa ./lista.m3u
 *   npm run import -- --file outra.m3u
 *   npm run import -- --url http://host/get.php?username=..&password=..&type=m3u_plus
 *   npm run import -- --reset               -> apaga o conteudo antigo antes
 *   npm run import -- --prune               -> desativa o que sumiu da lista nova
 */
import { config } from '../config.js';
import { db } from '../db.js';
import { importFromFile, importFromUrl } from '../services/importer.js';

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return !v || v.startsWith('--') ? true : v;
};

const opts = { reset: !!arg('reset'), prune: !!arg('prune') };
const url = arg('url');
const file = arg('file', config.m3uPath);

const t0 = Date.now();
console.log(url ? `baixando ${url}` : `lendo ${file}`);

const stats = url ? await importFromUrl(String(url), opts) : importFromFile(String(file), opts);

console.log('');
console.log(`  entradas lidas ..: ${stats.total}`);
console.log(`  canais ao vivo ..: ${stats.live}`);
console.log(`  filmes ..........: ${stats.movie}`);
console.log(`  episodios .......: ${stats.series}  (em ${stats.newSeries} series novas)`);
console.log(`  novos ...........: ${stats.inserted}`);
console.log(`  atualizados .....: ${stats.updated}`);
console.log(`  categorias novas : ${stats.categories}`);
if (stats.disabled) console.log(`  desativados .....: ${stats.disabled}`);
console.log(`  tempo ...........: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('');
console.log('dica: rode "npm run setup" depois da primeira importacao para criar os pacotes padrao');

db.close();

import zlib from 'node:zlib';

const MIN_BYTES = 1024;   // abaixo disso comprimir custa mais do que economiza

const wantsGzip = (req) => /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

/**
 * Devolve onde escrever a resposta: o proprio res, ou um gzip pipado nele.
 * Para as respostas grandes montadas com write() em loop (get.php, xmltv.php).
 */
export function gzipSink(req, res) {
  res.setHeader('Vary', 'Accept-Encoding');
  if (!wantsGzip(req)) return res;
  res.setHeader('Content-Encoding', 'gzip');
  const gz = zlib.createGzip({ level: 6 });
  gz.on('error', () => { try { res.end(); } catch {} });
  gz.pipe(res);
  return gz;
}

/** Middleware: comprime as respostas json (listas de canais, filmes e series). */
export function gzipJson(req, res, next) {
  const send = res.json.bind(res);
  res.json = (obj) => {
    res.setHeader('Vary', 'Accept-Encoding');
    if (!wantsGzip(req) || res.headersSent) return send(obj);
    const raw = Buffer.from(JSON.stringify(obj));
    if (raw.length < MIN_BYTES) return send(obj);
    // gzip assincrono: usa o threadpool e nao trava o event loop
    zlib.gzip(raw, (err, buf) => {
      if (err || res.headersSent) return send(obj);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
    });
    return res;
  };
  next();
}

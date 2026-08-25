/* ============================================================
   CLM IPTV - painel (SPA sem dependencias)
   ============================================================ */
const S = {
  token: localStorage.getItem('clm_token') || '',
  user: null,
  publicUrl: location.origin,
  page: 'dashboard',
  cache: {},
  timer: null,          // atualizacao automatica da tela atual
};

// ---------------- utilidades ----------------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');
function fmtData(ts) {
  if (!ts) return '<span style="color:var(--dim2)">sem vencimento</span>';
  const d = new Date(ts * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtHora(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function diasRestantes(ts) {
  if (!ts) return '∞';
  const d = Math.ceil((ts - Date.now() / 1000) / 86400);
  return d < 0 ? `${Math.abs(d)}d vencido` : `${d}d`;
}
function paraInputData(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const deInputData = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);

const fmtNum = (v) => Number(v || 0).toLocaleString('pt-BR');

function fmtTamanho(bytes) {
  const un = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < un.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${un[i]}`;
}

function fmtDuracao(seg) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min`;
  return `${s}s`;
}

function toast(msg, tipo = '') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

async function copiar(txt, btn) {
  try {
    await navigator.clipboard.writeText(txt);
    toast('copiado', 'ok');
    if (btn) { const o = btn.textContent; btn.textContent = 'copiado!'; setTimeout(() => (btn.textContent = o), 1200); }
  } catch { toast('nao foi possivel copiar', 'err'); }
}

// ---------------- api ----------------
async function api(path, opts = {}) {
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}`, ...(opts.headers || {}) },
  });
  if (r.status === 401) { sair(); throw new Error('sessao expirada'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `erro ${r.status}`);
  return data;
}

/** Envia o arquivo anexado no corpo cru da requisicao, com progresso de upload. */
function enviarArquivo(path, file, params = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}${qs ? `?${qs}` : ''}`);
    xhr.setRequestHeader('authorization', `Bearer ${S.token}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('falha de rede ao enviar o arquivo'));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* resposta sem json */ }
      if (xhr.status === 401) { sair(); return reject(new Error('sessao expirada')); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `erro ${xhr.status}`));
      resolve(data);
    };
    xhr.send(file);
  });
}

// ---------------- modal ----------------
function modal({ titulo, corpo, rodape, wide }) {
  $('#modal').className = `modal${wide ? ' wide' : ''}`;
  $('#modal').innerHTML = `
    <div class="mh"><b>${esc(titulo)}</b><button class="x" onclick="app.fecharModal()">&times;</button></div>
    <div class="mb">${corpo}</div>
    ${rodape ? `<div class="mf">${rodape}</div>` : ''}`;
  $('#overlay').classList.add('on');
}
const fecharModal = () => $('#overlay').classList.remove('on');
$('#overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'overlay') fecharModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

function confirmar(msg, fn) {
  modal({
    titulo: 'Confirmar',
    corpo: `<p style="line-height:1.6">${esc(msg)}</p>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn err" id="cfmOk">Confirmar</button>`,
  });
  $('#cfmOk').onclick = async () => { fecharModal(); await fn(); };
}

// ---------------- login ----------------
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#lgBtn');
  btn.disabled = true;
  $('#lgErr').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('#lgUser').value.trim(), password: $('#lgPass').value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'falha no login');
    S.token = d.token;
    localStorage.setItem('clm_token', d.token);
    await iniciar();
  } catch (err) { $('#lgErr').textContent = err.message; }
  btn.disabled = false;
};

function sair() {
  localStorage.removeItem('clm_token');
  S.token = '';
  S.user = null;
  $('#app').classList.remove('on');
  $('#login').style.display = 'flex';
}

async function trocarSenha() {
  modal({
    titulo: 'Trocar minha senha',
    corpo: `<div class="field"><label>Senha atual</label><input class="inp" id="pwAtual" type="password"></div>
            <div class="field"><label>Nova senha</label><input class="inp" id="pwNova" type="password"></div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="pwOk">Salvar</button>`,
  });
  $('#pwOk').onclick = async () => {
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({ current: $('#pwAtual').value, novo: $('#pwNova').value }) });
      fecharModal(); toast('senha alterada', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------------- navegacao ----------------
const MENU = [
  { sec: 'Gestão' },
  { id: 'dashboard', ic: '📊', nome: 'Dashboard' },
  { id: 'clientes',  ic: '👤', nome: 'Clientes' },
  { id: 'online',    ic: '🟢', nome: 'Online agora' },
  { id: 'logs',      ic: '📋', nome: 'Atividade' },
  { sec: 'Revenda' },
  { id: 'revendedores', ic: '🤝', nome: 'Revendedores', admin: true },
  { id: 'creditos',     ic: '💳', nome: 'Créditos' },
  { id: 'planos',       ic: '🏷️', nome: 'Planos', admin: true },
  { id: 'pacotes',      ic: '📦', nome: 'Pacotes', admin: true },
  { sec: 'Conteúdo' },
  { id: 'conteudo',   ic: '🎬', nome: 'Canais e filmes', admin: true },
  { id: 'categorias', ic: '🗂️', nome: 'Categorias', admin: true },
  { id: 'importar',   ic: '⬇️', nome: 'Importar / exportar', admin: true },
  { id: 'config',   ic: '⚙️', nome: 'Configurações', admin: true },
];

function montarMenu() {
  $('#nav').innerHTML = MENU
    .filter((m) => !m.admin || S.user.role === 'admin')
    .map((m) => m.sec
      ? `<div class="sec">${m.sec}</div>`
      : `<a data-p="${m.id}" onclick="app.ir('${m.id}')"><span class="ic">${m.ic}</span>${m.nome}</a>`)
    .join('');
  marcarMenu();
}
function marcarMenu() {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.p === S.page));
}

async function ir(page) {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  S.page = page;
  location.hash = page;
  marcarMenu();
  $('#view').innerHTML = '<div class="empty">carregando...</div>';
  try { await PAGES[page](); } catch (e) { $('#view').innerHTML = `<div class="empty">erro: ${esc(e.message)}</div>`; }
}

async function iniciar() {
  const me = await api('/me');
  S.user = me.user;
  S.publicUrl = me.publicUrl;
  $('#login').style.display = 'none';
  $('#app').classList.add('on');
  $('#meUser').textContent = `${me.user.username} (${me.user.role === 'admin' ? 'admin' : 'revenda'})`;
  $('#meCred').textContent = me.user.role === 'admin' ? '∞' : me.user.credits;
  montarMenu();
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('cliente/')) {            // link direto para os dados de um cliente
    await ir('clientes');
    return verCliente(Number(hash.split('/')[1]));
  }
  await ir(PAGES[hash] && (S.user.role === 'admin' || !MENU.find((m) => m.id === hash)?.admin) ? hash : 'dashboard');
}

// ============================================================
//  PAGINAS
// ============================================================
const PAGES = {};

// ---------------- dashboard ----------------
PAGES.dashboard = async () => {
  const d = await api('/dashboard');
  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Dashboard</h2><div class="sub">visão geral da sua revenda</div></div>
      <div class="tools"><button class="btn pri" onclick="app.novoCliente()">+ Novo cliente</button></div>
    </div>
    <div class="cards">
      <div class="stat pri"><div class="n">${d.lines}</div><div class="l">👥 Clientes</div></div>
      <div class="stat ok"><div class="n">${d.ativos}</div><div class="l">✅ Ativos</div></div>
      <div class="stat err"><div class="n">${d.vencidos}</div><div class="l">⛔ Vencidos</div></div>
      <div class="stat warn"><div class="n">${d.vencendo}</div><div class="l">⏰ Vencem em 3 dias</div></div>
      <div class="stat roxo"><div class="n">${d.online}</div><div class="l">📡 Online agora</div></div>
      <div class="stat"><div class="n">${S.user.role === 'admin' ? '∞' : d.credits}</div><div class="l">💳 Créditos</div></div>
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="ph"><b>Últimos clientes</b><button class="btn sm" onclick="app.ir('clientes')">ver todos</button></div>
        <table><tbody>
          ${d.ultimos.length ? d.ultimos.map((l) => `
            <tr onclick="app.verCliente(${l.id})" style="cursor:pointer">
              <td><b>${esc(l.username)}</b><div style="color:var(--dim);font-size:11.5px">${esc(l.customer_name || '')}</div></td>
              <td><span class="tag ${l.estado}"><span class="dot"></span>${l.estado}</span></td>
              <td style="color:var(--dim);text-align:right">${diasRestantes(l.exp_date)}</td>
            </tr>`).join('') : '<tr><td class="empty">nenhum cliente ainda</td></tr>'}
        </tbody></table>
      </div>
      <div class="panel">
        <div class="ph"><b>Atividade recente</b><button class="btn sm" onclick="app.ir('logs')">ver tudo</button></div>
        <table><tbody>
          ${d.atividade.length ? d.atividade.map((a) => `
            <tr>
              <td style="width:60px;color:var(--dim);font-size:11.5px">${fmtHora(a.at)}</td>
              <td><b>${esc(a.username || '-')}</b></td>
              <td class="trunc" style="color:var(--dim)">${esc(a.content_name || a.detail || a.kind)}</td>
            </tr>`).join('') : '<tr><td class="empty">sem atividade</td></tr>'}
        </tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="ph"><b>Conteúdo disponível</b></div>
      <div class="pb cards" style="margin:0">
        <div class="stat"><div class="n">${d.conteudo.canais}</div><div class="l">📺 Canais ao vivo</div></div>
        <div class="stat"><div class="n">${d.conteudo.filmes}</div><div class="l">🎬 Filmes</div></div>
        <div class="stat"><div class="n">${d.conteudo.series}</div><div class="l">📼 Séries</div></div>
        <div class="stat"><div class="n">${d.conteudo.episodios}</div><div class="l">🎞️ Episódios</div></div>
        <div class="stat"><div class="n">${d.conteudo.categorias}</div><div class="l">🗂️ Categorias</div></div>
      </div>
    </div>

    ${S.user.role === 'admin' ? `
      <div class="panel">
        <div class="ph"><b>Servidor</b>
          <span id="svQuando" style="color:var(--dim2);font-size:11.5px"></span></div>
        <div class="pb" id="svCorpo"><div class="empty">lendo a máquina...</div></div>
      </div>` : ''}`;

  if (S.user.role === 'admin') {
    await atualizarServidor();
    if (S.timer) clearInterval(S.timer);          // nunca deixa dois relogios rodando
    S.timer = setInterval(() => {
      if (!$('#svCorpo')) { clearInterval(S.timer); S.timer = null; return; }
      atualizarServidor().catch(() => {});
    }, 5000);
  }
};

/** estado da máquina onde o painel roda; recarrega sozinho a cada 5s */
async function atualizarServidor() {
  if (!$('#svCorpo')) return;
  const s = await api('/system');
  if (!$('#svCorpo')) return;                       // saiu da tela enquanto carregava

  const nivel = (p) => (p >= 85 ? ' err' : p >= 60 ? ' warn' : '');
  const barra = (p, estilo = '') =>
    `<div class="gauge${nivel(p)}" style="${estilo}"><i style="width:${Math.min(100, Math.max(0, p || 0))}%"></i></div>`;
  const info = (rot, val) => `<div class="sysinfo"><label>${rot}</label><div>${esc(val)}</div></div>`;
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

  $('#svCorpo').innerHTML = `
    <div class="cards" style="margin:0 0 14px">
      <div class="stat"><div class="n">${pct(s.cpu.pct)}</div>
        <div class="l">🧠 CPU · ${s.cpu.nucleos} núcleo(s)</div>${barra(s.cpu.pct)}</div>
      <div class="stat"><div class="n">${pct(s.memoria.pct)}</div>
        <div class="l">💾 RAM · ${fmtTamanho(s.memoria.usado)} de ${fmtTamanho(s.memoria.total)}</div>
        ${barra(s.memoria.pct)}</div>
      ${s.disco ? `<div class="stat"><div class="n">${pct(s.disco.pct)}</div>
        <div class="l">🗄️ Disco · ${fmtTamanho(s.disco.livre)} livres</div>${barra(s.disco.pct)}</div>` : ''}
      <div class="stat"><div class="n">${pct(s.cpu.processo)}</div>
        <div class="l">⚙️ Painel · de 1 núcleo · ${fmtTamanho(s.processo.rss)} de RAM</div></div>
    </div>

    ${s.cpu.cores.length > 1 ? `
      <div class="cores">
        ${s.cpu.cores.map((p, i) => `<span title="núcleo ${i + 1}: ${p}%">${barra(p, 'margin:0')}</span>`).join('')}
      </div>` : ''}

    <div class="grid3">
      ${info('Processador', s.cpu.modelo + (s.cpu.velocidade ? ` · ${s.cpu.velocidade} MHz` : ''))}
      ${info('Carga (1 / 5 / 15 min)', s.cpu.carga ? s.cpu.carga.join('  ·  ') : 'só no Linux')}
      ${info('Sistema', `${s.host.plataforma} (${s.host.arch})`)}
      ${info('Máquina ligada há', fmtDuracao(s.host.uptime))}
      ${info('Painel no ar há', `${fmtDuracao(s.processo.uptime)} · pid ${s.processo.pid}`)}
      ${info('Node e banco', `${s.host.node} · banco com ${fmtTamanho(s.banco)}`)}
    </div>`;
  $('#svQuando').textContent = `atualizado às ${new Date().toLocaleTimeString('pt-BR')} · host ${s.host.hostname}`;
}

// ---------------- clientes ----------------
S.cache.linhas = { page: 1, search: '', status: '' };

PAGES.clientes = async () => {
  const f = S.cache.linhas;
  const qs = new URLSearchParams({ page: f.page, limit: 25, search: f.search, status: f.status });
  const r = await api(`/lines?${qs}`);
  const totalPag = Math.max(1, Math.ceil(r.total / r.limit));

  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Clientes</h2><div class="sub">${r.total} linha(s) cadastrada(s)</div></div>
      <div class="tools">
        <input class="inp" id="fSearch" placeholder="buscar usuário, nome, whatsapp..." value="${esc(f.search)}" style="width:250px">
        <select class="inp" id="fStatus" style="width:150px">
          ${[['', 'todos'], ['ativo', 'ativos'], ['vencido', 'vencidos'], ['teste', 'testes'], ['desativado', 'desativados']]
            .map(([v, n]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <button class="btn" onclick="app.novoTeste()">⏱️ Teste</button>
        <button class="btn pri" onclick="app.novoCliente()">+ Novo cliente</button>
      </div>
    </div>
    <div class="panel">
      <table>
        <thead><tr>
          <th>Cliente</th><th>Senha</th><th>Status</th><th>Vencimento</th><th>Conexões</th>
          <th>Plano</th>${S.user.role === 'admin' ? '<th>Revenda</th>' : ''}<th style="text-align:right">Ações</th>
        </tr></thead>
        <tbody>
        ${r.data.length ? r.data.map((l) => `
          <tr>
            <td>
              <b style="cursor:pointer" onclick="app.verCliente(${l.id})">${esc(l.username)}</b>
              <div style="color:var(--dim);font-size:11.5px">${esc(l.customer_name || l.note || '')}</div>
            </td>
            <td class="mono" style="color:var(--dim)">${esc(l.password)}</td>
            <td><span class="tag ${l.estado}"><span class="dot"></span>${l.estado}</span></td>
            <td>${fmtData(l.exp_date)}<div style="color:var(--dim);font-size:11.5px">${diasRestantes(l.exp_date)}</div></td>
            <td>${l.online > 0 ? `<span class="tag on"><span class="dot"></span>${l.online}/${l.max_connections}</span>`
                                : `<span style="color:var(--dim)">0/${l.max_connections}</span>`}</td>
            <td style="color:var(--dim)">${esc(l.plan_name || '-')}</td>
            ${S.user.role === 'admin' ? `<td style="color:var(--dim)">${esc(l.owner)}</td>` : ''}
            <td style="text-align:right;white-space:nowrap">
              <button class="btn sm" onclick="app.verCliente(${l.id})" title="ver dados e links">🔗</button>
              <button class="btn sm" onclick="app.renovar(${l.id})" title="renovar">🔄</button>
              <button class="btn sm" onclick="app.editarCliente(${l.id})" title="editar">✏️</button>
              <button class="btn sm err" onclick="app.excluirCliente(${l.id},'${esc(l.username)}')" title="excluir">🗑️</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="9" class="empty">nenhum cliente encontrado</td></tr>`}
        </tbody>
      </table>
      <div class="pager">
        <span>página ${r.page} de ${totalPag}</span>
        <span>
          <button class="btn sm" ${r.page <= 1 ? 'disabled' : ''} onclick="app.pagLinhas(${r.page - 1})">anterior</button>
          <button class="btn sm" ${r.page >= totalPag ? 'disabled' : ''} onclick="app.pagLinhas(${r.page + 1})">próxima</button>
        </span>
      </div>
    </div>`;

  let t;
  $('#fSearch').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.search = e.target.value; f.page = 1; ir('clientes'); }, 350); };
  $('#fStatus').onchange = (e) => { f.status = e.target.value; f.page = 1; ir('clientes'); };
};
const pagLinhas = (p) => { S.cache.linhas.page = p; ir('clientes'); };

async function dadosForm() {
  if (!S.cache.planos) S.cache.planos = await api('/plans');
  if (!S.cache.bouquets) S.cache.bouquets = await api('/bouquets');
  return { planos: S.cache.planos, bouquets: S.cache.bouquets };
}

const senhaAleatoria = () => Math.random().toString(36).slice(2, 10);

async function novoCliente() {
  const { planos, bouquets } = await dadosForm();
  const ativos = planos.filter((p) => !p.is_trial && p.active);
  modal({
    titulo: 'Novo cliente',
    wide: true,
    corpo: `
      <div class="grid2">
        <div class="field"><label>Usuário (login do player)</label>
          <input class="inp mono" id="nUser" value="cli${Math.random().toString(36).slice(2, 7)}"></div>
        <div class="field"><label>Senha</label>
          <input class="inp mono" id="nPass" value="${senhaAleatoria()}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Plano</label>
          <select class="inp" id="nPlano">
            ${ativos.map((p) => `<option value="${p.id}">${esc(p.name)} — ${p.days} dias — ${p.credits_cost} créd.</option>`).join('')}
          </select></div>
        <div class="field"><label>Conexões simultâneas</label>
          <input class="inp" id="nConn" type="number" min="1" max="10" value="1"></div>
        <div class="field"><label>Nome do cliente</label>
          <input class="inp" id="nNome" placeholder="opcional"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>WhatsApp</label><input class="inp" id="nZap" placeholder="opcional"></div>
        <div class="field"><label>Observação</label><input class="inp" id="nObs" placeholder="opcional"></div>
      </div>
      <div class="field">
        <label>Pacotes liberados <span style="color:var(--dim2)">(vazio = o padrão do plano)</span></label>
        <div class="checklist">
          ${bouquets.map((b) => `<label><input type="checkbox" class="nBq" value="${b.id}">
            ${esc(b.name)}<span class="c">${b.categories.length} categorias</span></label>`).join('')}
        </div>
      </div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="nOk">Criar cliente</button>`,
  });
  $('#nOk').onclick = async () => {
    const body = {
      username: $('#nUser').value.trim(), password: $('#nPass').value.trim(),
      plan_id: Number($('#nPlano').value), max_connections: Number($('#nConn').value),
      customer_name: $('#nNome').value.trim(), whatsapp: $('#nZap').value.trim(), note: $('#nObs').value.trim(),
      bouquets: [...document.querySelectorAll('.nBq:checked')].map((c) => Number(c.value)),
    };
    try {
      const l = await api('/lines', { method: 'POST', body: JSON.stringify(body) });
      toast('cliente criado', 'ok');
      await iniciarCreditos();
      mostrarUrls(l);
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function novoTeste() {
  const { bouquets } = await dadosForm();
  modal({
    titulo: 'Gerar teste',
    corpo: `
      <div class="grid2">
        <div class="field"><label>Usuário</label><input class="inp mono" id="tUser" value="teste${Math.random().toString(36).slice(2, 6)}"></div>
        <div class="field"><label>Senha</label><input class="inp mono" id="tPass" value="${senhaAleatoria()}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Duração (horas)</label><input class="inp" id="tHoras" type="number" min="1" max="72" value="6"></div>
        <div class="field"><label>Conexões</label><input class="inp" id="tConn" type="number" min="1" max="4" value="1"></div>
      </div>
      <div class="field"><label>Pacotes</label>
        <div class="checklist">
          ${bouquets.map((b) => `<label><input type="checkbox" class="tBq" value="${b.id}">
            ${esc(b.name)}<span class="c">${b.categories.length} categorias</span></label>`).join('')}
        </div>
      </div>
      <div class="help">O teste não consome créditos e expira automaticamente.</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="tOk">Gerar teste</button>`,
  });
  $('#tOk').onclick = async () => {
    try {
      const l = await api('/lines', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#tUser').value.trim(), password: $('#tPass').value.trim(), is_trial: true,
          trial_hours: Number($('#tHoras').value), max_connections: Number($('#tConn').value),
          bouquets: [...document.querySelectorAll('.tBq:checked')].map((c) => Number(c.value)),
        }),
      });
      toast('teste gerado', 'ok');
      mostrarUrls(l);
    } catch (e) { toast(e.message, 'err'); }
  };
}

function blocoUrl(titulo, valor, extra = '') {
  const id = 'u' + Math.random().toString(36).slice(2, 8);
  return `<div class="urlbox">
      <div class="t"><span>${esc(titulo)}</span>
        <span>${extra}<button class="btn sm" onclick="app.copiar(document.getElementById('${id}').textContent,this)">copiar</button></span>
      </div>
      <div class="v" id="${id}">${esc(valor)}</div>
    </div>`;
}

function mostrarUrls(l) {
  const u = l.urls;
  const zap = l.whatsapp ? l.whatsapp.replace(/\D/g, '') : '';
  const texto = encodeURIComponent(
    `*Seus dados de acesso*\n\n` +
    `Servidor: ${u.server}\nUsuário: ${u.username}\nSenha: ${u.password}\n\n` +
    `Lista M3U:\n${u.m3u}\n\nEPG:\n${u.epg}\n\n` +
    `Vencimento: ${l.exp_date ? new Date(l.exp_date * 1000).toLocaleString('pt-BR') : 'sem vencimento'}`);

  modal({
    titulo: `Acesso de ${l.username}`,
    wide: true,
    corpo: `
      <div class="grid3" style="margin-bottom:16px">
        <div class="stat"><div class="n" style="font-size:15px">${esc(l.username)}</div><div class="l">usuário</div></div>
        <div class="stat"><div class="n" style="font-size:15px">${esc(l.password)}</div><div class="l">senha</div></div>
        <div class="stat"><div class="n" style="font-size:15px">${l.exp_date ? diasRestantes(l.exp_date) : '∞'}</div><div class="l">validade</div></div>
      </div>

      <b style="font-size:13px">1. Lista M3U — cole em qualquer player (VLC, Smart IPTV, IPTV Smarters)</b>
      <div style="height:8px"></div>
      ${blocoUrl('M3U (recomendado, .ts)', u.m3u, `<a class="btn sm" href="${esc(u.m3u)}" target="_blank">abrir</a>`)}
      ${blocoUrl('M3U em HLS (.m3u8)', u.m3u8)}
      ${blocoUrl('EPG / guia de programação (XMLTV)', u.epg)}

      <div style="height:14px"></div>
      <b style="font-size:13px">2. Xtream Codes API — para IPTV Smarters, TiviMate, XCIPTV</b>
      <div class="help" style="margin-bottom:8px">no app escolha "Xtream Codes API / Login com usuário e senha" e informe:</div>
      ${blocoUrl('Servidor (URL)', u.server)}
      ${blocoUrl('Usuário', u.username)}
      ${blocoUrl('Senha', u.password)}

      <div style="height:14px"></div>
      ${zap ? `<a class="btn ok" target="_blank" href="https://wa.me/55${zap}?text=${texto}">📱 Enviar no WhatsApp</a>` : ''}
      <button class="btn" onclick="app.copiar(decodeURIComponent('${texto}').replace(/\\*/g,''),this)">📋 Copiar mensagem pronta</button>`,
    rodape: `<button class="btn pri" onclick="app.fecharModal();app.ir('clientes')">Concluir</button>`,
  });
}

async function verCliente(id) {
  const l = await api(`/lines/${id}`);
  mostrarUrls(l);
}
// #cliente/12 abre direto a tela de acesso do cliente

async function editarCliente(id) {
  const l = await api(`/lines/${id}`);
  const { bouquets } = await dadosForm();
  modal({
    titulo: `Editar ${l.username}`,
    wide: true,
    corpo: `
      <div class="grid3">
        <div class="field"><label>Usuário</label><input class="inp mono" id="eUser" value="${esc(l.username)}"></div>
        <div class="field"><label>Senha</label><input class="inp mono" id="ePass" value="${esc(l.password)}"></div>
        <div class="field"><label>Conexões</label><input class="inp" id="eConn" type="number" min="1" max="10" value="${l.max_connections}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Vencimento</label><input class="inp" id="eExp" type="datetime-local" value="${paraInputData(l.exp_date)}"></div>
        <div class="field"><label>Status</label>
          <select class="inp" id="eStatus">
            ${[['active', 'ativo'], ['disabled', 'desativado'], ['banned', 'banido']]
              .map(([v, n]) => `<option value="${v}" ${l.status === v ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
        <div class="field"><label>Nome do cliente</label><input class="inp" id="eNome" value="${esc(l.customer_name || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>WhatsApp</label><input class="inp" id="eZap" value="${esc(l.whatsapp || '')}"></div>
        <div class="field"><label>IPs autorizados <span style="color:var(--dim2)">(vazio = qualquer)</span></label>
          <input class="inp mono" id="eIps" value="${esc(l.allowed_ips || '')}" placeholder="177.1.2.3, 200.4.5.6"></div>
      </div>
      <div class="field"><label>Observação</label><input class="inp" id="eObs" value="${esc(l.note || '')}"></div>
      <div class="field"><label>Pacotes liberados <span style="color:var(--dim2)">(nenhum marcado = acesso total)</span></label>
        <div class="checklist">
          ${bouquets.map((b) => `<label><input type="checkbox" class="eBq" value="${b.id}" ${l.bouquets.includes(b.id) ? 'checked' : ''}>
            ${esc(b.name)}<span class="c">${b.categories.length} categorias</span></label>`).join('')}
        </div>
      </div>
      ${l.conexoes.length ? `<div class="help">📡 ${l.conexoes.length} conexão(ões) ativa(s): ${l.conexoes.map((c) => esc(c.ip)).join(', ')}</div>` : ''}`,
    rodape: `<button class="btn err" onclick="app.derrubar(${l.id})">Derrubar conexões</button>
             <button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="eOk">Salvar</button>`,
  });
  $('#eOk').onclick = async () => {
    try {
      await api(`/lines/${l.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          username: $('#eUser').value.trim(), password: $('#ePass').value.trim(),
          max_connections: Number($('#eConn').value), exp_date: deInputData($('#eExp').value),
          status: $('#eStatus').value, customer_name: $('#eNome').value.trim(),
          whatsapp: $('#eZap').value.trim(), allowed_ips: $('#eIps').value.trim(), note: $('#eObs').value.trim(),
          bouquets: [...document.querySelectorAll('.eBq:checked')].map((c) => Number(c.value)),
        }),
      });
      fecharModal(); toast('cliente atualizado', 'ok'); ir('clientes');
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function renovar(id) {
  const { planos } = await dadosForm();
  const l = await api(`/lines/${id}`);
  const ativos = planos.filter((p) => !p.is_trial && p.active);
  modal({
    titulo: `Renovar ${l.username}`,
    corpo: `
      <div class="field"><label>Plano</label>
        <select class="inp" id="rPlano">
          ${ativos.map((p) => `<option value="${p.id}" ${p.id === l.plan_id ? 'selected' : ''}>
            ${esc(p.name)} — ${p.days} dias — ${p.credits_cost} crédito(s)</option>`).join('')}
        </select></div>
      <div class="help">Vencimento atual: <b>${fmtData(l.exp_date)}</b>.
        Se ainda estiver válido, os dias novos são somados ao que resta.
        ${S.user.role === 'admin' ? '' : `Seu saldo: <b>${S.user.credits}</b> crédito(s).`}</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="rOk">Renovar</button>`,
  });
  $('#rOk').onclick = async () => {
    try {
      const r = await api(`/lines/${l.id}/renew`, { method: 'POST', body: JSON.stringify({ plan_id: Number($('#rPlano').value) }) });
      fecharModal(); toast(`renovado até ${new Date(r.exp_date * 1000).toLocaleDateString('pt-BR')}`, 'ok');
      await iniciarCreditos(); ir('clientes');
    } catch (e) { toast(e.message, 'err'); }
  };
}

const derrubar = async (id) => {
  await api(`/lines/${id}/kill`, { method: 'POST' });
  toast('conexões derrubadas', 'ok');
};

const excluirCliente = (id, nome) => confirmar(`Excluir o cliente "${nome}"? Essa ação não pode ser desfeita.`, async () => {
  await api(`/lines/${id}`, { method: 'DELETE' });
  toast('cliente excluído', 'ok'); ir('clientes');
});

async function iniciarCreditos() {
  const me = await api('/me');
  S.user = me.user;
  $('#meCred').textContent = me.user.role === 'admin' ? '∞' : me.user.credits;
}

// ---------------- online ----------------
PAGES.online = async () => {
  const c = await api('/connections');
  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Online agora</h2><div class="sub">${c.length} conexão(ões) ativa(s) — atualiza sozinho a cada 15s</div></div>
      <button class="btn" onclick="app.ir('online')">🔄 Atualizar</button>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Cliente</th><th>Conteúdo</th><th>Tipo</th><th>IP</th><th>Player</th><th>Início</th><th></th></tr></thead>
        <tbody>
          ${c.length ? c.map((x) => `
            <tr>
              <td><b>${esc(x.username)}</b>${S.user.role === 'admin' ? `<div style="color:var(--dim);font-size:11.5px">${esc(x.owner)}</div>` : ''}</td>
              <td class="trunc">${esc(x.content_name || '-')}</td>
              <td><span class="tag on">${esc(x.kind)}</span></td>
              <td class="mono">${esc(x.ip || '-')}</td>
              <td class="trunc" style="color:var(--dim);max-width:200px">${esc((x.user_agent || '-').slice(0, 40))}</td>
              <td style="color:var(--dim)">${fmtHora(x.started_at)}</td>
              <td style="text-align:right"><button class="btn sm err" onclick="app.matarConexao(${x.id})">derrubar</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">ninguém assistindo agora</td></tr>'}
        </tbody>
      </table>
    </div>`;
  clearTimeout(S.cache.tOnline);
  S.cache.tOnline = setTimeout(() => { if (S.page === 'online') ir('online'); }, 15000);
};
const matarConexao = async (id) => { await api(`/connections/${id}`, { method: 'DELETE' }); toast('derrubado', 'ok'); ir('online'); };

// ---------------- logs ----------------
PAGES.logs = async () => {
  const a = await api('/activity?limit=300');
  $('#view').innerHTML = `
    <div class="head"><div><h2>Atividade</h2><div class="sub">últimos acessos e bloqueios</div></div>
      <button class="btn" onclick="app.ir('logs')">🔄 Atualizar</button></div>
    <div class="panel">
      <table>
        <thead><tr><th>Quando</th><th>Cliente</th><th>Ação</th><th>Conteúdo</th><th>IP</th><th>Player</th></tr></thead>
        <tbody>
          ${a.length ? a.map((x) => `
            <tr>
              <td style="color:var(--dim);white-space:nowrap">${fmtHora(x.at)}</td>
              <td><b>${esc(x.username || '-')}</b></td>
              <td><span class="tag ${x.kind === 'denied' ? 'vencido' : x.kind === 'login' ? 'on' : 'ativo'}">${esc(x.kind)}</span></td>
              <td class="trunc">${esc(x.content_name || x.detail || '-')}</td>
              <td class="mono">${esc(x.ip || '-')}</td>
              <td class="trunc" style="color:var(--dim);max-width:220px">${esc((x.user_agent || '-').slice(0, 45))}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">sem registros</td></tr>'}
        </tbody>
      </table>
    </div>`;
};

// ---------------- revendedores ----------------
PAGES.revendedores = async () => {
  const u = await api('/users');
  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Revendedores</h2><div class="sub">${u.length} usuário(s) do painel</div></div>
      <button class="btn pri" onclick="app.novoRevendedor()">+ Novo revendedor</button>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Usuário</th><th>Nome</th><th>Papel</th><th>Créditos</th><th>Clientes</th><th>Último acesso</th><th style="text-align:right">Ações</th></tr></thead>
        <tbody>
          ${u.map((x) => `
            <tr>
              <td><b>${esc(x.username)}</b>${!x.status ? ' <span class="tag desativado">inativo</span>' : ''}</td>
              <td style="color:var(--dim)">${esc(x.name || '-')}</td>
              <td><span class="tag ${x.role === 'admin' ? 'on' : 'ativo'}">${x.role === 'admin' ? 'admin' : 'revenda'}</span></td>
              <td><b>${x.role === 'admin' ? '∞' : x.credits}</b></td>
              <td>${x.linhas}</td>
              <td style="color:var(--dim)">${x.last_login ? fmtHora(x.last_login) : 'nunca'}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn sm" onclick="app.darCreditos(${x.id},'${esc(x.username)}')">💳 créditos</button>
                <button class="btn sm" onclick="app.editarRevendedor(${x.id})">✏️</button>
                ${x.id !== S.user.id ? `<button class="btn sm err" onclick="app.excluirRevendedor(${x.id},'${esc(x.username)}')">🗑️</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

function novoRevendedor() {
  modal({
    titulo: 'Novo revendedor',
    corpo: `
      <div class="grid2">
        <div class="field"><label>Usuário</label><input class="inp mono" id="rvUser"></div>
        <div class="field"><label>Senha</label><input class="inp mono" id="rvPass" value="${senhaAleatoria()}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Nome</label><input class="inp" id="rvNome"></div>
        <div class="field"><label>WhatsApp</label><input class="inp" id="rvZap"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Créditos iniciais</label><input class="inp" id="rvCred" type="number" min="0" value="0"></div>
        <div class="field"><label>Papel</label>
          <select class="inp" id="rvRole"><option value="reseller">revendedor</option><option value="admin">administrador</option></select></div>
      </div>
      <label class="chk"><input type="checkbox" id="rvTrial" checked> pode gerar testes grátis</label>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="rvOk">Criar</button>`,
  });
  $('#rvOk').onclick = async () => {
    try {
      const r = await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#rvUser').value.trim(), password: $('#rvPass').value.trim(),
          name: $('#rvNome').value.trim(), whatsapp: $('#rvZap').value.trim(),
          credits: Number($('#rvCred').value), role: $('#rvRole').value, can_trial: $('#rvTrial').checked,
        }),
      });
      fecharModal();
      toast(`revendedor ${r.username} criado (senha: ${r.password})`, 'ok');
      ir('revendedores');
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function editarRevendedor(id) {
  const u = (await api('/users')).find((x) => x.id === id);
  modal({
    titulo: `Editar ${u.username}`,
    corpo: `
      <div class="grid2">
        <div class="field"><label>Nome</label><input class="inp" id="euNome" value="${esc(u.name || '')}"></div>
        <div class="field"><label>WhatsApp</label><input class="inp" id="euZap" value="${esc(u.whatsapp || '')}"></div>
      </div>
      <div class="field"><label>Nova senha <span style="color:var(--dim2)">(deixe vazio para manter)</span></label>
        <input class="inp mono" id="euPass"></div>
      <label class="chk"><input type="checkbox" id="euStatus" ${u.status ? 'checked' : ''}> conta ativa</label>
      <label class="chk"><input type="checkbox" id="euTrial" ${u.can_trial ? 'checked' : ''}> pode gerar testes</label>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="euOk">Salvar</button>`,
  });
  $('#euOk').onclick = async () => {
    const body = {
      name: $('#euNome').value.trim(), whatsapp: $('#euZap').value.trim(),
      status: $('#euStatus').checked, can_trial: $('#euTrial').checked,
    };
    if ($('#euPass').value) body.password = $('#euPass').value;
    await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    fecharModal(); toast('salvo', 'ok'); ir('revendedores');
  };
}

function darCreditos(id, nome) {
  modal({
    titulo: `Créditos de ${nome}`,
    corpo: `<div class="field"><label>Quantidade (use negativo para retirar)</label>
              <input class="inp" id="cdQtd" type="number" value="10"></div>
            <div class="field"><label>Motivo</label><input class="inp" id="cdMotivo" value="Recarga"></div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="cdOk">Aplicar</button>`,
  });
  $('#cdOk').onclick = async () => {
    try {
      const r = await api(`/users/${id}/credits`, {
        method: 'POST', body: JSON.stringify({ amount: Number($('#cdQtd').value), reason: $('#cdMotivo').value }),
      });
      fecharModal(); toast(`novo saldo: ${r.balance}`, 'ok'); ir('revendedores');
    } catch (e) { toast(e.message, 'err'); }
  };
}

const excluirRevendedor = (id, nome) => confirmar(
  `Excluir "${nome}"? Todos os clientes dele também serão apagados.`,
  async () => { await api(`/users/${id}`, { method: 'DELETE' }); toast('excluído', 'ok'); ir('revendedores'); });

// ---------------- creditos ----------------
PAGES.creditos = async () => {
  const l = await api('/credits');
  $('#view').innerHTML = `
    <div class="head"><div><h2>Créditos</h2>
      <div class="sub">saldo atual: <b>${S.user.role === 'admin' ? '∞' : S.user.credits}</b></div></div></div>
    <div class="panel">
      <table>
        <thead><tr><th>Quando</th><th>Movimento</th><th>Saldo</th><th>Motivo</th><th>Por</th></tr></thead>
        <tbody>
          ${l.length ? l.map((x) => `
            <tr>
              <td style="color:var(--dim)">${fmtHora(x.at)}</td>
              <td><b style="color:${x.amount < 0 ? 'var(--err)' : 'var(--ok)'}">${x.amount > 0 ? '+' : ''}${x.amount}</b></td>
              <td>${x.balance}</td>
              <td>${esc(x.reason || '-')}</td>
              <td style="color:var(--dim)">${esc(x.actor || '-')}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="empty">nenhuma movimentação</td></tr>'}
        </tbody>
      </table>
    </div>`;
};

// ---------------- planos ----------------
PAGES.planos = async () => {
  const [p, b] = await Promise.all([api('/plans'), api('/bouquets')]);
  S.cache.planos = p; S.cache.bouquets = b;
  $('#view').innerHTML = `
    <div class="head"><div><h2>Planos</h2><div class="sub">duração e custo em créditos</div></div>
      <button class="btn pri" onclick="app.novoPlano()">+ Novo plano</button></div>
    <div class="panel">
      <table>
        <thead><tr><th>Plano</th><th>Dias</th><th>Créditos</th><th>Conexões</th><th>Pacotes padrão</th><th>Status</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${p.map((x) => `
            <tr>
              <td><b>${esc(x.name)}</b>${x.is_trial ? ' <span class="tag teste">teste</span>' : ''}</td>
              <td>${x.days}</td><td>${x.credits_cost}</td><td>${x.max_connections}</td>
              <td style="color:var(--dim)">${x.bouquets.map((id) => esc(b.find((y) => y.id === id)?.name || '')).join(', ') || '-'}</td>
              <td><span class="tag ${x.active ? 'ativo' : 'desativado'}">${x.active ? 'ativo' : 'inativo'}</span></td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn sm" onclick="app.editarPlano(${x.id})">✏️</button>
                <button class="btn sm err" onclick="app.excluirPlano(${x.id},'${esc(x.name)}')">🗑️</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

function formPlano(p = {}) {
  const b = S.cache.bouquets || [];
  return `
    <div class="grid2">
      <div class="field"><label>Nome</label><input class="inp" id="plNome" value="${esc(p.name || '')}"></div>
      <div class="field"><label>Duração (dias)</label><input class="inp" id="plDias" type="number" value="${p.days ?? 30}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Custo em créditos</label><input class="inp" id="plCred" type="number" step="0.5" value="${p.credits_cost ?? 1}"></div>
      <div class="field"><label>Conexões simultâneas</label><input class="inp" id="plConn" type="number" min="1" value="${p.max_connections ?? 1}"></div>
    </div>
    <div class="field"><label>Pacotes liberados por padrão</label>
      <div class="checklist">
        ${b.map((x) => `<label><input type="checkbox" class="plBq" value="${x.id}" ${p.bouquets?.includes(x.id) ? 'checked' : ''}>
          ${esc(x.name)}<span class="c">${x.categories.length} categorias</span></label>`).join('')}
      </div>
    </div>`;
}
const corpoPlano = () => ({
  name: $('#plNome').value.trim(), days: Number($('#plDias').value),
  credits_cost: Number($('#plCred').value), max_connections: Number($('#plConn').value),
  bouquets: [...document.querySelectorAll('.plBq:checked')].map((c) => Number(c.value)),
});

function novoPlano() {
  modal({ titulo: 'Novo plano', corpo: formPlano(),
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button><button class="btn pri" id="plOk">Criar</button>` });
  $('#plOk').onclick = async () => {
    await api('/plans', { method: 'POST', body: JSON.stringify(corpoPlano()) });
    fecharModal(); toast('plano criado', 'ok'); ir('planos');
  };
}
function editarPlano(id) {
  const p = S.cache.planos.find((x) => x.id === id);
  modal({ titulo: `Editar ${p.name}`, corpo: formPlano(p),
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button><button class="btn pri" id="plOk">Salvar</button>` });
  $('#plOk').onclick = async () => {
    await api(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(corpoPlano()) });
    fecharModal(); toast('salvo', 'ok'); ir('planos');
  };
}
const excluirPlano = (id, nome) => confirmar(`Excluir o plano "${nome}"?`, async () => {
  await api(`/plans/${id}`, { method: 'DELETE' }); toast('excluído', 'ok'); ir('planos');
});

// ---------------- pacotes ----------------
PAGES.pacotes = async () => {
  const [b, c] = await Promise.all([api('/bouquets'), api('/categories')]);
  S.cache.bouquets = b; S.cache.categorias = c;
  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Pacotes</h2><div class="sub">agrupam categorias e definem o que cada cliente enxerga</div></div>
      <button class="btn pri" onclick="app.novoPacote()">+ Novo pacote</button>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Pacote</th><th>Descrição</th><th>Categorias</th><th>Clientes usando</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${b.length ? b.map((x) => `
            <tr>
              <td><b>${esc(x.name)}</b></td>
              <td style="color:var(--dim)">${esc(x.description || '-')}</td>
              <td>${x.categories.length}</td>
              <td>${x.lines}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn sm" onclick="app.editarPacote(${x.id})">✏️ editar</button>
                <button class="btn sm err" onclick="app.excluirPacote(${x.id},'${esc(x.name)}')">🗑️</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="5" class="empty">nenhum pacote criado</td></tr>'}
        </tbody>
      </table>
    </div>`;
};

function formPacote(p = {}) {
  const cats = S.cache.categorias || [];
  const grupo = (tipo, titulo) => {
    const lista = cats.filter((c) => c.type === tipo);
    if (!lista.length) return '';
    return `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="font-size:12.5px">${titulo} (${lista.length})</b>
        <span>
          <button type="button" class="btn sm" onclick="app.marcarTodas('${tipo}',true)">marcar todas</button>
          <button type="button" class="btn sm" onclick="app.marcarTodas('${tipo}',false)">limpar</button>
        </span>
      </div>
      <div class="checklist">
        ${lista.map((c) => `<label><input type="checkbox" class="bqCat cat-${tipo}" value="${c.id}"
          ${p.categories?.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}<span class="c">${c.itens} itens</span></label>`).join('')}
      </div></div>`;
  };
  return `
    <div class="grid2">
      <div class="field"><label>Nome do pacote</label><input class="inp" id="bqNome" value="${esc(p.name || '')}"></div>
      <div class="field"><label>Descrição</label><input class="inp" id="bqDesc" value="${esc(p.description || '')}"></div>
    </div>
    ${grupo('live', '📺 Canais ao vivo')}
    ${grupo('movie', '🎬 Filmes')}
    ${grupo('series', '📼 Séries')}`;
}
const marcarTodas = (tipo, v) => document.querySelectorAll(`.cat-${tipo}`).forEach((c) => (c.checked = v));
const corpoPacote = () => ({
  name: $('#bqNome').value.trim(), description: $('#bqDesc').value.trim(),
  categories: [...document.querySelectorAll('.bqCat:checked')].map((c) => Number(c.value)),
});

function novoPacote() {
  modal({ titulo: 'Novo pacote', wide: true, corpo: formPacote(),
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button><button class="btn pri" id="bqOk">Criar</button>` });
  $('#bqOk').onclick = async () => {
    try {
      await api('/bouquets', { method: 'POST', body: JSON.stringify(corpoPacote()) });
      fecharModal(); toast('pacote criado', 'ok'); ir('pacotes');
    } catch (e) { toast(e.message, 'err'); }
  };
}
function editarPacote(id) {
  const p = S.cache.bouquets.find((x) => x.id === id);
  modal({ titulo: `Editar ${p.name}`, wide: true, corpo: formPacote(p),
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button><button class="btn pri" id="bqOk">Salvar</button>` });
  $('#bqOk').onclick = async () => {
    await api(`/bouquets/${id}`, { method: 'PATCH', body: JSON.stringify(corpoPacote()) });
    fecharModal(); toast('salvo', 'ok'); ir('pacotes');
  };
}
const excluirPacote = (id, nome) => confirmar(`Excluir o pacote "${nome}"?`, async () => {
  await api(`/bouquets/${id}`, { method: 'DELETE' }); toast('excluído', 'ok'); ir('pacotes');
});

// ---------------- conteudo ----------------
const filtroConteudo = (type) => ({ type, page: 1, search: '', category_id: '', total: 0, sel: new Set() });
S.cache.cont = filtroConteudo('live');

PAGES.conteudo = async () => {
  const f = S.cache.cont;
  if (!S.cache.categorias) S.cache.categorias = await api('/categories');
  const cats = S.cache.categorias.filter((c) => c.type === f.type);
  const qs = new URLSearchParams({ type: f.type, page: f.page, limit: 30, search: f.search, category_id: f.category_id });
  const r = await api(`/content?${qs}`);
  const totalPag = Math.max(1, Math.ceil(r.total / r.limit));
  const isSerie = f.type === 'series';

  f.total = r.total;
  const sel = f.sel instanceof Set ? f.sel : (f.sel = new Set());
  const marcados = r.data.length > 0 && r.data.every((x) => sel.has(x.id));

  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Conteúdo</h2><div class="sub">${r.total} item(ns) nesta aba</div></div>
      <div class="tools">
        ${f.type === 'live' ? '<button class="btn" onclick="app.novoCanal()">+ Canal manual</button>' : ''}
        <button class="btn pri" onclick="app.ir('importar')">⬇️ Importar lista</button>
      </div>
    </div>
    <div class="tabs">
      ${[['live', '📺 Canais'], ['movie', '🎬 Filmes'], ['series', '📼 Séries']]
        .map(([v, n]) => `<div class="${f.type === v ? 'active' : ''}" onclick="app.abaConteudo('${v}')">${n}</div>`).join('')}
    </div>
    <div class="panel">
      <div class="ph">
        <input class="inp" id="cSearch" placeholder="buscar pelo nome..." value="${esc(f.search)}" style="max-width:280px">
        <select class="inp" id="cCat" style="max-width:260px">
          <option value="">todas as categorias</option>
          ${cats.map((c) => `<option value="${c.id}" ${String(f.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)} (${c.itens})</option>`).join('')}
        </select>
      </div>
      <div class="bulk" id="cBulk" ${sel.size ? '' : 'hidden'}>
        <b id="cBulkN">${sel.size} selecionado(s)</b>
        <button class="btn sm pri" onclick="app.moverSelecionados()">🗂️ Mudar categoria</button>
        <button class="btn sm" onclick="app.limparSelecao()">limpar seleção</button>
        <span style="color:var(--dim2);font-size:12px">a seleção continua ao trocar de página</span>
      </div>
      <table>
        <thead><tr><th style="width:34px"><input type="checkbox" id="cAll" ${marcados ? 'checked' : ''}
            title="marcar os itens desta página"></th>
          <th style="width:44px"></th><th>Nome</th><th>Categoria</th>
          ${isSerie ? '<th>Episódios</th>' : '<th>Fonte</th>'}<th>Status</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${r.data.length ? r.data.map((x) => `
            <tr>
              <td><input type="checkbox" class="cSel" value="${x.id}" ${sel.has(x.id) ? 'checked' : ''}></td>
              <td>${x.logo ? `<img src="${esc(x.logo)}" style="width:32px;height:32px;object-fit:contain;border-radius:5px;background:#0b0f14" onerror="this.style.visibility='hidden'">` : ''}</td>
              <td><b>${esc(x.name)}</b></td>
              <td style="color:var(--dim)">${esc(x.categoria || '-')}</td>
              ${isSerie ? `<td>${x.episodios}</td>`
                        : `<td class="trunc mono" style="color:var(--dim2);max-width:260px" title="${esc(x.source_url)}">${esc(x.source_url)}</td>`}
              <td><span class="tag ${x.enabled ? 'ativo' : 'desativado'}">${x.enabled ? 'ativo' : 'oculto'}</span></td>
              <td style="text-align:right;white-space:nowrap">
                ${!isSerie ? `<button class="btn sm" onclick="app.testarFonte('${f.type}',${x.id},this)">testar</button>` : ''}
                <button class="btn sm" onclick="app.alternarConteudo('${f.type}',${x.id},${x.enabled ? 0 : 1})">${x.enabled ? 'ocultar' : 'ativar'}</button>
                <button class="btn sm" onclick="app.editarConteudo('${f.type}',${x.id})">✏️</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">nada encontrado</td></tr>'}
        </tbody>
      </table>
      <div class="pager">
        <span>página ${r.page} de ${totalPag}</span>
        <span>
          <button class="btn sm" ${r.page <= 1 ? 'disabled' : ''} onclick="app.pagConteudo(${r.page - 1})">anterior</button>
          <button class="btn sm" ${r.page >= totalPag ? 'disabled' : ''} onclick="app.pagConteudo(${r.page + 1})">próxima</button>
        </span>
      </div>
    </div>`;

  let t;
  $('#cSearch').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.search = e.target.value; f.page = 1; ir('conteudo'); }, 350); };
  $('#cCat').onchange = (e) => { f.category_id = e.target.value; f.page = 1; ir('conteudo'); };

  // ---- selecao em lote ----
  const atualizarBarra = () => {
    $('#cBulk').hidden = !sel.size;
    $('#cBulkN').textContent = `${sel.size} selecionado(s)`;
  };
  const caixas = [...document.querySelectorAll('.cSel')];
  caixas.forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) sel.add(Number(cb.value)); else sel.delete(Number(cb.value));
      $('#cAll').checked = caixas.length > 0 && caixas.every((c) => c.checked);
      atualizarBarra();
    };
  });
  $('#cAll').onchange = (e) => {
    caixas.forEach((cb) => {
      cb.checked = e.target.checked;
      if (cb.checked) sel.add(Number(cb.value)); else sel.delete(Number(cb.value));
    });
    atualizarBarra();
  };
};
const abaConteudo = (t) => { S.cache.cont = filtroConteudo(t); ir('conteudo'); };
const limparSelecao = () => { S.cache.cont.sel.clear(); ir('conteudo'); };

/** troca a categoria dos itens marcados (ou de todo o filtro) de uma vez */
function moverSelecionados() {
  const f = S.cache.cont;
  if (!f.sel.size) return toast('marque pelo menos um item', 'err');
  const podeFiltro = f.total > f.sel.size;
  modal({
    titulo: `Mudar categoria de ${f.sel.size} item(ns)`,
    corpo: `
      ${campoCategoria(f.type)}
      ${podeFiltro ? `<label class="chk"><input type="checkbox" id="mvTodos">
          aplicar aos ${f.total} itens do filtro atual, não só aos ${f.sel.size} marcados</label>` : ''}
      <div class="help">Nome, ID e URL de origem não mudam — só a categoria, então o cliente não perde favoritos.</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="mvOk">Mover</button>`,
  });
  ligarCampoCategoria();
  $('#mvOk').onclick = async () => {
    const btn = $('#mvOk');
    try {
      const todos = podeFiltro && $('#mvTodos').checked;
      const body = {
        ...corpoCategoria(),
        ...(todos ? { all: true, filtro: { search: f.search, category_id: f.category_id } } : { ids: [...f.sel] }),
      };
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span> movendo...';
      const r = await api(`/content/${f.type}/category`, { method: 'POST', body: JSON.stringify(body) });
      fecharModal(); toast(`${r.movidos} item(ns) movido(s)`, 'ok');
      f.sel.clear(); S.cache.categorias = null; ir('conteudo');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Mover';
      toast(e.message, 'err');
    }
  };
}
const pagConteudo = (p) => { S.cache.cont.page = p; ir('conteudo'); };

const alternarConteudo = async (type, id, enabled) => {
  await api(`/content/${type}/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  ir('conteudo');
};

async function testarFonte(type, id, btn) {
  const antes = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    const r = await api(`/content/${type}/${id}/test`, { method: 'POST' });
    btn.textContent = r.ok ? `✅ ${r.ms}ms` : `❌ ${r.status || r.error}`;
  } catch { btn.textContent = '❌'; }
  setTimeout(() => (btn.textContent = antes), 4000);
}

/** select de categoria com a opcao de criar uma nova na hora */
function campoCategoria(type, atual = null) {
  const cats = (S.cache.categorias || []).filter((c) => c.type === type);
  return `<div class="field"><label>Categoria</label>
      <select class="inp" id="ctCat">
        <option value="" ${atual ? '' : 'selected'}>— sem categoria —</option>
        ${cats.map((c) => `<option value="${c.id}" ${c.id === atual ? 'selected' : ''}>${esc(c.name)} (${c.itens})</option>`).join('')}
        <option value="nova">＋ criar nova categoria</option>
      </select>
      <input class="inp" id="ctCatNova" placeholder="nome da nova categoria" style="margin-top:6px;display:none"></div>`;
}

/** liga o input de nome novo ao select; chame depois de montar o modal */
function ligarCampoCategoria() {
  const sel = $('#ctCat');
  const novo = $('#ctCatNova');
  sel.onchange = () => {
    novo.style.display = sel.value === 'nova' ? '' : 'none';
    if (sel.value === 'nova') novo.focus();
  };
}

/** parte do corpo do PATCH/POST que descreve a categoria escolhida */
function corpoCategoria() {
  const v = $('#ctCat').value;
  if (v === 'nova') {
    const nome = $('#ctCatNova').value.trim();
    if (!nome) throw new Error('informe o nome da nova categoria');
    return { category_name: nome };
  }
  return { category_id: v === '' ? null : Number(v) };
}

async function editarConteudo(type, id) {
  const x = await api(`/content/${type}/${id}`);
  if (!S.cache.categorias) S.cache.categorias = await api('/categories');
  const isSerie = type === 'series';
  modal({
    titulo: `Editar: ${x.name}`,
    corpo: `
      <div class="field"><label>Nome</label><input class="inp" id="ctNome" value="${esc(x.name)}"></div>
      ${isSerie ? '' : `<div class="field"><label>URL da fonte</label><input class="inp mono" id="ctUrl" value="${esc(x.source_url)}"></div>`}
      <div class="grid2">
        ${campoCategoria(type, x.category_id)}
        ${isSerie ? '' : `<div class="field"><label>Entrega</label>
          <select class="inp" id="ctProxy">
            <option value="">padrão do servidor</option>
            <option value="0" ${x.proxy_mode === 0 ? 'selected' : ''}>redirect (não gasta banda)</option>
            <option value="1" ${x.proxy_mode === 1 ? 'selected' : ''}>proxy (esconde a fonte)</option>
          </select></div>`}
      </div>
      ${type === 'live' ? `<div class="field"><label>ID do EPG (tvg-id)</label><input class="inp mono" id="ctEpg" value="${esc(x.epg_id || '')}"></div>` : ''}
      <div class="field"><label>Logo</label><input class="inp mono" id="ctLogo" value="${esc(x.logo || '')}"></div>`,
    rodape: `<button class="btn err" onclick="app.excluirConteudo('${type}',${id})">Excluir</button>
             <button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="ctOk">Salvar</button>`,
  });
  ligarCampoCategoria();
  $('#ctOk').onclick = async () => {
    try {
      const proxy = isSerie ? '' : $('#ctProxy').value;
      await api(`/content/${type}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#ctNome').value, logo: $('#ctLogo').value, ...corpoCategoria(),
          ...(isSerie ? {} : { source_url: $('#ctUrl').value, proxy_mode: proxy === '' ? null : Number(proxy) }),
          ...(type === 'live' ? { epg_id: $('#ctEpg').value } : {}),
        }),
      });
      fecharModal(); toast('salvo', 'ok'); S.cache.categorias = null; ir('conteudo');
    } catch (e) { toast(e.message, 'err'); }
  };
}
const excluirConteudo = (type, id) => confirmar('Excluir este item do painel?', async () => {
  await api(`/content/${type}/${id}`, { method: 'DELETE' }); fecharModal(); toast('excluído', 'ok'); ir('conteudo');
});

function novoCanal() {
  modal({
    titulo: 'Novo canal manual',
    corpo: `
      <div class="field"><label>Nome</label><input class="inp" id="ncNome"></div>
      <div class="field"><label>URL da fonte (.ts, .m3u8)</label><input class="inp mono" id="ncUrl"></div>
      ${campoCategoria('live')}
      <div class="grid2">
        <div class="field"><label>Logo (url)</label><input class="inp mono" id="ncLogo"></div>
        <div class="field"><label>tvg-id (EPG)</label><input class="inp mono" id="ncEpg"></div>
      </div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button><button class="btn pri" id="ncOk">Adicionar</button>`,
  });
  ligarCampoCategoria();
  $('#ncOk').onclick = async () => {
    try {
      await api('/content/live', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#ncNome').value.trim(), source_url: $('#ncUrl').value.trim(), ...corpoCategoria(),
          logo: $('#ncLogo').value.trim(), epg_id: $('#ncEpg').value.trim(),
        }),
      });
      fecharModal(); toast('canal adicionado', 'ok'); S.cache.categorias = null; ir('conteudo');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------------- categorias ----------------
S.cache.cat = { type: 'live', search: '' };

const TIPOS_CAT = [['live', '📺 Canais'], ['movie', '🎬 Filmes'], ['series', '📼 Séries']];
const nomeTipo = (t) => (TIPOS_CAT.find(([v]) => v === t) || [, t])[1];

PAGES.categorias = async () => {
  const f = S.cache.cat;
  const todas = await api('/categories');
  S.cache.categorias = todas;
  const busca = f.search.trim().toLowerCase();
  const lista = todas.filter((c) => c.type === f.type && c.name.toLowerCase().includes(busca));
  const itens = lista.reduce((n, c) => n + c.itens, 0);

  $('#view').innerHTML = `
    <div class="head">
      <div><h2>Categorias</h2>
        <div class="sub">renomeie, reordene, junte ou crie as categorias que o cliente ve no player</div></div>
      <button class="btn pri" onclick="app.novaCategoria()">+ Nova categoria</button>
    </div>
    <div class="tabs">
      ${TIPOS_CAT.map(([v, n]) => `<div class="${f.type === v ? 'active' : ''}" onclick="app.abaCategoria('${v}')">
        ${n} (${todas.filter((c) => c.type === v).length})</div>`).join('')}
    </div>
    <div class="panel">
      <div class="ph">
        <input class="inp" id="catBusca" placeholder="buscar categoria..." value="${esc(f.search)}" style="max-width:280px">
        <span style="color:var(--dim);font-size:12.5px">${lista.length} categoria(s) · ${itens} item(ns)</span>
      </div>
      <table>
        <thead><tr><th>Categoria</th><th style="width:120px">Itens</th><th style="width:90px">Ordem</th>
          <th style="text-align:right"></th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((c) => `
            <tr>
              <td><b>${esc(c.name)}</b></td>
              <td>${c.itens
                ? `<a onclick="app.verConteudoCategoria('${c.type}',${c.id})" style="cursor:pointer">${c.itens} item(ns)</a>`
                : '<span style="color:var(--dim2)">vazia</span>'}</td>
              <td style="color:var(--dim)">${c.sort_order}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn sm" onclick="app.editarCategoria(${c.id})">✏️ editar</button>
                ${c.itens ? `<button class="btn sm" onclick="app.moverCategoria(${c.id})">➡️ mover itens</button>` : ''}
                <button class="btn sm err" onclick="app.excluirCategoria(${c.id})">🗑️</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="4" class="empty">nenhuma categoria neste tipo</td></tr>'}
        </tbody>
      </table>
      <div class="pb" style="padding-top:0">
        <div class="help">Cliente com pacote marcado só enxerga as categorias que estão no pacote dele —
          ao criar uma categoria nova, marque ela em <b>Pacotes</b>. Cliente sem pacote vê tudo.</div>
      </div>
    </div>`;

  let t;
  $('#catBusca').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { f.search = e.target.value; ir('categorias'); }, 300);
  };
};

const abaCategoria = (t) => { S.cache.cat = { type: t, search: '' }; ir('categorias'); };
const verConteudoCategoria = (type, id) => {
  S.cache.cont = { ...filtroConteudo(type), category_id: String(id) };
  ir('conteudo');
};

const acharCategoria = (id) => (S.cache.categorias || []).find((c) => c.id === id);

/** select com as outras categorias do mesmo tipo (destino de mover/juntar) */
const opcoesDestino = (cat) => (S.cache.categorias || [])
  .filter((c) => c.type === cat.type && c.id !== cat.id)
  .map((c) => `<option value="${c.id}">${esc(c.name)} (${c.itens})</option>`).join('');

function novaCategoria() {
  const tipo = S.cache.cat?.type || 'live';
  modal({
    titulo: 'Nova categoria',
    corpo: `
      <div class="field"><label>Nome</label><input class="inp" id="caNome" placeholder="Ex.: Esportes HD"></div>
      <div class="grid2">
        <div class="field"><label>Tipo</label>
          <select class="inp" id="caTipo">
            ${TIPOS_CAT.map(([v, n]) => `<option value="${v}" ${v === tipo ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
        <div class="field"><label>Ordem</label><input class="inp" id="caOrdem" type="number" value="0"></div>
      </div>
      <div class="help">A ordem define a posição da categoria na lista do player (menor aparece primeiro).
        Categorias novas começam vazias — mande conteúdo para elas em <b>Conteúdo → editar</b>.</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="caOk">Criar</button>`,
  });
  $('#caOk').onclick = async () => {
    try {
      const c = await api('/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#caNome').value.trim(), type: $('#caTipo').value, sort_order: Number($('#caOrdem').value) || 0,
        }),
      });
      fecharModal(); toast('categoria criada', 'ok');
      S.cache.cat = { type: c.type, search: '' };
      ir('categorias');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function editarCategoria(id) {
  const c = acharCategoria(id);
  if (!c) return;
  modal({
    titulo: `Editar categoria: ${c.name}`,
    corpo: `
      <div class="field"><label>Nome</label><input class="inp" id="caNome" value="${esc(c.name)}"></div>
      <div class="grid2">
        <div class="field"><label>Tipo</label>
          <select class="inp" id="caTipo" ${c.itens ? 'disabled' : ''}>
            ${TIPOS_CAT.map(([v, n]) => `<option value="${v}" ${v === c.type ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
        <div class="field"><label>Ordem</label><input class="inp" id="caOrdem" type="number" value="${c.sort_order}"></div>
      </div>
      <div class="help">${c.itens
        ? `${c.itens} item(ns) nesta categoria — o tipo só muda depois de mover ou excluir o conteúdo.`
        : 'categoria vazia'}</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn pri" id="caOk">Salvar</button>`,
  });
  $('#caOk').onclick = async () => {
    try {
      await api(`/categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#caNome').value.trim(), type: $('#caTipo').value, sort_order: Number($('#caOrdem').value) || 0,
        }),
      });
      fecharModal(); toast('categoria salva', 'ok'); ir('categorias');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function moverCategoria(id) {
  const c = acharCategoria(id);
  if (!c) return;
  const destinos = opcoesDestino(c);
  modal({
    titulo: `Mover itens de: ${c.name}`,
    corpo: destinos
      ? `<div class="field"><label>Mover os ${c.itens} item(ns) para</label>
           <select class="inp" id="caDest">${destinos}</select></div>
         <div class="help">A categoria "${esc(c.name)}" continua existindo, só fica vazia.</div>`
      : `<div class="help">não existe outra categoria de ${nomeTipo(c.type)} para receber os itens —
           crie uma primeiro.</div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             ${destinos ? '<button class="btn pri" id="caOk">Mover</button>' : ''}`,
  });
  if (!destinos) return;
  $('#caOk').onclick = async () => {
    try {
      const r = await api(`/categories/${id}/move`, {
        method: 'POST', body: JSON.stringify({ to: Number($('#caDest').value) }),
      });
      fecharModal(); toast(`${r.movidos} item(ns) movido(s)`, 'ok'); ir('categorias');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function excluirCategoria(id) {
  const c = acharCategoria(id);
  if (!c) return;
  if (!c.itens) {
    return confirmar(`Excluir a categoria "${c.name}"?`, async () => {
      await api(`/categories/${id}`, { method: 'DELETE' });
      toast('categoria excluída', 'ok'); ir('categorias');
    });
  }
  const destinos = opcoesDestino(c);
  const oQue = c.type === 'series'
    ? `${c.itens} série(s) — com todos os episódios`
    : `${c.itens} item(ns)`;

  modal({
    titulo: `Excluir categoria: ${c.name}`,
    corpo: `
      <div class="help" style="margin-bottom:12px">A categoria tem <b>${oQue}</b>.
        O que fazer com esse conteúdo?</div>
      ${destinos ? `
        <label class="chk"><input type="radio" name="caAcao" value="mover" checked>
          mover para outra categoria</label>
        <div class="field" style="margin:6px 0 14px 23px">
          <select class="inp" id="caDest">${destinos}</select></div>` : ''}
      <label class="chk"><input type="radio" name="caAcao" value="apagar" ${destinos ? '' : 'checked'}>
        apagar o conteúdo junto com a categoria</label>
      <div class="help" id="caAviso"></div>`,
    rodape: `<button class="btn" onclick="app.fecharModal()">Cancelar</button>
             <button class="btn err" id="caOk"></button>`,
  });

  const acao = () => document.querySelector('input[name=caAcao]:checked').value;
  const atualizar = () => {
    const apagar = acao() === 'apagar';
    $('#caOk').textContent = apagar ? 'Apagar categoria e conteúdo' : 'Mover e excluir';
    $('#caAviso').innerHTML = apagar
      ? `<span style="color:var(--err)">Some de vez: ${esc(oQue)} sai do painel e do player dos clientes.
         Para ter de volta é preciso importar a lista outra vez.</span>`
      : `O conteúdo vai para a categoria escolhida e só a categoria "${esc(c.name)}" é excluída.`;
  };
  document.querySelectorAll('input[name=caAcao]').forEach((r) => { r.onchange = atualizar; });
  atualizar();

  $('#caOk').onclick = async () => {
    const btn = $('#caOk');
    try {
      btn.disabled = true;
      const apagar = acao() === 'apagar';
      const qs = apagar ? 'delete_content=1' : `move_to=${$('#caDest').value}`;
      const r = await api(`/categories/${id}?${qs}`, { method: 'DELETE' });
      fecharModal();
      toast(apagar
        ? `categoria e ${r.excluidos} item(ns) excluídos`
        : `categoria excluída, ${r.movidos} item(ns) movido(s)`, 'ok');
      S.cache.categorias = null;
      ir('categorias');
    } catch (e) { btn.disabled = false; toast(e.message, 'err'); }
  };
}

// ---------------- importar ----------------
PAGES.importar = async () => {
  const cfg = await api('/settings');
  const maxMb = Number(cfg.importMaxMb) || 200;
  $('#view').innerHTML = `
    <div class="head"><div><h2>Importar / exportar</h2>
      <div class="sub">carregue uma lista nova (arquivo, URL ou texto) ou baixe a lista já organizada no painel</div></div></div>

    <div class="panel">
      <div class="ph"><b>Origem</b></div>
      <div class="pb">
        <div class="field"><label>Arquivo da lista <span style="color:var(--dim2)">(.m3u, .m3u8, .txt — até ${maxMb} MB)</span></label>
          <label class="drop" id="imDrop">
            <input type="file" id="imFile" accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/x-mpegurl" hidden>
            <span class="ic">📎</span>
            <span><b>Clique para anexar</b> ou arraste o arquivo aqui</span>
          </label>
          <div class="help" id="imFileInfo">nenhum arquivo selecionado</div></div>
        <div class="field"><label>ou URL da lista <span style="color:var(--dim2)">(get.php do seu fornecedor, por exemplo)</span></label>
          <input class="inp mono" id="imUrl" placeholder="http://servidor.com/get.php?username=..&password=..&type=m3u_plus"
                 value="${esc(cfg.db.m3u_source_url || '')}"></div>
        <div class="field"><label>ou cole o conteúdo da lista</label>
          <textarea class="inp mono" id="imTexto" rows="5" placeholder="#EXTM3U ..."></textarea></div>
        <label class="chk"><input type="checkbox" id="imReset"> apagar todo o conteúdo atual antes de importar</label>
        <label class="chk"><input type="checkbox" id="imPrune"> ocultar o que não estiver na lista nova</label>
        <div class="help">Itens já existentes são atualizados pela URL de origem — os IDs não mudam, então
          os clientes não perdem favoritos.</div>
        <div style="margin-top:14px"><button class="btn pri" id="imOk">Importar agora</button></div>
        <div id="imProg" class="prog" hidden><i></i></div>
        <div id="imRes" style="margin-top:16px"></div>
      </div>
    </div>

    <div class="panel">
      <div class="ph"><b>Última importação</b></div>
      <div class="pb" style="color:var(--dim);font-size:13px">
        ${cfg.db.last_import ? fmtHora(Number(cfg.db.last_import)) : 'nenhuma importação registrada'}
        ${cfg.db.last_import_source ? `<div style="color:var(--dim2);font-size:12px;margin-top:4px">origem: ${esc(cfg.db.last_import_source)}</div>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="ph"><b>Exportar a lista do painel</b></div>
      <div class="pb">
        <div class="grid3">
          <div class="field"><label>Conteúdo</label>
            <select class="inp" id="exTipo">
              <option value="all">tudo (canais, filmes e séries)</option>
              <option value="live">só canais ao vivo</option>
              <option value="movie">só filmes</option>
              <option value="series">só séries (episódios)</option>
            </select></div>
          <div class="field"><label>Formato</label>
            <select class="inp" id="exFormato">
              <option value="m3u">M3U — reimportar em outro painel ou abrir no player</option>
              <option value="csv">CSV — conferir numa planilha</option>
            </select></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn pri" id="exOk" style="width:100%">Exportar</button></div>
        </div>
        <label class="chk"><input type="checkbox" id="exAtivos" checked>
          somente itens ativos (o que o cliente vê hoje)</label>
        <div class="help" id="exResumo">calculando...</div>
        <div class="help">Sai com os nomes e as categorias como você organizou aqui, apontando para as
          <b>URLs de origem</b> — serve de backup e para levar a lista para outro painel. Para entregar a um
          cliente use o link dele em <b>Clientes</b>, que é gerado pelo painel.</div>
      </div>
    </div>`;

  // ---- anexo: clique, arraste e remover ----
  const inp = $('#imFile');
  const drop = $('#imDrop');

  const mostrarAnexo = () => {
    const f = inp.files[0];
    drop.classList.toggle('has', !!f);
    $('#imFileInfo').innerHTML = f
      ? `<b style="color:var(--txt)">${esc(f.name)}</b> · ${fmtTamanho(f.size)}
         <button class="btn sm" id="imLimpar" style="margin-left:8px">remover</button>`
      : 'nenhum arquivo selecionado';
    if ($('#imLimpar')) $('#imLimpar').onclick = (e) => { e.preventDefault(); inp.value = ''; mostrarAnexo(); };
  };

  inp.onchange = () => {
    const f = inp.files[0];
    if (f && f.size > maxMb * 1024 * 1024) {
      toast(`arquivo maior que o limite de ${maxMb} MB`, 'err');
      inp.value = '';
    }
    mostrarAnexo();
  };

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files?.length) { inp.files = e.dataTransfer.files; inp.onchange(); }
  });

  // ---- importar ----
  $('#imOk').onclick = async () => {
    const btn = $('#imOk');
    const arquivo = inp.files[0];
    const texto = $('#imTexto').value.trim();
    const url = $('#imUrl').value.trim();
    if (!arquivo && !texto && !url) return toast('anexe um arquivo, informe uma URL ou cole o conteúdo', 'err');

    const barra = $('#imProg');
    barra.hidden = true; $('#imRes').innerHTML = '';
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> importando...';
    const params = { reset: $('#imReset').checked, prune: $('#imPrune').checked };

    try {
      let r;
      if (arquivo) {
        barra.hidden = false;
        r = await enviarArquivo('/import/upload', arquivo, { ...params, name: arquivo.name }, (pct) => {
          $('#imProg i').style.width = `${Math.round(pct * 100)}%`;
          if (pct >= 1) btn.innerHTML = '<span class="spin"></span> processando no servidor...';
        });
      } else {
        const body = { ...params };
        if (texto) body.content = $('#imTexto').value; else body.url = url;
        r = await api('/import', { method: 'POST', body: JSON.stringify(body) });
      }
      $('#imRes').innerHTML = `<div class="cards" style="margin:0">
        <div class="stat pri"><div class="n">${r.total}</div><div class="l">entradas lidas</div></div>
        <div class="stat"><div class="n">${r.live}</div><div class="l">canais</div></div>
        <div class="stat"><div class="n">${r.movie}</div><div class="l">filmes</div></div>
        <div class="stat"><div class="n">${r.series}</div><div class="l">episódios</div></div>
        <div class="stat ok"><div class="n">${r.inserted}</div><div class="l">novos</div></div>
        <div class="stat warn"><div class="n">${r.updated}</div><div class="l">atualizados</div></div>
      </div>`;
      toast('importação concluída', 'ok');
      S.cache.categorias = null;
    } catch (e) {
      $('#imRes').innerHTML = `<div style="color:var(--err)">${esc(e.message)}</div>`;
    }
    barra.hidden = true; $('#imProg i').style.width = '0';
    btn.disabled = false; btn.textContent = 'Importar agora';
  };

  // ---- exportar ----
  const paramsExport = () => new URLSearchParams({
    type: $('#exTipo').value, only_enabled: $('#exAtivos').checked ? 1 : 0,
  });
  const mostrarResumo = async () => {
    const alvo = $('#exResumo');
    try {
      const r = await api(`/export/resumo?${paramsExport()}`);
      const partes = [];
      if (r.live) partes.push(`${fmtNum(r.live)} canais`);
      if (r.movie) partes.push(`${fmtNum(r.movie)} filmes`);
      if (r.series) partes.push(`${fmtNum(r.series)} episódios`);
      alvo.textContent = r.total
        ? `${fmtNum(r.total)} item(ns) neste filtro — ${partes.join(', ')}`
        : 'nada para exportar com esse filtro';
    } catch (e) { alvo.textContent = e.message; }
  };
  $('#exTipo').onchange = mostrarResumo;
  $('#exAtivos').onchange = mostrarResumo;
  mostrarResumo();

  $('#exOk').onclick = async () => {
    const btn = $('#exOk');
    const formato = $('#exFormato').value;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> gerando...';
    try {
      const r = await fetch(`/api/export/${formato}?${paramsExport()}`,
        { headers: { authorization: `Bearer ${S.token}` } });
      if (r.status === 401) { sair(); throw new Error('sessao expirada'); }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `erro ${r.status}`);
      const nome = (r.headers.get('content-disposition') || '').match(/filename="(.+?)"/)?.[1]
        || `lista.${formato}`;
      const blob = await r.blob();
      const link = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = link; a.download = nome;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(link), 10000);
      toast(`${nome} (${fmtTamanho(blob.size)})`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Exportar';
  };
};

// ---------------- config ----------------
PAGES.config = async () => {
  const cfg = await api('/settings');
  const exemplo = `${cfg.publicUrl}/get.php?username=CLIENTE&password=SENHA&type=m3u_plus&output=ts`;
  $('#view').innerHTML = `
    <div class="head"><div><h2>Configurações</h2><div class="sub">valores definidos no arquivo .env</div></div></div>

    <div class="panel">
      <div class="ph"><b>Servidor</b></div>
      <div class="pb">
        ${blocoUrl('URL pública (o que vai no player do cliente)', cfg.publicUrl)}
        ${blocoUrl('Modelo de link M3U gerado', exemplo)}
        <div class="grid3" style="margin-top:14px">
          <div class="stat"><div class="n" style="font-size:16px">${esc(cfg.streamMode)}</div><div class="l">modo de entrega</div></div>
          <div class="stat"><div class="n" style="font-size:16px">${cfg.port}</div><div class="l">porta</div></div>
          <div class="stat"><div class="n" style="font-size:16px">${cfg.trialHours}h</div><div class="l">duração padrão do teste</div></div>
        </div>
        <div class="help" style="margin-top:14px">
          Para mudar, edite o arquivo <b>.env</b> na pasta do projeto e reinicie o painel:<br>
          <span class="mono">PUBLIC_URL</span> — domínio/IP que os clientes acessam (precisa ser acessível de fora).<br>
          <span class="mono">STREAM_MODE</span> — <b>redirect</b> (não gasta banda) ou <b>proxy</b> (esconde a fonte).<br>
          <span class="mono">PORT</span> — porta do servidor.
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="ph"><b>Como o cliente usa</b></div>
      <div class="pb help" style="font-size:13px;line-height:1.9">
        <b style="color:var(--txt)">IPTV Smarters / XCIPTV / TiviMate</b> → opção “Xtream Codes API”:
        servidor <span class="mono">${esc(cfg.publicUrl)}</span>, usuário e senha do cliente.<br>
        <b style="color:var(--txt)">Smart IPTV / SS IPTV / VLC</b> → cole a URL da lista M3U.<br>
        <b style="color:var(--txt)">Guia de programação</b> → cole a URL do EPG (xmltv.php).<br>
        Cada cliente tem link próprio: bloqueou/venceu o cadastro, o link para de funcionar na hora.
      </div>
    </div>`;
};

// ---------------- expõe ----------------
const app = {
  ir, sair, trocarSenha, fecharModal, copiar, confirmar,
  novoCliente, novoTeste, verCliente, editarCliente, renovar, derrubar, excluirCliente, pagLinhas,
  matarConexao, novoRevendedor, editarRevendedor, darCreditos, excluirRevendedor,
  novoPlano, editarPlano, excluirPlano, novoPacote, editarPacote, excluirPacote, marcarTodas,
  abaConteudo, pagConteudo, alternarConteudo, testarFonte, editarConteudo, excluirConteudo, novoCanal,
  limparSelecao, moverSelecionados,
  abaCategoria, verConteudoCategoria, novaCategoria, editarCategoria, moverCategoria, excluirCategoria,
};
window.app = app;

// ---------------- boot ----------------
if (S.token) iniciar().catch(() => sair());
else $('#login').style.display = 'flex';

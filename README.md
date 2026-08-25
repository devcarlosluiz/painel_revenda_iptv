# CLM IPTV — Painel de revenda

Painel completo para revender IPTV a partir de uma lista M3U. Cada cliente recebe **usuário, senha e
link próprio** para colar no player. Compatível com a **API Xtream Codes**, que é o padrão aceito por
IPTV Smarters, TiviMate, XCIPTV, Smart IPTV, VLC e afins.

```
lista.m3u  ->  importador  ->  banco  ->  painel web  ->  link individual por cliente  ->  player
```

---

## 1. Subir em 3 comandos

```bash
npm install          # instala as dependências (só o express)
npm run setup        # cria o .env, o admin e os pacotes/planos padrão
npm run import       # carrega a lista.m3u no banco
npm start            # sobe o painel
```

Abra **http://localhost:8080/painel/** e entre com o usuário/senha que o `setup` mostrou no terminal.
Para colocar no ar num servidor, veja [DEPLOY.md](DEPLOY.md).

> No Windows dá para usar o atalho: dê dois cliques em **`iniciar.bat`** — ele instala, configura e abre o painel.

Para criar o admin com senha escolhida por você:

```bash
node src/scripts/setup.js --user carlos --pass minhasenha
```

---

## 2. O que já vem pronto

Da sua `lista.m3u` foram reconhecidos automaticamente:

| Tipo | Quantidade | Como foi identificado |
|---|---|---|
| Canais ao vivo | 1.882 | URL `.ts` / `.m3u8` |
| Filmes | 15.684 | URL com `/movie/` ou extensão `.mp4`/`.mkv` |
| Séries (episódios) | 400 em 2 séries | nome no padrão `Nome S01 E02` ou URL com `/series/` |
| Categorias | 70 | `group-title` da lista |

Pacotes padrão criados: **Completo**, **Somente Canais**, **Canais + Filmes**.
Planos padrão: **Teste**, **Mensal (1 crédito)**, **Trimestral (3)**, **Semestral (6)**, **Anual (12)**.

---

## 3. O link que o cliente recebe

Ao criar um cliente o painel mostra a tela de acesso pronta para copiar ou mandar no WhatsApp:

**Lista M3U** (VLC, Smart IPTV, SS IPTV, qualquer player):
```
http://SEU-DOMINIO:8080/get.php?username=joao&password=1234&type=m3u_plus&output=ts
```

**Xtream Codes API** (IPTV Smarters, TiviMate, XCIPTV) — no app escolha "Login com usuário e senha":
```
Servidor: http://SEU-DOMINIO:8080
Usuário:  joao
Senha:    1234
```

**EPG / guia de programação**:
```
http://SEU-DOMINIO:8080/xmltv.php?username=joao&password=1234
```

O link é validado a cada requisição: venceu, foi desativado, estourou o limite de conexões ou o canal
está fora do pacote → o player para de funcionar na hora. Não existe link "solto" que continue valendo.

---

## 4. Recursos do painel

**Clientes**
- criar, editar, renovar (soma dias ao que ainda resta), desativar, banir e excluir
- usuário/senha gerados automaticamente ou definidos por você
- limite de conexões simultâneas por cliente (com bloqueio real)
- data de vencimento, travamento por IP, nome/WhatsApp/observação
- teste grátis com duração em horas, sem gastar crédito
- botão para derrubar as conexões ativas
- link direto para a tela de acesso: `#cliente/12`

**Revenda**
- revendedores com saldo em créditos e sub-revendas
- cada plano custa X créditos; criar/renovar debita automaticamente
- revendedor só enxerga os próprios clientes
- extrato completo de créditos (quem deu, quando, motivo)
- permissão de gerar testes por revendedor

**Pacotes e planos**
- pacote = conjunto de categorias; cliente sem pacote marcado vê tudo
- plano = duração + custo em créditos + conexões + pacotes padrão

**Conteúdo**
- lista de canais, filmes e séries com busca, filtro por categoria e paginação
- ocultar/ativar item, editar nome, categoria, logo, URL de origem e tvg-id
- tela **Categorias**: criar, renomear, reordenar, juntar (mover o conteúdo de uma para outra) e excluir
  — ao excluir uma categoria com conteúdo dentro, você escolhe entre mover os itens para outra
  categoria ou apagar tudo junto
- ao editar um item dá para trocar a categoria ou criar uma nova ali mesmo, sem sair da tela
- seleção em lote: marque vários itens (a marcação segue ao virar de página) e mande todos para outra
  categoria de uma vez — ou aplique a troca a **todos** os itens do filtro atual (busca + categoria)
- exportar a lista já organizada em M3U ou CSV (só admin), para backup ou para levar a outro painel
- botão **testar** que consulta a fonte na hora e mostra o tempo de resposta
- adicionar canal manualmente
- reimportar a lista sem quebrar nada: itens já existentes são atualizados pela URL de origem,
  os IDs não mudam e os clientes não perdem os favoritos

**Monitoramento**
- quem está assistindo agora (cliente, conteúdo, IP, player, início) com botão de derrubar
- log de acessos e bloqueios, com o motivo de cada recusa
- painel **Servidor** no dashboard (só admin, atualiza a cada 5s): CPU total e por núcleo, CPU e RAM
  do processo do painel, memória e disco da máquina, load average, uptime, Node e tamanho do banco

---

## 5. Configuração (arquivo `.env`)

```ini
PORT=8080
HOST=0.0.0.0                       # interface de escuta. 0.0.0.0 = aceita acesso externo
PUBLIC_URL=http://localhost:8080   # <- o endereço que o CLIENTE usa. Troque em produção!
JWT_SECRET=...                     # gerado pelo setup
STREAM_MODE=redirect               # redirect | proxy
TRIAL_HOURS=6                      # duração padrão do teste
CONNECTION_TTL=90                  # segundos sem sinal para liberar a conexão
DB_PATH=./data/panel.db
IMPORT_MAX_MB=200                  # tamanho máximo da lista anexada no painel
```

> **`PUBLIC_URL` é o item mais importante.** Ele é usado para montar os links dos clientes.
> Se ficar em `localhost`, só funciona na sua máquina. Coloque seu IP público ou domínio.
> No deploy da Oracle Cloud o [`deploy/install.sh`](deploy/install.sh) preenche esse valor
> sozinho, com o IP público que ele lê do metadata da instância.
>
> `HOST` controla onde o processo escuta. Deixe `0.0.0.0` para aceitar conexões de fora;
> use `127.0.0.1` apenas quando houver um Nginx na frente (ver HTTPS abaixo).

### redirect x proxy

| | `redirect` (padrão) | `proxy` |
|---|---|---|
| Banda do servidor | praticamente zero | 100% do vídeo passa por você |
| Fonte original | fica visível para quem inspecionar | escondida |
| Controle de conexão | aproximado (heartbeat) | exato |
| Playlists HLS | entregues direto | reescritas e assinadas pelo painel |

Dá para misturar: deixe `STREAM_MODE=redirect` no geral e, em **Conteúdo → editar canal → Entrega**,
marque `proxy` só nos canais que você quer proteger.

---

## 6. Reimportar, trocar e exportar a lista

Pelo painel: **Importar lista** — anexe o arquivo `.m3u` do seu computador (clicando ou arrastando
para a área de anexo), informe uma URL (`get.php` do seu fornecedor) ou cole o texto da lista.
Opções: apagar tudo antes, ou ocultar o que sumiu da lista nova. O limite do arquivo anexado é
`IMPORT_MAX_MB` (200 MB por padrão).

Pelo terminal:

```bash
npm run import                                    # usa ./lista.m3u
npm run import -- --file /caminho/outra.m3u
npm run import -- --url "http://fornecedor/get.php?username=..&password=..&type=m3u_plus"
npm run import -- --reset                         # apaga o conteúdo antigo antes
npm run import -- --prune                         # oculta o que não veio na lista nova
```

Para atualizar sozinho todo dia às 4h (Linux):

```cron
0 4 * * * cd /opt/iptv && /usr/bin/npm run import -- --url "SUA_URL" --prune >> /var/log/iptv-import.log 2>&1
```

### Exportar (somente admin)

Na mesma tela, em **Exportar a lista do painel**, escolha o conteúdo (tudo, canais, filmes ou séries),
se quer apenas os itens ativos e o formato:

- **M3U** — a lista com os nomes e categorias como você organizou, apontando para as **URLs de origem**.
  Serve de backup e reimporta em outro painel sem perder a organização (os episódios saem como
  `Serie S01 E02`, então voltam como série/temporada/episódio).
- **CSV** — `tipo;id;nome;categoria;status;url;logo;tvg_id` com BOM, para conferir numa planilha.

O arquivo do cliente continua sendo o link individual dele (**Clientes → links**), gerado pelo painel —
a exportação é a lista interna, com as fontes originais, e revendedor não tem acesso a ela.

---

## 7. Colocar em produção (VPS)

> **Oracle Cloud:** use o [DEPLOY.md](DEPLOY.md) — o [`deploy/install.sh`](deploy/install.sh)
> instala Node, código, serviço systemd e firewall num comando só, detectando o IP público
> da instância automaticamente. As instruções abaixo são o passo a passo manual equivalente.

Sem Docker:

```bash
git clone/copiar o projeto para /opt/iptv
cd /opt/iptv && npm install --omit=dev
npm run setup && npm run import
cp .env.example .env
# .env: HOST=0.0.0.0 e PUBLIC_URL=http://SEU-IP:8080
```

`/etc/systemd/system/iptv.service`:

```ini
[Unit]
Description=CLM IPTV Panel
After=network.target

[Service]
WorkingDirectory=/opt/iptv
ExecStart=/usr/bin/node src/server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now iptv
```

> A porta 8080 precisa estar liberada no firewall do sistema **e** na security list /
> network security group do provedor (Oracle Cloud, AWS etc.), senão o IP público não responde:
>
> ```bash
> sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT   # Oracle Linux/Ubuntu na OCI
> sudo netfilter-persistent save
> ```

Com Docker:

```bash
cp .env.example .env          # o compose lê PUBLIC_URL, JWT_SECRET e afins deste arquivo
docker compose up -d
docker compose exec painel node src/scripts/setup.js --user admin --pass suasenha
docker compose exec painel node src/scripts/import-m3u.js
```

### HTTPS (recomendado)

Nginx na frente, com o painel escutando só em localhost:

```nginx
server {
  listen 443 ssl;
  server_name tv.seudominio.com.br;
  # ssl_certificate ... (use certbot)

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # necessário para o IP real aparecer nos logs
    proxy_buffering off;                              # importante para vídeo
    proxy_read_timeout 3600s;
  }
}
```

Nesse cenário troque `HOST=127.0.0.1` e `PUBLIC_URL=https://tv.seudominio.com.br` no `.env`
e reinicie.

---

## 8. Endpoints

**Cliente (compatível Xtream Codes)**

| Rota | Para que serve |
|---|---|
| `GET /get.php?username=&password=&type=m3u_plus&output=ts` | playlist M3U do cliente (`output=m3u8` para HLS, `content=live\|vod\|series` para filtrar) |
| `GET/POST /player_api.php?username=&password=&action=` | API dos apps: `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg`, `get_simple_data_table` |
| `GET /xmltv.php?username=&password=` | EPG em XMLTV |
| `GET /live/{user}/{pass}/{id}.ts` | canal ao vivo |
| `GET /movie/{user}/{pass}/{id}.mp4` | filme |
| `GET /series/{user}/{pass}/{id}.mp4` | episódio |
| `GET /{user}/{pass}/{id}` | formato antigo (players legados) |

**Painel** — tudo sob `/api`, autenticado por token Bearer:
`/login`, `/me`, `/dashboard`, `/lines`, `/lines/:id/renew`, `/lines/:id/kill`, `/users`,
`/users/:id/credits`, `/credits`, `/bouquets`, `/plans`, `/categories`, `/content`,
`/content/:type/:id/test`, `/connections`, `/activity`, `/import`, `/import/upload`, `/settings`.

> Categorias: `GET /api/categories`, `POST /api/categories`, `PATCH /api/categories/:id`,
> `POST /api/categories/:id/move` (`{to}` = categoria de destino) e
> `DELETE /api/categories/:id` com `?move_to=id` (move o conteúdo antes) ou `?delete_content=1`
> (apaga o conteúdo junto; séries levam os episódios por cascade). Sem nenhum dos dois, categoria
> com conteúdo devolve 409 — é a trava contra apagar sem querer.
>
> Troca de categoria em lote: `POST /api/content/:type/category` com `{ids:[...]}` (itens marcados) ou
> `{all:true, filtro:{search, category_id}}` (todo o filtro), mais `category_id` (ou `category_name`
> para criar a categoria na hora; `category_id:null` tira a categoria).
>
> Exportação (só admin): `GET /api/export/m3u`, `GET /api/export/csv` e `GET /api/export/resumo`
> (contagem antes de baixar), todos aceitando `type=all|live|movie|series`, `only_enabled=1|0`,
> `category_id` e `search`.
>
> `GET /api/system` (só admin) devolve CPU (total, por núcleo e do processo), memória, disco,
> load average, uptime da máquina e do painel, versão do Node e tamanho do banco.

> `POST /api/import` recebe json com `url` ou `content`; `POST /api/import/upload` recebe o arquivo
> no corpo cru da requisição (`content-type: application/octet-stream`) e lê as opções da query
> string (`reset`, `prune`, `name`).

---

## 9. Estrutura do projeto

```
src/
  server.js              sobe o Express e junta as rotas
  config.js              lê o .env
  db.js / schema.sql     SQLite (node:sqlite, sem dependência nativa)
  lib/
    m3u.js               parser da lista + classificação canal/filme/série
    auth.js              hash de senha (scrypt) e token de sessão
    helpers.js           utilidades
  services/
    importer.js          importação com deduplicação por URL de origem
    system.js            CPU/memória/disco da máquina (amostragem para o dashboard)
    access.js            autenticação do cliente, pacotes, limite de conexões, logs
    lines.js             clientes, renovação, créditos, escopo de revenda
  routes/
    admin.js             API do painel
    xtream.js            get.php, player_api.php, xmltv.php
    stream.js            entrega do vídeo (redirect ou proxy + HLS assinado)
  public/                painel web (HTML/CSS/JS puro, sem build)
  scripts/
    setup.js             admin, pacotes e planos iniciais
    import-m3u.js        importação pela linha de comando
data/panel.db            banco (fica fora do git)
```

Banco: **SQLite** via `node:sqlite` (embutido no Node 22.5+). Sem compilar nada, sem serviço externo.
Para milhares de clientes simultâneos vale migrar para Postgres — o acesso a dados está isolado em `src/db.js`.

---

## 10. Pontos de atenção

- **Backup**: o banco é o arquivo `data/panel.db`. Copie ele (e os `-wal`/`-shm`) periodicamente.
- **Senha do admin**: troque no primeiro acesso (botão "Senha" no rodapé do menu).
- **`JWT_SECRET`**: se mudar, todo mundo é deslogado do painel e os links HLS assinados expiram.
- **Links dos clientes**: continuam válidos mesmo trocando o secret — eles usam usuário/senha, não token.
- **Fontes de terceiros**: os links da lista apontam para servidores que não são seus; se a fonte cair,
  o canal cai junto. Use o botão **testar** para achar os que morreram e o `--prune` para limpar.
- **Direitos de exibição**: você é responsável por ter autorização para redistribuir o que está na lista.

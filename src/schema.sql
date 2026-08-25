-- ============================================================
--  CLM IPTV PANEL - schema
-- ============================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- usuarios do painel (admin / revendedores) ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'reseller',   -- admin | reseller
  name          TEXT,
  email         TEXT,
  whatsapp      TEXT,
  credits       REAL    NOT NULL DEFAULT 0,
  parent_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        INTEGER NOT NULL DEFAULT 1,
  can_trial     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);

-- ---------- categorias ----------
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,          -- live | movie | series
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, type)
);

-- ---------- canais ao vivo ----------
CREATE TABLE IF NOT EXISTS streams (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  logo        TEXT,
  epg_id      TEXT,
  source_url  TEXT NOT NULL,
  container   TEXT NOT NULL DEFAULT 'ts',   -- ts | m3u8
  proxy_mode  INTEGER,                      -- NULL = usa padrao global
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streams_cat  ON streams(category_id);
CREATE INDEX IF NOT EXISTS idx_streams_name ON streams(name);

-- ---------- filmes ----------
CREATE TABLE IF NOT EXISTS movies (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  logo        TEXT,
  source_url  TEXT NOT NULL,
  container   TEXT NOT NULL DEFAULT 'mp4',
  year        TEXT,
  plot        TEXT,
  rating      REAL,
  duration    INTEGER,
  proxy_mode  INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movies_cat  ON movies(category_id);
CREATE INDEX IF NOT EXISTS idx_movies_name ON movies(name);

-- ---------- series ----------
CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  logo        TEXT,
  plot        TEXT,
  year        TEXT,
  rating      REAL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    INTEGER NOT NULL,
  UNIQUE(name, category_id)
);

CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY,
  series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL DEFAULT 1,
  episode     INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  logo        TEXT,
  source_url  TEXT NOT NULL,
  container   TEXT NOT NULL DEFAULT 'mp4',
  duration    INTEGER,
  proxy_mode  INTEGER,
  added_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ep_series ON episodes(series_id, season, episode);

-- ---------- pacotes (bouquets) ----------
CREATE TABLE IF NOT EXISTS bouquets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bouquet_categories (
  bouquet_id  INTEGER NOT NULL REFERENCES bouquets(id)   ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (bouquet_id, category_id)
);

-- ---------- planos ----------
CREATE TABLE IF NOT EXISTS plans (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  days            INTEGER NOT NULL DEFAULT 30,
  credits_cost    REAL    NOT NULL DEFAULT 1,
  max_connections INTEGER NOT NULL DEFAULT 1,
  is_trial        INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_bouquets (
  plan_id    INTEGER NOT NULL REFERENCES plans(id)    ON DELETE CASCADE,
  bouquet_id INTEGER NOT NULL REFERENCES bouquets(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, bouquet_id)
);

-- ---------- linhas (clientes finais) ----------
CREATE TABLE IF NOT EXISTS lines (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  max_connections INTEGER NOT NULL DEFAULT 1,
  exp_date        INTEGER,                        -- unix; NULL = sem vencimento
  status          TEXT NOT NULL DEFAULT 'active', -- active | disabled | banned
  is_trial        INTEGER NOT NULL DEFAULT 0,
  allowed_ips     TEXT,
  note            TEXT,
  customer_name   TEXT,
  whatsapp        TEXT,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER,
  last_ip         TEXT,
  last_ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_lines_owner ON lines(owner_id);
CREATE INDEX IF NOT EXISTS idx_lines_exp   ON lines(exp_date);

CREATE TABLE IF NOT EXISTS line_bouquets (
  line_id    INTEGER NOT NULL REFERENCES lines(id)    ON DELETE CASCADE,
  bouquet_id INTEGER NOT NULL REFERENCES bouquets(id) ON DELETE CASCADE,
  PRIMARY KEY (line_id, bouquet_id)
);

-- ---------- conexoes ativas ----------
CREATE TABLE IF NOT EXISTS connections (
  id          INTEGER PRIMARY KEY,
  line_id     INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- live | movie | series
  content_id  INTEGER,
  content_name TEXT,
  ip          TEXT,
  user_agent  TEXT,
  started_at  INTEGER NOT NULL,
  last_beat   INTEGER NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conn_line ON connections(line_id);
CREATE INDEX IF NOT EXISTS idx_conn_beat ON connections(last_beat);

-- ---------- log de atividade ----------
CREATE TABLE IF NOT EXISTS activity (
  id           INTEGER PRIMARY KEY,
  line_id      INTEGER,
  username     TEXT,
  kind         TEXT,          -- live | movie | series | login | denied
  content_id   INTEGER,
  content_name TEXT,
  ip           TEXT,
  user_agent   TEXT,
  detail       TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_at   ON activity(at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_line ON activity(line_id);

-- ---------- creditos ----------
CREATE TABLE IF NOT EXISTS credit_log (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount   REAL NOT NULL,
  balance  REAL NOT NULL,
  reason   TEXT,
  line_id  INTEGER,
  actor_id INTEGER,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_log(user_id, at DESC);

-- ---------- EPG ----------
CREATE TABLE IF NOT EXISTS epg_programmes (
  id          INTEGER PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  start_ts    INTEGER NOT NULL,
  stop_ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epg_ch ON epg_programmes(channel_id, start_ts);

-- ---------- configuracoes ----------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

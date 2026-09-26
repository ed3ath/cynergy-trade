-- Migration 001: Core schema (SQLite port)
-- Autonomous Crypto Trading System
-- All timestamps are UTC ISO-8601 TEXT (…Z, fixed width = Date.toISOString,
-- so lexicographic order/comparison matches chronological order).
-- Dialect notes vs infra/migrations/001:
--   * enum types → plain TEXT (chain has no CHECK: TRADING_CHAIN grows via
--     infra/migrations-sqlite/004/007/010 no-ops + chains.ts, and SQLite
--     cannot ALTER a CHECK; zod validates at the app boundary)
--   * BIGSERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
--   * NUMERIC(p,s) keeps its declaration (NUMERIC affinity) except big-integer
--     quantities (size_tokens, actual_input/output, amounts) → TEXT so values
--     beyond int64/2^53 round-trip as exact digit strings
--   * BOOLEAN → INTEGER 0/1, JSONB → TEXT, TEXT[] → JSON TEXT, NOW() →
--     strftime('%Y-%m-%dT%H:%M:%fZ','now')

-- ─── Tokens ───────────────────────────────────────────────────────────────────
CREATE TABLE tokens (
  address           TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  status            TEXT        NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at     TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_updated_at   TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  discovery_source  TEXT        NOT NULL,
  discovery_pool    TEXT,
  name              TEXT,
  symbol            TEXT,
  decimals          INTEGER,
  total_supply      TEXT,
  creator_address   TEXT,
  metadata_uri      TEXT,
  is_blacklisted    INTEGER     NOT NULL DEFAULT 0,
  blacklist_reason  TEXT,
  PRIMARY KEY (address, chain)
);
CREATE INDEX tokens_status_idx      ON tokens(status);
CREATE INDEX tokens_first_seen_idx  ON tokens(first_seen_at DESC);
CREATE INDEX tokens_creator_idx     ON tokens(creator_address);

-- ─── Token snapshots (time-series) ───────────────────────────────────────────
CREATE TABLE token_market_snapshots (
  id                INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address     TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  price_usd         NUMERIC(30,18) NOT NULL,
  market_cap_usd    NUMERIC(20,2),
  volume_usd_1m     NUMERIC(20,2),
  volume_usd_5m     NUMERIC(20,2),
  volume_usd_15m    NUMERIC(20,2),
  volume_usd_1h     NUMERIC(20,2),
  volume_usd_24h    NUMERIC(20,2),
  price_change_1m   NUMERIC(10,4),
  price_change_5m   NUMERIC(10,4),
  price_change_15m  NUMERIC(10,4),
  price_change_1h   NUMERIC(10,4),
  price_change_24h  NUMERIC(10,4),
  buy_count_1m      INTEGER,
  sell_count_1m     INTEGER,
  buy_volume_usd_1m NUMERIC(20,2),
  sell_volume_usd_1m NUMERIC(20,2),
  unique_buyers_1m  INTEGER,
  unique_sellers_1m INTEGER,
  trade_count_24h   INTEGER,
  provider          TEXT        NOT NULL,
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  observed_at       TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tms_token_time_idx ON token_market_snapshots(token_address, observed_at DESC);

-- ─── Liquidity snapshots ──────────────────────────────────────────────────────
CREATE TABLE liquidity_snapshots (
  id                    INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address         TEXT        NOT NULL,
  chain                 TEXT        NOT NULL DEFAULT 'solana',
  pool_address          TEXT        NOT NULL,
  dex                   TEXT        NOT NULL,
  liquidity_usd         NUMERIC(20,2) NOT NULL,
  liquidity_base        NUMERIC(30,10),
  liquidity_quote       NUMERIC(30,10),
  pool_age_ms           BIGINT,
  slippage_bps_50       NUMERIC(10,2),
  slippage_bps_500      NUMERIC(10,2),
  slippage_bps_5000     NUMERIC(10,2),
  liquidity_change_5m   NUMERIC(10,4),
  liquidity_change_15m  NUMERIC(10,4),
  provider              TEXT        NOT NULL,
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  observed_at           TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ls_token_time_idx ON liquidity_snapshots(token_address, observed_at DESC);
CREATE INDEX ls_pool_idx       ON liquidity_snapshots(pool_address);

-- ─── Holder snapshots ─────────────────────────────────────────────────────────
CREATE TABLE holder_snapshots (
  id                    INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address         TEXT        NOT NULL,
  chain                 TEXT        NOT NULL DEFAULT 'solana',
  total_holders         INTEGER,
  top1_pct              NUMERIC(6,2),
  top5_pct              NUMERIC(6,2),
  top10_pct             NUMERIC(6,2),
  top20_pct             NUMERIC(6,2),
  creator_pct           NUMERIC(6,2),
  insider_pct           NUMERIC(6,2),
  sniper_pct            NUMERIC(6,2),
  bundler_pct           NUMERIC(6,2),
  whale_pct             NUMERIC(6,2),
  holder_growth_5m      NUMERIC(8,4),
  holder_growth_15m     NUMERIC(8,4),
  holder_growth_1h      NUMERIC(8,4),
  concentration_chg_5m  NUMERIC(8,4),
  concentration_chg_15m NUMERIC(8,4),
  provider              TEXT        NOT NULL,
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  observed_at           TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX hs_token_time_idx ON holder_snapshots(token_address, observed_at DESC);

-- ─── Security assessments ─────────────────────────────────────────────────────
CREATE TABLE security_assessments (
  id              INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address   TEXT        NOT NULL,
  chain           TEXT        NOT NULL DEFAULT 'solana',
  status          TEXT        NOT NULL,
  score           NUMERIC(5,2) NOT NULL,
  reasons         TEXT        NOT NULL DEFAULT '[]',
  provider_results TEXT       NOT NULL DEFAULT '[]',
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  checked_at      TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  data_timestamp  TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sa_token_time_idx ON security_assessments(token_address, checked_at DESC);

-- ─── Wallet profiles ──────────────────────────────────────────────────────────
CREATE TABLE wallet_profiles (
  address         TEXT        PRIMARY KEY,
  chain           TEXT        NOT NULL DEFAULT 'solana',
  first_seen_at   TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  known_labels    TEXT        NOT NULL DEFAULT '[]',
  win_rate        NUMERIC(5,4),
  total_pnl_usd   NUMERIC(20,2),
  trade_count     INTEGER     NOT NULL DEFAULT 0,
  is_blocked      INTEGER     NOT NULL DEFAULT 0,
  block_reason    TEXT,
  metadata        TEXT        NOT NULL DEFAULT '{}'
);

-- ─── Strategies ───────────────────────────────────────────────────────────────
CREATE TABLE strategies (
  id          TEXT        PRIMARY KEY,
  version     TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  is_enabled  INTEGER     NOT NULL DEFAULT 0,
  is_champion INTEGER     NOT NULL DEFAULT 0,
  parameters  TEXT        NOT NULL DEFAULT '{}',
  created_at  TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, version)
);

-- ─── Strategy decisions ───────────────────────────────────────────────────────
CREATE TABLE strategy_decisions (
  id                INTEGER     PRIMARY KEY AUTOINCREMENT,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  token_address     TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  decision          TEXT        NOT NULL,
  confidence        NUMERIC(4,3),
  reasons           TEXT        NOT NULL DEFAULT '[]',
  risks             TEXT        NOT NULL DEFAULT '[]',
  invalidation_conds TEXT       NOT NULL DEFAULT '[]',
  suggested_entry   NUMERIC(30,18),
  suggested_stop    NUMERIC(30,18),
  suggested_tp1     NUMERIC(30,18),
  suggested_tp2     NUMERIC(30,18),
  feature_snapshot  TEXT        NOT NULL DEFAULT '{}',
  evaluated_at      TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sd_strategy_idx      ON strategy_decisions(strategy_id, evaluated_at DESC);
CREATE INDEX sd_token_idx         ON strategy_decisions(token_address, evaluated_at DESC);

-- ─── AI assessments ───────────────────────────────────────────────────────────
CREATE TABLE ai_assessments (
  id                INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address     TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  decision          TEXT        NOT NULL,
  confidence        NUMERIC(4,3),
  setup_type        TEXT,
  reasons           TEXT        NOT NULL DEFAULT '[]',
  risks             TEXT        NOT NULL DEFAULT '[]',
  invalidation_conds TEXT       NOT NULL DEFAULT '[]',
  rank_score        NUMERIC(8,4),
  model_id          TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd          NUMERIC(10,6),
  assessed_at       TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX aa_token_idx ON ai_assessments(token_address, assessed_at DESC);

-- ─── Trade intents ────────────────────────────────────────────────────────────
CREATE TABLE trade_intents (
  id                TEXT        PRIMARY KEY,
  token_address     TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  side              TEXT        NOT NULL,
  mode              TEXT        NOT NULL,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  risk_version      TEXT        NOT NULL,
  position_size_usd NUMERIC(20,2) NOT NULL,
  max_slippage_bps  INTEGER     NOT NULL,
  max_price_impact_bps INTEGER  NOT NULL,
  reason            TEXT        NOT NULL,
  ai_assessment_id  INTEGER     REFERENCES ai_assessments(id),
  created_at        TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at        TEXT        NOT NULL
);
CREATE INDEX ti_token_idx   ON trade_intents(token_address, created_at DESC);
CREATE INDEX ti_mode_idx    ON trade_intents(mode, created_at DESC);

-- ─── Risk decisions ───────────────────────────────────────────────────────────
CREATE TABLE risk_decisions (
  id                      INTEGER     PRIMARY KEY AUTOINCREMENT,
  trade_intent_id         TEXT        NOT NULL REFERENCES trade_intents(id),
  decision                TEXT        NOT NULL,
  rejection_reasons       TEXT        NOT NULL DEFAULT '[]',
  approved_size_usd       NUMERIC(20,2),
  approved_risk_fraction  NUMERIC(8,6),
  max_slippage_bps        INTEGER,
  risk_version            TEXT        NOT NULL,
  decided_at              TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                TEXT        PRIMARY KEY,
  trade_intent_id   TEXT        NOT NULL REFERENCES trade_intents(id),
  token_address     TEXT        NOT NULL,
  chain             TEXT        NOT NULL DEFAULT 'solana',
  side              TEXT        NOT NULL,
  mode              TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'CREATED',
  quote_provider    TEXT,
  input_mint        TEXT,
  output_mint       TEXT,
  input_amount      TEXT,
  output_amount     TEXT,
  expected_price    NUMERIC(30,18),
  expected_slippage_bps INTEGER,
  tx_signature      TEXT,
  actual_input      TEXT,
  actual_output     TEXT,
  actual_price      NUMERIC(30,18),
  actual_slippage_bps INTEGER,
  fee_lamports      TEXT,
  fee_usd           NUMERIC(10,6),
  error_message     TEXT,
  raw_quote         TEXT,
  created_at        TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_at      TEXT,
  confirmed_at      TEXT,
  updated_at        TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX orders_intent_idx  ON orders(trade_intent_id);
CREATE INDEX orders_token_idx   ON orders(token_address, created_at DESC);
CREATE INDEX orders_sig_idx     ON orders(tx_signature) WHERE tx_signature IS NOT NULL;

-- ─── Positions ────────────────────────────────────────────────────────────────
CREATE TABLE positions (
  id                    TEXT        PRIMARY KEY,
  token_address         TEXT        NOT NULL,
  chain                 TEXT        NOT NULL DEFAULT 'solana',
  status                TEXT        NOT NULL DEFAULT 'OPENING',
  mode                  TEXT        NOT NULL,
  strategy_id           TEXT        NOT NULL,
  strategy_version      TEXT        NOT NULL,
  entry_order_id        TEXT        REFERENCES orders(id),
  entry_price           NUMERIC(30,18) NOT NULL,
  current_price         NUMERIC(30,18),
  size_usd              NUMERIC(20,2) NOT NULL,
  size_tokens           TEXT,
  stop_loss             NUMERIC(30,18) NOT NULL,
  take_profit_1         NUMERIC(30,18),
  take_profit_2         NUMERIC(30,18),
  trailing_stop_pct     NUMERIC(6,4),
  peak_price            NUMERIC(30,18),
  realized_pnl_usd      NUMERIC(20,2) NOT NULL DEFAULT 0,
  unrealized_pnl_usd    NUMERIC(20,2),
  unrealized_pnl_pct    NUMERIC(10,4),
  drawdown_from_peak_pct NUMERIC(10,4),
  exit_reason           TEXT,
  opened_at             TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at             TEXT,
  updated_at            TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pos_token_idx    ON positions(token_address);
CREATE INDEX pos_status_idx   ON positions(status) WHERE status NOT IN ('CLOSED','ERROR');
CREATE INDEX pos_mode_idx     ON positions(mode, opened_at DESC);

-- ─── Position events ──────────────────────────────────────────────────────────
CREATE TABLE position_events (
  id            INTEGER     PRIMARY KEY AUTOINCREMENT,
  position_id   TEXT        NOT NULL REFERENCES positions(id),
  event_type    TEXT        NOT NULL,
  price         NUMERIC(30,18),
  pnl_usd       NUMERIC(20,2),
  details       TEXT        NOT NULL DEFAULT '{}',
  occurred_at   TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pe_position_idx ON position_events(position_id, occurred_at DESC);

-- ─── Portfolio snapshots ──────────────────────────────────────────────────────
CREATE TABLE portfolio_snapshots (
  id                  INTEGER     PRIMARY KEY AUTOINCREMENT,
  mode                TEXT        NOT NULL,
  total_value_usd     NUMERIC(20,2) NOT NULL,
  available_usd       NUMERIC(20,2) NOT NULL,
  allocated_usd       NUMERIC(20,2) NOT NULL,
  open_positions      INTEGER     NOT NULL,
  daily_pnl_usd       NUMERIC(20,2),
  weekly_pnl_usd      NUMERIC(20,2),
  monthly_pnl_usd     NUMERIC(20,2),
  all_time_pnl_usd    NUMERIC(20,2),
  drawdown_pct        NUMERIC(8,4),
  peak_value_usd      NUMERIC(20,2),
  snapshot_at         TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ps_mode_time_idx ON portfolio_snapshots(mode, snapshot_at DESC);

-- ─── Risk events ──────────────────────────────────────────────────────────────
CREATE TABLE risk_events (
  id          INTEGER     PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT        NOT NULL,
  severity    TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  metadata    TEXT        NOT NULL DEFAULT '{}',
  occurred_at TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── System events ────────────────────────────────────────────────────────────
CREATE TABLE system_events (
  id          TEXT        PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_type  TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  metadata    TEXT        NOT NULL DEFAULT '{}',
  occurred_at TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX se_type_idx ON system_events(event_type, occurred_at DESC);

-- ─── Provider events ──────────────────────────────────────────────────────────
CREATE TABLE provider_events (
  id            INTEGER     PRIMARY KEY AUTOINCREMENT,
  provider_name TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  latency_ms    INTEGER,
  error_message TEXT,
  metadata      TEXT        NOT NULL DEFAULT '{}',
  occurred_at   TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pev_provider_time_idx ON provider_events(provider_name, occurred_at DESC);

-- ─── Experiments ──────────────────────────────────────────────────────────────
CREATE TABLE experiments (
  id            TEXT        PRIMARY KEY,
  hypothesis    TEXT        NOT NULL,
  baseline      TEXT        NOT NULL,
  variables     TEXT        NOT NULL DEFAULT '{}',
  methodology   TEXT,
  dataset_desc  TEXT,
  metrics       TEXT        NOT NULL DEFAULT '[]',
  result        TEXT,
  confidence    NUMERIC(4,3),
  decision      TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  created_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT
);

-- ─── Backtests ────────────────────────────────────────────────────────────────
CREATE TABLE backtests (
  id                TEXT        PRIMARY KEY,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  start_date        TEXT        NOT NULL,
  end_date          TEXT        NOT NULL,
  initial_capital   NUMERIC(20,2) NOT NULL,
  final_capital     NUMERIC(20,2),
  total_trades      INTEGER,
  winning_trades    INTEGER,
  losing_trades     INTEGER,
  win_rate          NUMERIC(5,4),
  profit_factor     NUMERIC(8,4),
  expectancy_usd    NUMERIC(10,4),
  max_drawdown_pct  NUMERIC(8,4),
  sharpe_ratio      NUMERIC(8,4),
  parameters        TEXT        NOT NULL DEFAULT '{}',
  results           TEXT        NOT NULL DEFAULT '{}',
  created_at        TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── Kill switch state (single row, persisted) ────────────────────────────────
CREATE TABLE system_state (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  updated_at  TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO system_state (key, value) VALUES
  ('kill_switch', 'false'),
  ('stop_new_entries', 'false'),
  ('trading_mode', 'PAPER'),
  ('market_regime', 'UNKNOWN');

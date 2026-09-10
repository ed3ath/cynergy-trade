-- Migration 001: Core schema
-- Autonomous Crypto Trading System
-- All timestamps are UTC. All monetary values are USD unless stated.

BEGIN;

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Enum types ───────────────────────────────────────────────────────────────
CREATE TYPE chain_type AS ENUM ('solana');
CREATE TYPE token_lifecycle AS ENUM (
  'DISCOVERED','OBSERVING','SCREENING','ELIGIBLE','WATCHLIST',
  'TRADE_CANDIDATE','ENTERED','OPEN','EXITING','CLOSED','REJECTED','ARCHIVED'
);
CREATE TYPE order_status AS ENUM (
  'CREATED','VALIDATING','SIMULATING','SIGNED','SUBMITTED',
  'CONFIRMING','CONFIRMED','FAILED','UNKNOWN','CANCELLED'
);
CREATE TYPE position_status AS ENUM (
  'OPENING','OPEN','PARTIAL_EXIT','CLOSING','CLOSED','ERROR'
);
CREATE TYPE security_status AS ENUM ('SAFE','WARNING','REJECT','UNKNOWN');
CREATE TYPE trade_mode AS ENUM ('PAPER','SHADOW','LIVE');
CREATE TYPE trade_side AS ENUM ('BUY','SELL');
CREATE TYPE ai_decision AS ENUM ('TRADE','WATCH','REJECT');
CREATE TYPE market_regime AS ENUM (
  'BULL','BEAR','HIGH_VOLATILITY','LOW_VOLATILITY','RISK_OFF','UNKNOWN'
);
CREATE TYPE system_event_type AS ENUM (
  'STARTUP','SHUTDOWN','KILL_SWITCH_ACTIVATED','KILL_SWITCH_DEACTIVATED',
  'DAILY_LOSS_LIMIT_HIT','DRAWDOWN_LIMIT_HIT','PROVIDER_FAILURE',
  'PROVIDER_RECOVERED','EXECUTION_FAILURE','STRATEGY_DISABLED',
  'STRATEGY_ENABLED','MODE_CHANGED','RISK_LIMIT_CHANGED'
);

-- ─── Tokens ───────────────────────────────────────────────────────────────────
CREATE TABLE tokens (
  address           TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
  status            token_lifecycle NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  discovery_source  TEXT        NOT NULL,
  discovery_pool    TEXT,
  name              TEXT,
  symbol            TEXT,
  decimals          SMALLINT,
  total_supply      NUMERIC,
  creator_address   TEXT,
  metadata_uri      TEXT,
  is_blacklisted    BOOLEAN     NOT NULL DEFAULT FALSE,
  blacklist_reason  TEXT,
  PRIMARY KEY (address, chain)
);
CREATE INDEX tokens_status_idx      ON tokens(status);
CREATE INDEX tokens_first_seen_idx  ON tokens(first_seen_at DESC);
CREATE INDEX tokens_creator_idx     ON tokens(creator_address);

-- ─── Token snapshots (time-series) ───────────────────────────────────────────
CREATE TABLE token_market_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  token_address     TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
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
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tms_token_time_idx ON token_market_snapshots(token_address, observed_at DESC);

-- ─── Liquidity snapshots ──────────────────────────────────────────────────────
CREATE TABLE liquidity_snapshots (
  id                    BIGSERIAL   PRIMARY KEY,
  token_address         TEXT        NOT NULL,
  chain                 chain_type  NOT NULL DEFAULT 'solana',
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
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ls_token_time_idx ON liquidity_snapshots(token_address, observed_at DESC);
CREATE INDEX ls_pool_idx       ON liquidity_snapshots(pool_address);

-- ─── Holder snapshots ─────────────────────────────────────────────────────────
CREATE TABLE holder_snapshots (
  id                    BIGSERIAL   PRIMARY KEY,
  token_address         TEXT        NOT NULL,
  chain                 chain_type  NOT NULL DEFAULT 'solana',
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
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX hs_token_time_idx ON holder_snapshots(token_address, observed_at DESC);

-- ─── Security assessments ─────────────────────────────────────────────────────
CREATE TABLE security_assessments (
  id              BIGSERIAL     PRIMARY KEY,
  token_address   TEXT          NOT NULL,
  chain           chain_type    NOT NULL DEFAULT 'solana',
  status          security_status NOT NULL,
  score           NUMERIC(5,2)  NOT NULL,
  reasons         JSONB         NOT NULL DEFAULT '[]',
  provider_results JSONB        NOT NULL DEFAULT '[]',
  confidence      NUMERIC(4,3)  NOT NULL DEFAULT 1.0,
  checked_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  data_timestamp  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX sa_token_time_idx ON security_assessments(token_address, checked_at DESC);

-- ─── Wallet profiles ──────────────────────────────────────────────────────────
CREATE TABLE wallet_profiles (
  address         TEXT        PRIMARY KEY,
  chain           chain_type  NOT NULL DEFAULT 'solana',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  known_labels    TEXT[]      NOT NULL DEFAULT '{}',
  win_rate        NUMERIC(5,4),
  total_pnl_usd   NUMERIC(20,2),
  trade_count     INTEGER     NOT NULL DEFAULT 0,
  is_blocked      BOOLEAN     NOT NULL DEFAULT FALSE,
  block_reason    TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'
);

-- ─── Strategies ───────────────────────────────────────────────────────────────
CREATE TABLE strategies (
  id          TEXT        PRIMARY KEY,
  version     TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  is_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_champion BOOLEAN     NOT NULL DEFAULT FALSE,
  parameters  JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, version)
);

-- ─── Strategy decisions ───────────────────────────────────────────────────────
CREATE TABLE strategy_decisions (
  id                BIGSERIAL   PRIMARY KEY,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  token_address     TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
  decision          TEXT        NOT NULL,
  confidence        NUMERIC(4,3),
  reasons           JSONB       NOT NULL DEFAULT '[]',
  risks             JSONB       NOT NULL DEFAULT '[]',
  invalidation_conds JSONB      NOT NULL DEFAULT '[]',
  suggested_entry   NUMERIC(30,18),
  suggested_stop    NUMERIC(30,18),
  suggested_tp1     NUMERIC(30,18),
  suggested_tp2     NUMERIC(30,18),
  feature_snapshot  JSONB       NOT NULL DEFAULT '{}',
  evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sd_strategy_idx      ON strategy_decisions(strategy_id, evaluated_at DESC);
CREATE INDEX sd_token_idx         ON strategy_decisions(token_address, evaluated_at DESC);

-- ─── AI assessments ───────────────────────────────────────────────────────────
CREATE TABLE ai_assessments (
  id                BIGSERIAL   PRIMARY KEY,
  token_address     TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
  decision          ai_decision NOT NULL,
  confidence        NUMERIC(4,3),
  setup_type        TEXT,
  reasons           JSONB       NOT NULL DEFAULT '[]',
  risks             JSONB       NOT NULL DEFAULT '[]',
  invalidation_conds JSONB      NOT NULL DEFAULT '[]',
  rank_score        NUMERIC(8,4),
  model_id          TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd          NUMERIC(10,6),
  assessed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX aa_token_idx ON ai_assessments(token_address, assessed_at DESC);

-- ─── Trade intents ────────────────────────────────────────────────────────────
CREATE TABLE trade_intents (
  id                TEXT        PRIMARY KEY,
  token_address     TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
  side              trade_side  NOT NULL,
  mode              trade_mode  NOT NULL,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  risk_version      TEXT        NOT NULL,
  position_size_usd NUMERIC(20,2) NOT NULL,
  max_slippage_bps  INTEGER     NOT NULL,
  max_price_impact_bps INTEGER  NOT NULL,
  reason            TEXT        NOT NULL,
  ai_assessment_id  BIGINT      REFERENCES ai_assessments(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX ti_token_idx   ON trade_intents(token_address, created_at DESC);
CREATE INDEX ti_mode_idx    ON trade_intents(mode, created_at DESC);

-- ─── Risk decisions ───────────────────────────────────────────────────────────
CREATE TABLE risk_decisions (
  id                      BIGSERIAL   PRIMARY KEY,
  trade_intent_id         TEXT        NOT NULL REFERENCES trade_intents(id),
  decision                TEXT        NOT NULL,
  rejection_reasons       JSONB       NOT NULL DEFAULT '[]',
  approved_size_usd       NUMERIC(20,2),
  approved_risk_fraction  NUMERIC(8,6),
  max_slippage_bps        INTEGER,
  risk_version            TEXT        NOT NULL,
  decided_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                TEXT        PRIMARY KEY,
  trade_intent_id   TEXT        NOT NULL REFERENCES trade_intents(id),
  token_address     TEXT        NOT NULL,
  chain             chain_type  NOT NULL DEFAULT 'solana',
  side              trade_side  NOT NULL,
  mode              trade_mode  NOT NULL,
  status            order_status NOT NULL DEFAULT 'CREATED',
  quote_provider    TEXT,
  input_mint        TEXT,
  output_mint       TEXT,
  input_amount      NUMERIC(30,0),
  output_amount     NUMERIC(30,0),
  expected_price    NUMERIC(30,18),
  expected_slippage_bps INTEGER,
  tx_signature      TEXT,
  actual_input      NUMERIC(30,0),
  actual_output     NUMERIC(30,0),
  actual_price      NUMERIC(30,18),
  actual_slippage_bps INTEGER,
  fee_lamports      NUMERIC(20,0),
  fee_usd           NUMERIC(10,6),
  error_message     TEXT,
  raw_quote         JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at      TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX orders_intent_idx  ON orders(trade_intent_id);
CREATE INDEX orders_token_idx   ON orders(token_address, created_at DESC);
CREATE INDEX orders_sig_idx     ON orders(tx_signature) WHERE tx_signature IS NOT NULL;

-- ─── Positions ────────────────────────────────────────────────────────────────
CREATE TABLE positions (
  id                    TEXT        PRIMARY KEY,
  token_address         TEXT        NOT NULL,
  chain                 chain_type  NOT NULL DEFAULT 'solana',
  status                position_status NOT NULL DEFAULT 'OPENING',
  mode                  trade_mode  NOT NULL,
  strategy_id           TEXT        NOT NULL,
  strategy_version      TEXT        NOT NULL,
  entry_order_id        TEXT        REFERENCES orders(id),
  entry_price           NUMERIC(30,18) NOT NULL,
  current_price         NUMERIC(30,18),
  size_usd              NUMERIC(20,2) NOT NULL,
  size_tokens           NUMERIC(30,0),
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
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pos_token_idx    ON positions(token_address);
CREATE INDEX pos_status_idx   ON positions(status) WHERE status NOT IN ('CLOSED','ERROR');
CREATE INDEX pos_mode_idx     ON positions(mode, opened_at DESC);

-- ─── Position events ──────────────────────────────────────────────────────────
CREATE TABLE position_events (
  id            BIGSERIAL   PRIMARY KEY,
  position_id   TEXT        NOT NULL REFERENCES positions(id),
  event_type    TEXT        NOT NULL,
  price         NUMERIC(30,18),
  pnl_usd       NUMERIC(20,2),
  details       JSONB       NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pe_position_idx ON position_events(position_id, occurred_at DESC);

-- ─── Portfolio snapshots ──────────────────────────────────────────────────────
CREATE TABLE portfolio_snapshots (
  id                  BIGSERIAL   PRIMARY KEY,
  mode                trade_mode  NOT NULL,
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
  snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ps_mode_time_idx ON portfolio_snapshots(mode, snapshot_at DESC);

-- ─── Risk events ──────────────────────────────────────────────────────────────
CREATE TABLE risk_events (
  id          BIGSERIAL   PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  severity    TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── System events ────────────────────────────────────────────────────────────
CREATE TABLE system_events (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type  system_event_type NOT NULL,
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX se_type_idx ON system_events(event_type, occurred_at DESC);

-- ─── Provider events ──────────────────────────────────────────────────────────
CREATE TABLE provider_events (
  id            BIGSERIAL   PRIMARY KEY,
  provider_name TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  latency_ms    INTEGER,
  error_message TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pev_provider_time_idx ON provider_events(provider_name, occurred_at DESC);

-- ─── Experiments ──────────────────────────────────────────────────────────────
CREATE TABLE experiments (
  id            TEXT        PRIMARY KEY,
  hypothesis    TEXT        NOT NULL,
  baseline      TEXT        NOT NULL,
  variables     JSONB       NOT NULL DEFAULT '{}',
  methodology   TEXT,
  dataset_desc  TEXT,
  metrics       JSONB       NOT NULL DEFAULT '[]',
  result        JSONB,
  confidence    NUMERIC(4,3),
  decision      TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- ─── Backtests ────────────────────────────────────────────────────────────────
CREATE TABLE backtests (
  id                TEXT        PRIMARY KEY,
  strategy_id       TEXT        NOT NULL,
  strategy_version  TEXT        NOT NULL,
  start_date        TIMESTAMPTZ NOT NULL,
  end_date          TIMESTAMPTZ NOT NULL,
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
  parameters        JSONB       NOT NULL DEFAULT '{}',
  results           JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Kill switch state (single row, persisted) ────────────────────────────────
CREATE TABLE system_state (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO system_state (key, value) VALUES
  ('kill_switch', 'false'),
  ('stop_new_entries', 'false'),
  ('trading_mode', 'PAPER'),
  ('market_regime', 'UNKNOWN');

COMMIT;

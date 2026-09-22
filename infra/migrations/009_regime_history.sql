-- Migration 009: regime history (roadmap B3 prep)
-- classifyRegime runs every decision cycle but was never persisted, so the
-- backtester cannot condition trades on the regime at entry time. Record one
-- row per regime transition — B3 joins token trades against this by time.

BEGIN;

CREATE TABLE regime_history (
  id               BIGSERIAL     PRIMARY KEY,
  chain            chain_type    NOT NULL,
  regime           TEXT          NOT NULL,
  trend_pct_1h     NUMERIC(10,4) NOT NULL,
  volatility_pct   NUMERIC(10,4) NOT NULL,
  confidence       NUMERIC(4,3)  NOT NULL,
  reasons          TEXT[]        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX regime_history_chain_idx ON regime_history(chain, created_at DESC);

COMMIT;

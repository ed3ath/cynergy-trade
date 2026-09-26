-- Migration 009: regime history (roadmap B3 prep) (SQLite port)
-- classifyRegime runs every decision cycle but was never persisted, so the
-- backtester cannot condition trades on the regime at entry time. Record one
-- row per regime transition — B3 joins token trades against this by time.

CREATE TABLE regime_history (
  id               INTEGER     PRIMARY KEY AUTOINCREMENT,
  chain            TEXT        NOT NULL,
  regime           TEXT        NOT NULL,
  trend_pct_1h     NUMERIC(10,4) NOT NULL,
  volatility_pct   NUMERIC(10,4) NOT NULL,
  confidence       NUMERIC(4,3)  NOT NULL,
  reasons          TEXT        NOT NULL DEFAULT '[]',   -- string[] as JSON text
  created_at       TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX regime_history_chain_idx ON regime_history(chain, created_at DESC);

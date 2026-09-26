-- Migration 003: shadow decision tracking (spec §43, Phase 5 evidence) (SQLite port)
-- Records every ENTER signal's decision price, evaluates outcome after a
-- horizon. Measures signal quality independently of execution.

CREATE TABLE shadow_decisions (
  id                  INTEGER     PRIMARY KEY AUTOINCREMENT,
  token_address       TEXT        NOT NULL,
  strategy_id         TEXT        NOT NULL,
  decision            TEXT        NOT NULL,
  decision_price      NUMERIC(30,18) NOT NULL,
  confidence          NUMERIC(4,3),
  horizon_minutes     INTEGER     NOT NULL DEFAULT 15,
  outcome_price       NUMERIC(30,18),
  outcome_return_pct  NUMERIC(10,4),
  decided_at          TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  evaluated_at        TEXT
);
CREATE INDEX sd_due_idx ON shadow_decisions(evaluated_at, decided_at DESC)
  WHERE evaluated_at IS NULL;

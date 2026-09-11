-- Migration 003: shadow decision tracking (spec §43, Phase 5 evidence)
-- Records every ENTER signal's decision price, evaluates outcome after a
-- horizon. Measures signal quality independently of execution.

BEGIN;

CREATE TABLE shadow_decisions (
  id                  BIGSERIAL     PRIMARY KEY,
  token_address       TEXT          NOT NULL,
  strategy_id         TEXT          NOT NULL,
  decision            TEXT          NOT NULL,
  decision_price      NUMERIC(30,18) NOT NULL,
  confidence          NUMERIC(4,3),
  horizon_minutes     INTEGER       NOT NULL DEFAULT 15,
  outcome_price       NUMERIC(30,18),
  outcome_return_pct  NUMERIC(10,4),
  decided_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  evaluated_at        TIMESTAMPTZ
);
CREATE INDEX sd_due_idx ON shadow_decisions(evaluated_at, decided_at DESC)
  WHERE evaluated_at IS NULL;

COMMIT;

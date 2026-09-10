-- Migration 002: hard idempotency table
-- Separated from trade_intents (audit journal) — this is the dedup floor.

BEGIN;

CREATE TABLE executed_intents (
  id           TEXT        PRIMARY KEY,
  executed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

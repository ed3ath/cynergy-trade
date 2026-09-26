-- Migration 002: hard idempotency table (SQLite port)
-- Separated from trade_intents (audit journal) — this is the dedup floor.

CREATE TABLE executed_intents (
  id           TEXT        PRIMARY KEY,
  executed_at  TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

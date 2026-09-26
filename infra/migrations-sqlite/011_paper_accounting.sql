-- Versioned PAPER accounting. No historical values are recomputed or promoted.
-- SQLite port notes:
--   * one ADD COLUMN per ALTER TABLE (SQLite grammar)
--   * ALTER COLUMN … TYPE is a no-op (NUMERIC affinity has no scale anyway)
--   * ADD CONSTRAINT … CHECK is unsupported — the v2 accounting invariants
--     are enforced in JournalRepository.recordConfirmedPaperFill before any
--     write; ponytail: if cross-row integrity is ever needed, rebuild the
--     table with the CHECKs inline (SQLite 12-step ALTER TABLE procedure).

ALTER TABLE trade_intents ADD COLUMN paper_token_quantity TEXT;
ALTER TABLE trade_intents ADD COLUMN position_id TEXT;

ALTER TABLE positions ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 1 CHECK (accounting_version IN (1,2));
ALTER TABLE positions ADD COLUMN initial_size_usd NUMERIC(30,12);
ALTER TABLE positions ADD COLUMN initial_size_tokens TEXT;
ALTER TABLE positions ADD COLUMN entry_fee_usd NUMERIC(30,12);
ALTER TABLE positions ADD COLUMN remaining_entry_fee_usd NUMERIC(30,12);
ALTER TABLE positions ADD COLUMN realized_gross_pnl_usd NUMERIC(30,12);
ALTER TABLE positions ADD COLUMN total_fees_usd NUMERIC(30,12);
ALTER TABLE positions ADD COLUMN exit_order_id TEXT REFERENCES orders(id);
ALTER TABLE positions ADD COLUMN data_quality TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(data_quality) AND json_type(data_quality) = 'array');

ALTER TABLE orders ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 1 CHECK (accounting_version IN (1,2));
ALTER TABLE orders ADD COLUMN position_id TEXT REFERENCES positions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orders ADD COLUMN cash_delta_usd NUMERIC(30,12);
ALTER TABLE orders ADD COLUMN realized_pnl_delta_usd NUMERIC(30,12);
ALTER TABLE orders ADD COLUMN realized_gross_pnl_delta_usd NUMERIC(30,12);
ALTER TABLE orders ADD COLUMN sold_cost_basis_usd NUMERIC(30,12);
ALTER TABLE orders ADD COLUMN allocated_entry_fee_usd NUMERIC(30,12);
ALTER TABLE orders ADD COLUMN data_quality TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(data_quality) AND json_type(data_quality) = 'array');

-- Legacy duplicates remain untouched; only new ledger facts are unique.
CREATE UNIQUE INDEX orders_paper_accounting_intent_idx ON orders(trade_intent_id)
  WHERE mode = 'PAPER' AND cash_delta_usd IS NOT NULL;
CREATE INDEX orders_accounting_period_idx ON orders(mode, chain, accounting_version, confirmed_at)
  WHERE status = 'CONFIRMED' AND cash_delta_usd IS NOT NULL;
CREATE INDEX orders_accounting_position_idx ON orders(position_id) WHERE position_id IS NOT NULL;
CREATE INDEX positions_accounting_closed_idx ON positions(mode, chain, accounting_version, closed_at)
  WHERE status = 'CLOSED';

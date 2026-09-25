-- Versioned PAPER accounting. No historical values are recomputed or promoted.
BEGIN;

ALTER TABLE trade_intents
  ADD COLUMN paper_token_quantity NUMERIC(30,0),
  ADD COLUMN position_id TEXT,
  ALTER COLUMN position_size_usd TYPE NUMERIC(30,12);

ALTER TABLE positions
  ADD COLUMN accounting_version SMALLINT NOT NULL DEFAULT 1 CHECK (accounting_version IN (1,2)),
  ADD COLUMN initial_size_usd NUMERIC(30,12),
  ADD COLUMN initial_size_tokens NUMERIC(30,0),
  ADD COLUMN entry_fee_usd NUMERIC(30,12),
  ADD COLUMN remaining_entry_fee_usd NUMERIC(30,12),
  ADD COLUMN realized_gross_pnl_usd NUMERIC(30,12),
  ADD COLUMN total_fees_usd NUMERIC(30,12),
  ADD COLUMN exit_order_id TEXT REFERENCES orders(id),
  ADD COLUMN data_quality JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(data_quality) = 'array'),
  ALTER COLUMN size_usd TYPE NUMERIC(30,12),
  ALTER COLUMN realized_pnl_usd TYPE NUMERIC(30,12),
  ALTER COLUMN unrealized_pnl_usd TYPE NUMERIC(30,12);

ALTER TABLE positions ADD CONSTRAINT positions_v2_accounting CHECK (
  accounting_version <> 2 OR (
    mode = 'PAPER' AND entry_order_id IS NOT NULL
    AND initial_size_usd IS NOT NULL AND initial_size_usd > 0
    AND initial_size_tokens IS NOT NULL AND initial_size_tokens > 0
    AND size_usd >= 0 AND size_usd <= initial_size_usd
    AND size_tokens IS NOT NULL AND size_tokens >= 0 AND size_tokens <= initial_size_tokens
    AND entry_fee_usd IS NOT NULL AND entry_fee_usd >= 0
    AND remaining_entry_fee_usd IS NOT NULL AND remaining_entry_fee_usd >= 0 AND remaining_entry_fee_usd <= entry_fee_usd
    AND realized_gross_pnl_usd IS NOT NULL AND total_fees_usd IS NOT NULL AND total_fees_usd >= entry_fee_usd
    AND (status <> 'PARTIAL_EXIT' OR (exit_order_id IS NOT NULL AND take_profit_1 IS NULL))
    AND (status <> 'CLOSED' OR (size_tokens = 0 AND size_usd = 0 AND remaining_entry_fee_usd = 0
                              AND closed_at IS NOT NULL AND exit_order_id IS NOT NULL))
  )
);

ALTER TABLE orders
  ADD COLUMN accounting_version SMALLINT NOT NULL DEFAULT 1 CHECK (accounting_version IN (1,2)),
  ADD COLUMN position_id TEXT REFERENCES positions(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN cash_delta_usd NUMERIC(30,12),
  ADD COLUMN realized_pnl_delta_usd NUMERIC(30,12),
  ADD COLUMN realized_gross_pnl_delta_usd NUMERIC(30,12),
  ADD COLUMN sold_cost_basis_usd NUMERIC(30,12),
  ADD COLUMN allocated_entry_fee_usd NUMERIC(30,12),
  ADD COLUMN data_quality JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(data_quality) = 'array');

ALTER TABLE orders ADD CONSTRAINT orders_v2_accounting CHECK (
  accounting_version <> 2 OR (
    mode = 'PAPER' AND status = 'CONFIRMED' AND confirmed_at IS NOT NULL AND position_id IS NOT NULL
    AND actual_input IS NOT NULL AND actual_input > 0 AND actual_output IS NOT NULL AND actual_output > 0
    AND fee_usd IS NOT NULL AND fee_usd >= 0 AND cash_delta_usd IS NOT NULL
    AND realized_pnl_delta_usd IS NOT NULL AND realized_gross_pnl_delta_usd IS NOT NULL
    AND sold_cost_basis_usd IS NOT NULL AND sold_cost_basis_usd >= 0
    AND allocated_entry_fee_usd IS NOT NULL AND allocated_entry_fee_usd >= 0
  )
);

-- Legacy duplicates remain untouched; only new ledger facts are unique.
CREATE UNIQUE INDEX orders_paper_accounting_intent_idx ON orders(trade_intent_id)
  WHERE mode = 'PAPER' AND cash_delta_usd IS NOT NULL;
CREATE INDEX orders_accounting_period_idx ON orders(mode, chain, accounting_version, confirmed_at)
  WHERE status = 'CONFIRMED' AND cash_delta_usd IS NOT NULL;
CREATE INDEX orders_accounting_position_idx ON orders(position_id) WHERE position_id IS NOT NULL;
CREATE INDEX positions_accounting_closed_idx ON positions(mode, chain, accounting_version, closed_at)
  WHERE status = 'CLOSED';

-- Widening preserves legacy values and prevents cents-only loss of new facts.
ALTER TABLE position_events ALTER COLUMN pnl_usd TYPE NUMERIC(30,12);
ALTER TABLE portfolio_snapshots
  ALTER COLUMN total_value_usd TYPE NUMERIC(30,12),
  ALTER COLUMN available_usd TYPE NUMERIC(30,12),
  ALTER COLUMN allocated_usd TYPE NUMERIC(30,12),
  ALTER COLUMN daily_pnl_usd TYPE NUMERIC(30,12),
  ALTER COLUMN weekly_pnl_usd TYPE NUMERIC(30,12),
  ALTER COLUMN monthly_pnl_usd TYPE NUMERIC(30,12),
  ALTER COLUMN all_time_pnl_usd TYPE NUMERIC(30,12),
  ALTER COLUMN peak_value_usd TYPE NUMERIC(30,12);

COMMIT;

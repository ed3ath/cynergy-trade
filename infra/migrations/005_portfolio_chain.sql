-- Per-chain portfolio snapshots: a TON process must not restore Solana's
-- equity baseline or mix chains on the dashboard equity curve.
ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS chain chain_type NOT NULL DEFAULT 'solana';
DROP INDEX IF EXISTS ps_mode_time_idx;
CREATE INDEX ps_mode_chain_time_idx ON portfolio_snapshots(mode, chain, snapshot_at DESC);

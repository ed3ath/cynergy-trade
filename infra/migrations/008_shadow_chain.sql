-- Per-chain shadow decisions: with multiple chains trading simultaneously,
-- each chain's ShadowTracker must only fetch/evaluate its own rows (price
-- fetches are chain-specific). Pre-existing rows default to 'solana' —
-- single-chain-era rows can't be re-attributed; stats impact is cosmetic.
ALTER TABLE shadow_decisions
  ADD COLUMN IF NOT EXISTS chain chain_type NOT NULL DEFAULT 'solana';
DROP INDEX IF EXISTS sd_due_idx;
CREATE INDEX sd_due_chain_idx ON shadow_decisions(chain, evaluated_at, decided_at DESC);

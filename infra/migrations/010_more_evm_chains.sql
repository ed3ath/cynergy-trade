-- More EVM chains (2026-09-24): the GT/DexScreener/GoPlus adapter family is
-- fully parameterized, so a chain is one enum value + one chains.ts entry.
-- All are PAPER-only (boot-guarded in the trader — no EVM signing path).
-- ethereum included despite gas cost: paper trading pays no gas; revisit
-- before any EVM LIVE path exists.
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'ethereum';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'avalanche';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'optimism';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'linea';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'mantle';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'blast';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'zksync';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'scroll';

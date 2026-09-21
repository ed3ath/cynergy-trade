-- EVM chain support: cheap-gas chains (bsc, base, polygon, arbitrum) trade
-- simultaneously with solana/ton via TRADING_CHAIN comma lists.
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'bsc';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'polygon';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'base';
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'arbitrum';

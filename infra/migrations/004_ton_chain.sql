-- TON chain support: widen the chain enum (001 creates ENUM('solana') only;
-- without this every TON journal write fails on insert).
ALTER TYPE chain_type ADD VALUE IF NOT EXISTS 'ton';

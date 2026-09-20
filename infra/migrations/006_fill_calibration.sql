-- Migration 006: fill calibration (roadmap C2)
-- For every PAPER fill, fetch a real quote (STON.fi) for the same intent and
-- record both. The delta answers: how far are synthetic fills from reality?

BEGIN;

CREATE TABLE fill_calibration (
  id                      BIGSERIAL     PRIMARY KEY,
  token_address           TEXT          NOT NULL,
  chain                   chain_type    NOT NULL,
  side                    TEXT          NOT NULL,             -- BUY | SELL
  size_usd                NUMERIC(12,2) NOT NULL,
  paper_price             NUMERIC(30,18) NOT NULL,            -- synthetic executedPrice
  paper_slippage_bps      INTEGER       NOT NULL,
  quote_price             NUMERIC(30,18),                     -- real quote USD price (NULL = quote failed)
  quote_price_impact_bps  INTEGER,
  quote_slippage_bps      INTEGER,
  quote_error             TEXT,                               -- why the quote failed, if it did
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX fill_cal_token_idx ON fill_calibration(token_address, created_at DESC);

COMMIT;

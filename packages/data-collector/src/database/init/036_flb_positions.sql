-- packages/data-collector/src/database/init/036_flb_positions.sql
-- FLB paper-executor position store + capital sub-ledger columns.
-- See docs/superpowers/specs/2026-06-03-flb-paper-executor-design.md
-- Plain table (low volume), NOT a hypertable.

CREATE TABLE IF NOT EXISTS flb_positions (
  id                 BIGSERIAL PRIMARY KEY,
  market_id          TEXT NOT NULL UNIQUE,       -- enforces flb_0g (one position per market)
  market_type        TEXT NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_yes_price    NUMERIC(10,6) NOT NULL,
  entry_no_price     NUMERIC(10,6) NOT NULL,     -- mid NO = 1 - entry_yes_price
  executed_no_price  NUMERIC(10,6) NOT NULL,     -- price actually paid (mid + half-spread or book avg)
  no_size            NUMERIC(18,6) NOT NULL,     -- NO shares = no_stake / executed_no_price
  no_stake           NUMERIC(18,6) NOT NULL,     -- dollars committed (the locked capital)
  fee_paid           NUMERIC(18,6) NOT NULL DEFAULT 0,
  slippage_pct       NUMERIC(10,4),
  fill_source        TEXT,                       -- 'spread' | 'orderbook'
  entry_cost_pct     NUMERIC(10,4),              -- (spread/2)/no_mid, percent; checked by flb_0d
  ttr_hours_at_entry NUMERIC(10,2),
  end_date           TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'open',-- open | resolved | voided
  resolved_at        TIMESTAMPTZ,
  resolution_outcome TEXT,
  gross_pnl          NUMERIC(18,6),
  net_pnl            NUMERIC(18,6),
  hold_days          NUMERIC(10,3)
);

CREATE INDEX IF NOT EXISTS idx_flb_positions_status   ON flb_positions (status);
CREATE INDEX IF NOT EXISTS idx_flb_positions_end_date ON flb_positions (end_date);

ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_locked_capital NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_realized_pnl   NUMERIC(18,6) NOT NULL DEFAULT 0;

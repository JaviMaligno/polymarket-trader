-- Partial unique index: only one open position per (market_id, token_id)
-- This replaces the old UNIQUE(market_id, token_id) which allowed re-opens
-- to silently upsert (preserving stale realized_pnl from previous cycles).
-- With this index, INSERT will fail with 23505 if a duplicate open exists,
-- and closed positions (closed_at IS NOT NULL) are excluded.

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_position_per_token
  ON paper_positions (market_id, token_id)
  WHERE closed_at IS NULL;

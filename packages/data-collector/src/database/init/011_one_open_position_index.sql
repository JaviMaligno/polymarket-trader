-- Drop old unconditional UNIQUE constraint that prevents multiple rows per token.
-- The old constraint blocks the new one-row-per-lifecycle design where closed
-- positions stay as historical records and new opens create fresh rows.
ALTER TABLE paper_positions DROP CONSTRAINT IF EXISTS paper_positions_market_id_token_id_key;

-- Partial unique index: only one open position per (market_id, token_id)
-- Closed positions (closed_at IS NOT NULL) are excluded, allowing multiple
-- historical rows. INSERT will fail with 23505 if a duplicate open exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_position_per_token
  ON paper_positions (market_id, token_id)
  WHERE closed_at IS NULL;

-- Per-type scorer weights + new typeExpectedValue dimension.
-- Sentinel '__global__' marks the fallback row used when no per-type row exists
-- or when a per-type row has n_trades below MIN_TRADES.
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS type_expected_value FLOAT NOT NULL DEFAULT 0;

-- UNIQUE(market_type): one row per type + one '__global__' row.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_scorer_weights_market_type'
  ) THEN
    ALTER TABLE scorer_weights
      ADD CONSTRAINT uniq_scorer_weights_market_type UNIQUE (market_type);
  END IF;
END $do$;

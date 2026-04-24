-- Realized volatility storage on markets (Sub-project B.1).
-- raw stddev of first-differences of close prices over 24h + bar count quality signal.
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS realized_volatility_24h FLOAT,
  ADD COLUMN IF NOT EXISTS realized_volatility_bar_count SMALLINT;

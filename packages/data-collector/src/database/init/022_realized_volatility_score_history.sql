-- market_score_history gains score_realized_volatility column for snapshot persistence.
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_realized_volatility FLOAT;

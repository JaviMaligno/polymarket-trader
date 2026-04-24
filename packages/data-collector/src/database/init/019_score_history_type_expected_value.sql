-- T8: Add score_type_expected_value column to market_score_history.
-- Pass 2 now computes typeEV per tracked market via category_performance
-- and stores it alongside the other dimension scores.
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_type_expected_value FLOAT;

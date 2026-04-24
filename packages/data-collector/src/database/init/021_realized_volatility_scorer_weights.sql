-- scorer_weights gains realized_volatility column so ScorerWeightOptimizer
-- can persist the per-type weight for the new dim.
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS realized_volatility FLOAT NOT NULL DEFAULT 0;

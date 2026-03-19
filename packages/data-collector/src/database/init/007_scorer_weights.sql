-- Stores the current MarketScorer dimension weights (single-row table).
-- MarketScorer reads from here at each scoring run; fallback to code defaults.
CREATE TABLE IF NOT EXISTS scorer_weights (
  id             SERIAL PRIMARY KEY,
  tradeability   FLOAT NOT NULL DEFAULT 0.30,
  liquidity      FLOAT NOT NULL DEFAULT 0.25,
  volatility     FLOAT NOT NULL DEFAULT 0.20,
  ttr            FLOAT NOT NULL DEFAULT 0.15,
  data_quality   FLOAT NOT NULL DEFAULT 0.10,
  n_trades       INT,        -- trades used in last optimization
  n_trials       INT,        -- trials run in last optimization
  best_value     FLOAT,      -- best Pearson correlation achieved
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default row (only if table is empty)
INSERT INTO scorer_weights (tradeability, liquidity, volatility, ttr, data_quality)
SELECT 0.30, 0.25, 0.20, 0.15, 0.10
WHERE NOT EXISTS (SELECT 1 FROM scorer_weights);

-- 008_category_performance.sql
-- Stores per-category performance metrics and computed priors.
-- MarketPerformanceTracker writes here daily; MarketScorer reads priors at scoring time.
CREATE TABLE IF NOT EXISTS category_performance (
  market_type  VARCHAR(20) PRIMARY KEY,
  win_rate     FLOAT,
  avg_pnl      FLOAT,
  sharpe_ratio FLOAT,
  n_trades     INT NOT NULL DEFAULT 0,
  prior        FLOAT NOT NULL DEFAULT 1.0,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with default priors for the 4 known categories
INSERT INTO category_performance (market_type, prior) VALUES
  ('crypto_intraday', 1.0),
  ('crypto_daily', 1.0),
  ('event_short', 1.0),
  ('event_long', 1.0)
ON CONFLICT (market_type) DO NOTHING;

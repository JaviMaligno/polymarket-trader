-- 016_shadow_trades.sql
-- Records what the system would have traded for market types blocked by the execution gate.
-- AutoSignalExecutor inserts on rejection; MarketPerformanceTracker resolves when market closes.
CREATE TABLE IF NOT EXISTS shadow_trades (
  id SERIAL PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_id VARCHAR(255) NOT NULL,
  market_type VARCHAR(20) NOT NULL,
  direction VARCHAR(5) NOT NULL,
  entry_price FLOAT NOT NULL,
  theoretical_size FLOAT NOT NULL,
  signal_strength FLOAT NOT NULL,
  signal_confidence FLOAT NOT NULL,
  signal_type VARCHAR(100),
  resolved_at TIMESTAMPTZ,
  resolution_price FLOAT,
  theoretical_pnl FLOAT
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_market_type ON shadow_trades(market_type);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_time ON shadow_trades(time DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_unresolved ON shadow_trades(resolved_at) WHERE resolved_at IS NULL;

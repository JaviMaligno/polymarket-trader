-- Migration 010: Add realistic execution tracking columns
-- Supports OrderBookExecutionSimulator: tracks whether execution used
-- real order book data or estimated model, snapshot freshness, and liquidity.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS fill_source VARCHAR(20) DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS snapshot_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS available_depth DECIMAL(20,6);

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS fill_source VARCHAR(20) DEFAULT 'legacy';

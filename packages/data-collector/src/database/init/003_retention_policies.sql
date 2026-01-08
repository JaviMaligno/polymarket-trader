-- Polymarket Trading System - Retention Policies & Compression
-- Run after 001_schema.sql and 002_optimization_schema.sql
-- URGENT: Storage at >80% limit - need aggressive cleanup

-- ============================================
-- COMPRESSION SETTINGS (More Aggressive)
-- ============================================

-- Enable compression on all hypertables with shorter intervals
-- Price history: compress after 3 days (was 7)
ALTER TABLE price_history SET (
  timescaledb.compress_after = '3 days'
);

-- Orderbook snapshots: compress after 1 day (most voluminous)
ALTER TABLE orderbook_snapshots SET (
  timescaledb.compress_after = '1 day'
);

-- Trades: compress after 3 days
ALTER TABLE trades SET (
  timescaledb.compress_after = '3 days'
);

-- Paper equity history: compress after 7 days
ALTER TABLE paper_equity_history SET (
  timescaledb.compress_after = '7 days'
);

-- Signal predictions: compress after 3 days
ALTER TABLE signal_predictions SET (
  timescaledb.compress_after = '3 days'
);

-- Strategy performance log: compress after 7 days
ALTER TABLE strategy_performance_log SET (
  timescaledb.compress_after = '7 days'
);

-- ============================================
-- RETENTION POLICIES (Auto-delete old data)
-- ============================================

-- Orderbook snapshots: Keep only 7 days (very large, regenerated constantly)
SELECT add_retention_policy('orderbook_snapshots', INTERVAL '7 days', if_not_exists => TRUE);

-- Price history: Keep 30 days (needed for backtesting but old data less useful)
SELECT add_retention_policy('price_history', INTERVAL '30 days', if_not_exists => TRUE);

-- Trades: Keep 60 days (historical reference)
SELECT add_retention_policy('trades', INTERVAL '60 days', if_not_exists => TRUE);

-- Positions: Keep 90 days (need for analysis)
SELECT add_retention_policy('positions', INTERVAL '90 days', if_not_exists => TRUE);

-- Paper orders: Keep 90 days (need for paper trading history)
SELECT add_retention_policy('paper_orders', INTERVAL '90 days', if_not_exists => TRUE);

-- Paper equity history: Keep 180 days (key performance metric)
SELECT add_retention_policy('paper_equity_history', INTERVAL '180 days', if_not_exists => TRUE);

-- Signal predictions: Keep 60 days (for signal analysis)
SELECT add_retention_policy('signal_predictions', INTERVAL '60 days', if_not_exists => TRUE);

-- Strategy performance log: Keep 180 days (key for strategy evaluation)
SELECT add_retention_policy('strategy_performance_log', INTERVAL '180 days', if_not_exists => TRUE);

-- Backtest results (exploration): Keep 30 days
-- Note: Important results are kept via is_exploration = FALSE
SELECT add_retention_policy('backtest_results', INTERVAL '30 days', if_not_exists => TRUE);

-- ============================================
-- IMMEDIATE CLEANUP (Run manually first time)
-- ============================================

-- Compress all existing uncompressed chunks
SELECT compress_chunk(c, if_not_compressed => true)
FROM show_chunks('orderbook_snapshots', older_than => INTERVAL '1 day') c;

SELECT compress_chunk(c, if_not_compressed => true)
FROM show_chunks('price_history', older_than => INTERVAL '3 days') c;

SELECT compress_chunk(c, if_not_compressed => true)
FROM show_chunks('trades', older_than => INTERVAL '3 days') c;

-- Drop old chunks immediately to reclaim space
SELECT drop_chunks('orderbook_snapshots', older_than => INTERVAL '7 days');
SELECT drop_chunks('price_history', older_than => INTERVAL '30 days');
SELECT drop_chunks('trades', older_than => INTERVAL '60 days');

-- ============================================
-- DIAGNOSTIC QUERIES (for monitoring)
-- ============================================

-- Check current sizes per hypertable
-- SELECT hypertable_name, pg_size_pretty(total_bytes) as size
-- FROM timescaledb_information.hypertable_sizes
-- ORDER BY total_bytes DESC;

-- Check compression status
-- SELECT hypertable_name,
--        chunk_name,
--        pg_size_pretty(before_compression_total_bytes) as before,
--        pg_size_pretty(after_compression_total_bytes) as after,
--        compression_status
-- FROM timescaledb_information.chunks
-- WHERE hypertable_name IN ('price_history', 'orderbook_snapshots', 'trades')
-- ORDER BY range_start DESC
-- LIMIT 20;

-- Check retention policies
-- SELECT * FROM timescaledb_information.jobs
-- WHERE proc_name = 'policy_retention';

-- Check compression policies
-- SELECT * FROM timescaledb_information.jobs
-- WHERE proc_name = 'policy_compression';

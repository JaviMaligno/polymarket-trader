-- Partial index for is_resolved = true lookups
-- GammaCollector.getMarketStats() runs SELECT COUNT(*) FROM markets WHERE is_resolved = true
-- every 5 minutes via the log-stats scheduler job. Without this index, PostgreSQL does a
-- sequential scan of the full 108K-row markets table, saturating CPU on e2-micro.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_markets_is_resolved_true
  ON markets (is_resolved)
  WHERE is_resolved = true;

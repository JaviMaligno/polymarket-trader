-- 027_backtest_signal_coverage_cleanup.sql
-- Per spec docs/plans/2026-04-29-backtest-signal-coverage-design.md (issue #143).
-- The 6 generators below are NOT wired into BacktestService.createSignals, so Optuna
-- has zero fitness gradient on their weights. Their per-type rows in signal_weights
-- are stale (last value = whatever TPE noise wrote) and would otherwise persist
-- forever. Delete the per-type rows. The runtime combiner falls through to ?? 0.
-- Idempotent: re-running on a clean DB is a no-op.

DELETE FROM signal_weights
WHERE market_type != '__global__'
  AND signal_type IN (
    'mlofi',
    'spread_compression',
    'cross_market_corr',
    'price_divergence',
    'attention_spike',
    'news_sentiment'
  );

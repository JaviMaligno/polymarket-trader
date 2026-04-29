-- 026_optimization_state_per_type_ratchet.sql
-- Persists per-market-type best Sharpe across restarts so the optimizer's
-- per-type ratchet (introduced in PR #140) survives dashboard restarts.
-- Without this column, loadState() rebuilds bestSharpePerType as
-- { __legacy__: <last_overall_best_score> }, leaving every real market_type
-- at fallback 0 — the next cycle can then apply a marginal candidate
-- without comparing against the actual prior per-type high. See issue #144.

ALTER TABLE optimization_service_state
  ADD COLUMN IF NOT EXISTS best_sharpe_per_type JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Migration 014: Add oos_score column to optimization_runs
--
-- Stores the out-of-sample Sharpe ratio for each optimization run.
-- Used by the adaptive OOS gate to compute the empirical decay factor
-- (p25 of historical OOS/IS ratios).

ALTER TABLE optimization_runs ADD COLUMN IF NOT EXISTS oos_score double precision;

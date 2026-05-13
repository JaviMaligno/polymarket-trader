-- 031_edge_capacity.sql
-- Phase 4 of Market Intelligence: cost-aware edge_capacity per market_type as
-- a 9th MarketScorer dimension. Markets in market_types with positive net edge
-- get scored UP; markets in types with no positive cost-aware cells get scored
-- DOWN. Drives the rotator toward cohorts where the system has measurable edge.
--
-- Source data: generator_predictions × price_history forward drift, minus
-- per-(market_type) round-trip cost from paper_trades. Refreshed nightly by
-- scripts/measure-edge-capacity.js (data-collector cron, PR-D).
--
-- See docs/plans/2026-05-13-phase4-edge-aware-scorer-design.md.

-- Storage for the per-(market_type) edge capacity values. Separate from
-- category_performance because:
--   - different cadence (edge_capacity refreshes after t-stat measurements;
--     category_performance after live trades close)
--   - forward-looking (generator_predictions × 4h drift) vs realized (live PnL)
--   - sourced from a different pipeline (predictions + RT cost vs paper_positions)
CREATE TABLE IF NOT EXISTS market_type_edge_capacity (
  market_type      VARCHAR(32) PRIMARY KEY,
  edge_capacity    DOUBLE PRECISION NOT NULL,
  n_cells_positive INT NOT NULL DEFAULT 0,
  n_cells_measured INT NOT NULL DEFAULT 0,
  rt_cost_pct      DOUBLE PRECISION NOT NULL,
  source           TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- New score dimension persisted alongside the other 8. NULL for rows written
-- before Phase 4 deployed; new rows after deploy will populate.
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_edge_capacity FLOAT;

-- ScorerWeightOptimizer tunes this per-type via 300-trial random search once
-- enough closed trades accumulate (MIN_TRADES_FOR_PER_TYPE=30 per type).
-- NULL = use the hardcoded WEIGHTS.edgeCapacity default in MarketScorer.ts.
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS edge_capacity FLOAT;

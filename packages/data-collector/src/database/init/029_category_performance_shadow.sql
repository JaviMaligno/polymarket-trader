-- Mirrors category_performance schema but stores shadow-derived metrics with
-- an applied haircut. See docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md.

CREATE TABLE IF NOT EXISTS category_performance_shadow (
  market_type     VARCHAR(20)  PRIMARY KEY,
  win_rate        DOUBLE PRECISION,
  avg_pnl         DOUBLE PRECISION,
  sharpe_ratio    DOUBLE PRECISION,
  n_trades        INTEGER NOT NULL DEFAULT 0,
  prior           DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0.33,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

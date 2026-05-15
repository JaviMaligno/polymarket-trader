-- 032_generator_edge.sql
-- Phase 5 Pilar 1-B (2026-05-15): append-only history of cost-aware t-stat
-- measurements per (signal_id, market_type, direction) cell. Captures every
-- nightly refresh so we can trend edge over time (instead of just snapshotting
-- the latest value in market_type_edge_capacity).
--
-- Why a separate table from market_type_edge_capacity:
--   - market_type_edge_capacity is per-(market_type) aggregate of positive
--     t_net across cells. ONE row per type, overwritten each refresh.
--   - generator_edge is per-(signal, type, direction) row PER measurement,
--     append-only. Lets us answer questions like "is mean_reversion long
--     trending toward positive t_net over the last 30 days?" or "did the
--     last 7 measurements agree?"
--
-- Retention: keep all rows for now (~14 cells × 5 types × 1 measurement/day
-- = ~70 rows/day = ~25k rows/year). Cheap. Add CAGG / retention policy if
-- volume grows.

CREATE TABLE IF NOT EXISTS generator_edge (
  id            BIGSERIAL,
  measured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_id     VARCHAR(50) NOT NULL,
  market_type   VARCHAR(32) NOT NULL,
  direction     VARCHAR(8) NOT NULL,
  window_days   INT NOT NULL,
  horizon_hours INT NOT NULL,
  sample_size   INT,            -- null when full-data measurement
  n             INT NOT NULL,
  gross_pct     DOUBLE PRECISION,
  t_gross       DOUBLE PRECISION,
  rt_cost_pct   DOUBLE PRECISION NOT NULL,
  t_net         DOUBLE PRECISION,
  source        TEXT,
  PRIMARY KEY (measured_at, id)
);

-- CHECK direction constraint defensively. Defer NOT VALID + VALIDATE since
-- the table starts empty.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generator_edge_direction_check'
      AND conrelid = 'generator_edge'::regclass
  ) THEN
    ALTER TABLE generator_edge
      ADD CONSTRAINT generator_edge_direction_check
      CHECK (direction IN ('long','short'));
  END IF;
END $$;

-- Lookup index for "latest measurement per cell" queries.
CREATE INDEX IF NOT EXISTS idx_generator_edge_cell
  ON generator_edge (signal_id, market_type, direction, measured_at DESC);

-- Lookup index for "all measurements at a given time" / batch-load by source.
CREATE INDEX IF NOT EXISTS idx_generator_edge_measured_at
  ON generator_edge (measured_at DESC);

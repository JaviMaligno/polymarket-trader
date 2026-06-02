-- Materialized 4h-forward outcomes for generator_predictions.
--
-- Root cause (daily-review #297, EXPLAIN ANALYZE 2026-06-02): the nightly
-- EdgeCapacityRefresher recomputed a correlated price_history forward-seek per
-- sampled prediction on every run, over compressed chunks → event_short/
-- event_long exceeded the 600s cap. This table precomputes y1 (the YES price at
-- prediction_time + horizon) ONCE, when the prediction matures, so the refresher
-- reads a small purpose-built table instead. See
-- docs/superpowers/specs/2026-06-02-edge-refresher-outcome-materialization-design.md
--
-- Denormalizes signal_id/direction/y0/market_type from generator_predictions.
-- These are immutable at signal time (cold duplication, no divergence risk).
-- market_type is stored frozen — exact parity with the refresher's current
-- WHERE generator_predictions.market_type filter.

CREATE TABLE IF NOT EXISTS generator_prediction_outcomes (
    prediction_id    BIGINT NOT NULL,
    prediction_time  TIMESTAMPTZ NOT NULL,
    market_id        VARCHAR(128) NOT NULL,
    market_type      VARCHAR(32),
    signal_id        VARCHAR(50) NOT NULL,
    direction        VARCHAR(8)  NOT NULL,
    y0               NUMERIC(10,6) NOT NULL,
    y1               NUMERIC(10,6),
    horizon_hours    INT NOT NULL DEFAULT 4,
    no_forward_price BOOLEAN NOT NULL DEFAULT FALSE,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- PK includes prediction_time: TimescaleDB requires the partition column in
    -- every unique constraint. Mirrors generator_predictions' (time, id) PK.
    PRIMARY KEY (prediction_time, prediction_id, horizon_hours)
);

SELECT create_hypertable('generator_prediction_outcomes', 'prediction_time',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- Serves the refresher's WHERE market_type=$1 AND direction IN(...) AND
-- prediction_time >= NOW()-7d filter directly (index-covering, no heap-fetch).
CREATE INDEX IF NOT EXISTS idx_gpo_type_dir_time
    ON generator_prediction_outcomes (market_type, direction, prediction_time DESC);

-- Compression. NOTE: the `timescaledb.compress_after` table option used by the
-- older migrations (003_retention_policies.sql, 030_generator_predictions.sql)
-- is REJECTED by the TimescaleDB version now running on the VM
-- ("unrecognized parameter timescaledb.compress_after"; verified 2026-06-02 when
-- this migration first ran). Those tables were compressed when the original
-- volume was initialised under an older version; a fresh volume today would
-- silently skip their compression. The current, supported form is: enable
-- compression on the table, then attach a time-based policy.
ALTER TABLE generator_prediction_outcomes
    SET (timescaledb.compress, timescaledb.compress_orderby = 'prediction_time DESC');
SELECT add_compression_policy('generator_prediction_outcomes', INTERVAL '3 days', if_not_exists => TRUE);

SELECT add_retention_policy('generator_prediction_outcomes', INTERVAL '14 days', if_not_exists => TRUE);

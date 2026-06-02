-- Per-generator signal predictions
--
-- Stores the raw output of each individual signal generator (momentum,
-- mean_reversion, OFI, MLOFI, Hawkes, volume_anomaly, spread_compression,
-- cross_market_corr, price_divergence, attention_spike, news_sentiment,
-- resolution_prior). The combined signal is already persisted in
-- signal_predictions; this table captures the inputs to the combiner so we can
-- measure per-generator predictive power independently of weighting and dm
-- transforms.
--
-- yes_price_at_signal is always the YES token price at signal time (regardless
-- of generator direction). This simplifies later drift analysis vs price_history
-- (which also stores YES price).

CREATE TABLE IF NOT EXISTS generator_predictions (
    id BIGSERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(128) NOT NULL,
    market_type VARCHAR(32),

    signal_id VARCHAR(50) NOT NULL,    -- 'momentum', 'mean_reversion', 'ofi', etc.
    direction VARCHAR(8) NOT NULL,      -- 'long' | 'short' | 'neutral'
    strength NUMERIC(7,4) NOT NULL,     -- raw output strength (-1..+1, may be signed)
    confidence NUMERIC(5,4) NOT NULL,   -- 0..1
    yes_price_at_signal NUMERIC(10,6) NOT NULL,
    metadata JSONB DEFAULT '{}',

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('generator_predictions', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_gen_predictions_signal_time
    ON generator_predictions (signal_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_gen_predictions_market_time
    ON generator_predictions (market_id, time DESC);

-- ~110k rows/day at full universe (35 markets x 11 generators x 12 cycles/h x 24h).
-- 30-day retention keeps the table around 3.3M rows / ~250 MB compressed.
--
-- NOTE (2026-06-02, daily-review #297 / migration 035): the `compress_after`
-- table option is rejected by the current TimescaleDB version. Prod is already
-- compressed from the original older-version init; this only matters for a fresh
-- volume. Use SET (timescaledb.compress, compress_orderby=...) + policy instead.
ALTER TABLE generator_predictions SET (timescaledb.compress, timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('generator_predictions', INTERVAL '3 days', if_not_exists => TRUE);

SELECT add_retention_policy('generator_predictions', INTERVAL '30 days', if_not_exists => TRUE);

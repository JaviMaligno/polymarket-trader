-- Score capture on positions (for Optuna Phase 2.5)
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS market_score_at_entry FLOAT,
  ADD COLUMN IF NOT EXISTS score_dimensions_at_entry JSONB;

-- market_score_history: hourly snapshots of tracked + top-50 cold markets
CREATE TABLE IF NOT EXISTS market_score_history (
  time                  TIMESTAMPTZ  NOT NULL,
  condition_id          VARCHAR      NOT NULL,
  tracking_status       VARCHAR(10),
  market_score          FLOAT,
  score_tradeability    FLOAT,
  score_liquidity       FLOAT,
  score_ttr             FLOAT,
  score_volatility      FLOAT,
  score_data_quality    FLOAT,
  current_price_yes     FLOAT,
  volume_24h            FLOAT
);

SELECT create_hypertable('market_score_history', 'time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Retention: 90 days is enough for Optuna
SELECT add_retention_policy('market_score_history', INTERVAL '90 days', if_not_exists => TRUE);

-- Compress chunks older than 7 days
ALTER TABLE market_score_history SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'time DESC',
  timescaledb.compress_segmentby = 'condition_id'
);
SELECT add_compression_policy('market_score_history', INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_msh_condition_time
  ON market_score_history (condition_id, time DESC);

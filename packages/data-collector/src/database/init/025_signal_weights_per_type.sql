-- 025_signal_weights_per_type.sql
-- Extends signal_weights to support per-market-type rows. Existing rows become
-- market_type='__global__'; per-type rows added below as bootstrap.

ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';

-- Defensive PK swap: discover existing PK name dynamically.
DO $$
DECLARE pkey_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_weights_pkey_per_type') THEN
    RETURN;
  END IF;

  SELECT conname INTO pkey_name
  FROM pg_constraint
  WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

  IF pkey_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
  END IF;

  ALTER TABLE signal_weights
    ADD CONSTRAINT signal_weights_pkey_per_type PRIMARY KEY (signal_type, market_type);
END $$;

-- Bootstrap 55 per-type rows from current DEFAULT_TYPE_WEIGHTS hardcoded values.
INSERT INTO signal_weights (signal_type, weight, market_type, updated_at) VALUES
  -- crypto_intraday
  ('momentum',           -0.3, 'crypto_intraday', NOW()),
  ('mean_reversion',      0.5, 'crypto_intraday', NOW()),
  ('ofi',                 0.5, 'crypto_intraday', NOW()),
  ('mlofi',               0.5, 'crypto_intraday', NOW()),
  ('hawkes',              0.4, 'crypto_intraday', NOW()),
  ('volume_anomaly',      0.0, 'crypto_intraday', NOW()),
  ('spread_compression',  0.0, 'crypto_intraday', NOW()),
  ('cross_market_corr',   0.0, 'crypto_intraday', NOW()),
  ('price_divergence',    0.0, 'crypto_intraday', NOW()),
  ('attention_spike',     0.0, 'crypto_intraday', NOW()),
  ('news_sentiment',      0.0, 'crypto_intraday', NOW()),
  -- crypto_daily
  ('momentum',           -0.3, 'crypto_daily', NOW()),
  ('mean_reversion',      0.6, 'crypto_daily', NOW()),
  ('ofi',                 0.4, 'crypto_daily', NOW()),
  ('mlofi',               0.4, 'crypto_daily', NOW()),
  ('hawkes',              0.3, 'crypto_daily', NOW()),
  ('volume_anomaly',      0.0, 'crypto_daily', NOW()),
  ('spread_compression',  0.0, 'crypto_daily', NOW()),
  ('cross_market_corr',   0.0, 'crypto_daily', NOW()),
  ('price_divergence',    0.0, 'crypto_daily', NOW()),
  ('attention_spike',     0.0, 'crypto_daily', NOW()),
  ('news_sentiment',      0.0, 'crypto_daily', NOW()),
  -- event_financial
  ('momentum',           -0.3, 'event_financial', NOW()),
  ('mean_reversion',      0.6, 'event_financial', NOW()),
  ('ofi',                 0.4, 'event_financial', NOW()),
  ('mlofi',               0.4, 'event_financial', NOW()),
  ('hawkes',              0.3, 'event_financial', NOW()),
  ('volume_anomaly',      0.0, 'event_financial', NOW()),
  ('spread_compression',  0.0, 'event_financial', NOW()),
  ('cross_market_corr',   0.0, 'event_financial', NOW()),
  ('price_divergence',    0.0, 'event_financial', NOW()),
  ('attention_spike',     0.0, 'event_financial', NOW()),
  ('news_sentiment',      0.0, 'event_financial', NOW()),
  -- event_short
  ('momentum',           -0.4, 'event_short', NOW()),
  ('mean_reversion',      0.6, 'event_short', NOW()),
  ('ofi',                 0.3, 'event_short', NOW()),
  ('mlofi',               0.3, 'event_short', NOW()),
  ('hawkes',              0.2, 'event_short', NOW()),
  ('volume_anomaly',      0.0, 'event_short', NOW()),
  ('spread_compression',  0.0, 'event_short', NOW()),
  ('cross_market_corr',   0.0, 'event_short', NOW()),
  ('price_divergence',    0.0, 'event_short', NOW()),
  ('attention_spike',     0.0, 'event_short', NOW()),
  ('news_sentiment',      0.0, 'event_short', NOW()),
  -- event_long
  ('momentum',           -0.4, 'event_long', NOW()),
  ('mean_reversion',      0.6, 'event_long', NOW()),
  ('ofi',                 0.2, 'event_long', NOW()),
  ('mlofi',               0.2, 'event_long', NOW()),
  ('hawkes',              0.1, 'event_long', NOW()),
  ('volume_anomaly',      0.0, 'event_long', NOW()),
  ('spread_compression',  0.0, 'event_long', NOW()),
  ('cross_market_corr',   0.0, 'event_long', NOW()),
  ('price_divergence',    0.0, 'event_long', NOW()),
  ('attention_spike',     0.0, 'event_long', NOW()),
  ('news_sentiment',      0.0, 'event_long', NOW())
ON CONFLICT (signal_type, market_type) DO NOTHING;

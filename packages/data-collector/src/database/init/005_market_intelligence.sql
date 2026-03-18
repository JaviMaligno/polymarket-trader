-- Market Intelligence System: scoring and tracking status
ALTER TABLE markets ADD COLUMN IF NOT EXISTS market_score FLOAT DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(10) DEFAULT 'cold';
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tracking_status_changed_at TIMESTAMPTZ DEFAULT NOW();

-- Index for ClobCollector queries that filter by tracking_status
CREATE INDEX IF NOT EXISTS idx_markets_tracking_status ON markets (tracking_status) WHERE tracking_status IN ('warming', 'active', 'cooling');

-- Index for MarketScorer candidate selection
CREATE INDEX IF NOT EXISTS idx_markets_score ON markets (market_score DESC) WHERE is_active = true AND is_resolved = false;

-- Warm start: markets with recent price_history get 'active' status
-- (Run once on deployment, then MarketRotator manages state)
UPDATE markets SET tracking_status = 'active', tracking_status_changed_at = NOW()
WHERE is_active = true
  AND is_resolved = false
  AND clob_token_id_yes IS NOT NULL
  AND tracking_status != 'active'
  AND id IN (
    SELECT DISTINCT m.id FROM markets m
    JOIN price_history ph ON ph.token_id = m.clob_token_id_yes
    WHERE ph.time > NOW() - INTERVAL '24 hours'
  );

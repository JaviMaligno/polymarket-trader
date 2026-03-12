-- External data tables for cross-platform market correlation signals
-- Run after 001_schema.sql

-- Cross-platform market mappings (Polymarket <-> Metaculus/Manifold)
CREATE TABLE IF NOT EXISTS market_crossref (
  polymarket_id VARCHAR(128) NOT NULL,
  platform VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  external_question TEXT,
  external_price DECIMAL(10,6),
  match_confidence FLOAT NOT NULL DEFAULT 0.0,
  matched_at TIMESTAMPTZ DEFAULT NOW(),
  last_fetched_at TIMESTAMPTZ,
  PRIMARY KEY (polymarket_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_crossref_platform ON market_crossref(platform);
CREATE INDEX IF NOT EXISTS idx_crossref_confidence ON market_crossref(match_confidence);

-- External signal data (hourly snapshots from external sources)
CREATE TABLE IF NOT EXISTS external_signals (
  id SERIAL PRIMARY KEY,
  market_id VARCHAR(128) NOT NULL,
  source VARCHAR(50) NOT NULL,
  signal_type VARCHAR(50) NOT NULL,
  value FLOAT NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  metadata JSONB DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_signals_market ON external_signals(market_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_signals_source ON external_signals(source, signal_type);

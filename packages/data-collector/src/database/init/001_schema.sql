-- Polymarket Trading System - TimescaleDB Schema
-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================
-- EVENTS & MARKETS
-- ============================================

CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(128) PRIMARY KEY,
    slug VARCHAR(255) UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    category VARCHAR(100),
    tags JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    is_closed BOOLEAN DEFAULT FALSE,
    liquidity DECIMAL(20,6) DEFAULT 0,
    volume DECIMAL(20,6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS markets (
    id VARCHAR(128) PRIMARY KEY,
    event_id VARCHAR(128) REFERENCES events(id),
    clob_token_id_yes VARCHAR(128) NOT NULL,
    clob_token_id_no VARCHAR(128),
    condition_id VARCHAR(128) NOT NULL,
    question TEXT NOT NULL,
    description TEXT,
    category VARCHAR(100),
    end_date TIMESTAMPTZ,

    -- Current state (updated frequently)
    current_price_yes DECIMAL(10,6),
    current_price_no DECIMAL(10,6),
    spread DECIMAL(10,6),
    volume_24h DECIMAL(20,6),
    liquidity DECIMAL(20,6),
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    last_trade_price DECIMAL(10,6),

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolution_outcome VARCHAR(10),  -- 'yes', 'no', 'invalid'
    resolved_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    first_trade_at TIMESTAMPTZ,
    last_trade_at TIMESTAMPTZ,

    -- Metadata
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
CREATE INDEX IF NOT EXISTS idx_markets_token_yes ON markets(clob_token_id_yes);
CREATE INDEX IF NOT EXISTS idx_markets_token_no ON markets(clob_token_id_no);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);

-- ============================================
-- PRICE HISTORY (TimescaleDB Hypertable)
-- ============================================

CREATE TABLE IF NOT EXISTS price_history (
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- OHLCV data
    open DECIMAL(10,6),
    high DECIMAL(10,6),
    low DECIMAL(10,6),
    close DECIMAL(10,6),
    volume DECIMAL(20,6),

    -- Additional metrics
    vwap DECIMAL(10,6),
    trade_count INTEGER,
    bid DECIMAL(10,6),
    ask DECIMAL(10,6),
    spread DECIMAL(10,6),

    -- Data source
    source VARCHAR(20) DEFAULT 'api',

    PRIMARY KEY (time, market_id, token_id)
);

-- Convert to hypertable (1 day chunks for efficient queries)
SELECT create_hypertable('price_history', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Compression policy (compress data older than 7 days)
ALTER TABLE price_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'market_id,token_id'
);

SELECT add_compression_policy('price_history', INTERVAL '7 days', if_not_exists => TRUE);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_price_market_time ON price_history (market_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_price_token_time ON price_history (token_id, time DESC);

-- ============================================
-- CONTINUOUS AGGREGATES
-- ============================================

-- 5-minute bars
CREATE MATERIALIZED VIEW IF NOT EXISTS price_5m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', time) AS bucket,
    market_id,
    token_id,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume,
    avg(vwap) AS vwap,
    sum(trade_count) AS trade_count
FROM price_history
GROUP BY bucket, market_id, token_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('price_5m',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);

-- Hourly bars
CREATE MATERIALIZED VIEW IF NOT EXISTS price_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    market_id,
    token_id,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume,
    avg(vwap) AS vwap,
    sum(trade_count) AS trade_count
FROM price_history
GROUP BY bucket, market_id, token_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('price_1h',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- Daily bars
CREATE MATERIALIZED VIEW IF NOT EXISTS price_1d
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS bucket,
    market_id,
    token_id,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume,
    avg(vwap) AS vwap,
    sum(trade_count) AS trade_count
FROM price_history
GROUP BY bucket, market_id, token_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('price_1d',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- ============================================
-- TRADES
-- ============================================

CREATE TABLE IF NOT EXISTS trades (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Trade details
    side VARCHAR(4) NOT NULL,
    price DECIMAL(10,6) NOT NULL,
    size DECIMAL(20,6) NOT NULL,
    value_usd DECIMAL(20,6),
    fee DECIMAL(20,6),

    -- Counterparties
    maker_address VARCHAR(42),
    taker_address VARCHAR(42),

    -- On-chain reference
    tx_hash VARCHAR(66),
    block_number BIGINT,
    log_index INTEGER,

    -- Source
    source VARCHAR(20) DEFAULT 'api',

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('trades', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

ALTER TABLE trades SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'market_id'
);

SELECT add_compression_policy('trades', INTERVAL '30 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_trades_market ON trades (market_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_maker ON trades (maker_address, time DESC) WHERE maker_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_taker ON trades (taker_address, time DESC) WHERE taker_address IS NOT NULL;

-- ============================================
-- WALLETS
-- ============================================

CREATE TABLE IF NOT EXISTS wallets (
    address VARCHAR(42) PRIMARY KEY,
    label VARCHAR(255),
    is_tracked BOOLEAN DEFAULT FALSE,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ,

    -- Aggregated stats
    total_trades INTEGER DEFAULT 0,
    total_volume_usd DECIMAL(20,6) DEFAULT 0,
    total_pnl_usd DECIMAL(20,6),
    win_rate DECIMAL(5,4),

    tags JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_wallets_tracked ON wallets(is_tracked) WHERE is_tracked = TRUE;
CREATE INDEX IF NOT EXISTS idx_wallets_volume ON wallets(total_volume_usd DESC);

-- ============================================
-- POSITIONS (Wallet positions over time)
-- ============================================

CREATE TABLE IF NOT EXISTS positions (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    wallet_address VARCHAR(42) NOT NULL,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Position state
    size DECIMAL(20,6) NOT NULL,
    avg_entry_price DECIMAL(10,6),
    current_value_usd DECIMAL(20,6),
    unrealized_pnl DECIMAL(20,6),

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('positions', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions (wallet_address, time DESC);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions (market_id, time DESC);

-- ============================================
-- ORDER BOOK SNAPSHOTS
-- ============================================

CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Best bid/ask
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    spread DECIMAL(10,6),
    mid_price DECIMAL(10,6),

    -- Depth
    bids JSONB,
    asks JSONB,

    -- Aggregated metrics
    bid_depth_10pct DECIMAL(20,6),
    ask_depth_10pct DECIMAL(20,6),

    PRIMARY KEY (time, market_id, token_id)
);

SELECT create_hypertable('orderbook_snapshots', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

ALTER TABLE orderbook_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'market_id,token_id'
);

SELECT add_compression_policy('orderbook_snapshots', INTERVAL '1 day', if_not_exists => TRUE);

-- ============================================
-- COLLECTION METADATA
-- ============================================

CREATE TABLE IF NOT EXISTS collection_jobs (
    id SERIAL PRIMARY KEY,
    job_type VARCHAR(50) NOT NULL,
    target_id VARCHAR(128),
    status VARCHAR(20) DEFAULT 'pending',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_fetched_at TIMESTAMPTZ,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS api_rate_limits (
    endpoint VARCHAR(100) PRIMARY KEY,
    requests_made INTEGER DEFAULT 0,
    window_start TIMESTAMPTZ DEFAULT NOW(),
    limit_per_window INTEGER NOT NULL,
    window_seconds INTEGER DEFAULT 10
);

-- Insert default rate limits
INSERT INTO api_rate_limits (endpoint, limit_per_window, window_seconds)
VALUES
    ('gamma_markets', 300, 10),
    ('gamma_events', 500, 10),
    ('gamma_general', 4000, 10),
    ('clob_prices', 1500, 10),
    ('clob_books', 1500, 10),
    ('clob_history', 1000, 10),
    ('data_trades', 200, 10),
    ('data_positions', 150, 10)
ON CONFLICT (endpoint) DO NOTHING;

-- ============================================
-- INDEXER STATE (for on-chain sync)
-- ============================================

CREATE TABLE IF NOT EXISTS indexer_state (
    chain_id INTEGER PRIMARY KEY,
    contract_address VARCHAR(42) NOT NULL,
    last_block_number BIGINT DEFAULT 0,
    last_block_timestamp TIMESTAMPTZ,
    is_syncing BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- UTILITY FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating timestamps
CREATE TRIGGER events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER markets_updated_at
    BEFORE UPDATE ON markets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO polymarket;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO polymarket;

-- Polymarket Trading System - Signal Tracking Tables
-- For paper trading, signal learning, and P&L monitoring

-- ============================================
-- SIGNAL PREDICTIONS
-- Tracks each signal generated and its outcome
-- ============================================

CREATE TABLE IF NOT EXISTS signal_predictions (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(128) NOT NULL,

    -- Signal details
    signal_type VARCHAR(50) NOT NULL,  -- 'momentum', 'mean_reversion', 'wallet_tracking', etc.
    direction VARCHAR(4) NOT NULL,      -- 'long' or 'short'
    strength DECIMAL(5,4) NOT NULL,     -- Signal strength 0-1
    confidence DECIMAL(5,4) NOT NULL,   -- Confidence level 0-1

    -- Price at signal generation
    price_at_signal DECIMAL(10,6) NOT NULL,

    -- Resolution (filled when signal is evaluated)
    resolved_at TIMESTAMPTZ,
    price_at_resolution DECIMAL(10,6),
    was_correct BOOLEAN,
    pnl_pct DECIMAL(10,6),              -- Percentage P&L if traded

    -- Metadata
    metadata JSONB DEFAULT '{}',

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('signal_predictions', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_signal_predictions_market ON signal_predictions (market_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_signal_predictions_type ON signal_predictions (signal_type, time DESC);
CREATE INDEX IF NOT EXISTS idx_signal_predictions_unresolved ON signal_predictions (resolved_at) WHERE resolved_at IS NULL;

-- ============================================
-- SIGNAL WEIGHTS HISTORY
-- Audit trail for signal weight changes
-- ============================================

CREATE TABLE IF NOT EXISTS signal_weights_history (
    time TIMESTAMPTZ NOT NULL,
    signal_type VARCHAR(50) NOT NULL,

    -- Weight value
    weight DECIMAL(5,4) NOT NULL,        -- Current weight 0-1

    -- Performance metrics at time of change
    accuracy_7d DECIMAL(5,4),            -- 7-day accuracy
    accuracy_30d DECIMAL(5,4),           -- 30-day accuracy
    avg_pnl_7d DECIMAL(10,6),            -- Average PnL per trade (7d)
    sharpe_7d DECIMAL(10,6),             -- Sharpe ratio (7d)

    -- Change metadata
    reason VARCHAR(100),                  -- 'weekly_optimization', 'manual', 'initial'
    previous_weight DECIMAL(5,4),

    PRIMARY KEY (time, signal_type)
);

SELECT create_hypertable('signal_weights_history', 'time',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_signal_weights_type ON signal_weights_history (signal_type, time DESC);

-- ============================================
-- PAPER TRADES
-- Simulated trades for paper trading
-- ============================================

CREATE TABLE IF NOT EXISTS paper_trades (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Trade details
    side VARCHAR(4) NOT NULL,            -- 'buy' or 'sell'
    requested_size DECIMAL(20,6) NOT NULL,
    executed_size DECIMAL(20,6) NOT NULL,
    requested_price DECIMAL(10,6) NOT NULL,
    executed_price DECIMAL(10,6) NOT NULL,
    slippage_pct DECIMAL(10,6),

    -- Costs
    fee DECIMAL(20,6) DEFAULT 0,
    value_usd DECIMAL(20,6),

    -- Source signal
    signal_id INTEGER,                   -- Reference to signal_predictions
    signal_type VARCHAR(50),

    -- Execution details
    order_type VARCHAR(20) DEFAULT 'market',  -- 'market', 'limit'
    fill_type VARCHAR(20) DEFAULT 'full',     -- 'full', 'partial', 'rejected'
    rejection_reason VARCHAR(100),

    -- Orderbook state at execution
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    orderbook_depth JSONB,

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('paper_trades', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_market ON paper_trades (market_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal ON paper_trades (signal_type, time DESC);

-- ============================================
-- PAPER POSITIONS
-- Current paper trading positions
-- ============================================

CREATE TABLE IF NOT EXISTS paper_positions (
    market_id VARCHAR(128) PRIMARY KEY,
    token_id VARCHAR(128) NOT NULL,

    -- Position state
    side VARCHAR(4) NOT NULL,            -- 'long' or 'short'
    size DECIMAL(20,6) NOT NULL,
    avg_entry_price DECIMAL(10,6) NOT NULL,
    current_price DECIMAL(10,6),

    -- P&L
    unrealized_pnl DECIMAL(20,6),
    unrealized_pnl_pct DECIMAL(10,6),
    realized_pnl DECIMAL(20,6) DEFAULT 0,

    -- Risk
    stop_loss DECIMAL(10,6),
    take_profit DECIMAL(10,6),

    -- Timestamps
    opened_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Metadata
    signal_type VARCHAR(50),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_updated ON paper_positions (updated_at DESC);

-- ============================================
-- PORTFOLIO SNAPSHOTS
-- Periodic snapshots of portfolio state
-- ============================================

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    time TIMESTAMPTZ NOT NULL,

    -- Capital
    initial_capital DECIMAL(20,6) NOT NULL,
    current_capital DECIMAL(20,6) NOT NULL,
    available_capital DECIMAL(20,6) NOT NULL,

    -- P&L
    total_pnl DECIMAL(20,6) NOT NULL,
    total_pnl_pct DECIMAL(10,6) NOT NULL,
    daily_pnl DECIMAL(20,6),

    -- Risk metrics
    max_drawdown DECIMAL(10,6),
    current_drawdown DECIMAL(10,6),
    sharpe_ratio DECIMAL(10,6),

    -- Trading stats
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    win_rate DECIMAL(5,4),
    avg_win DECIMAL(20,6),
    avg_loss DECIMAL(20,6),
    profit_factor DECIMAL(10,6),

    -- Position summary
    open_positions INTEGER DEFAULT 0,
    total_exposure DECIMAL(20,6),

    PRIMARY KEY (time)
);

SELECT create_hypertable('portfolio_snapshots', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ============================================
-- SIGNAL WEIGHTS (Current values)
-- ============================================

CREATE TABLE IF NOT EXISTS signal_weights (
    signal_type VARCHAR(50) PRIMARY KEY,
    weight DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    is_enabled BOOLEAN DEFAULT TRUE,
    min_confidence DECIMAL(5,4) DEFAULT 0.3,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default weights
INSERT INTO signal_weights (signal_type, weight, is_enabled) VALUES
    ('momentum', 0.5, TRUE),
    ('mean_reversion', 0.5, TRUE),
    ('wallet_tracking', 0.3, TRUE),
    ('volume_spike', 0.4, TRUE)
ON CONFLICT (signal_type) DO NOTHING;

-- ============================================
-- TRADING CONFIG
-- Runtime trading configuration
-- ============================================

CREATE TABLE IF NOT EXISTS trading_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default config
INSERT INTO trading_config (key, value, description) VALUES
    ('paper_trading', '{"enabled": true, "initial_capital": 10000}', 'Paper trading settings'),
    ('risk_limits', '{"max_position_size": 1000, "max_slippage_pct": 2.0, "max_drawdown": 0.15, "max_daily_loss": 500}', 'Risk management limits'),
    ('signal_optimization', '{"enabled": true, "interval_days": 7, "max_change_pct": 0.10, "min_predictions": 50}', 'Automatic signal optimization settings'),
    ('orderbook_simulation', '{"enabled": true, "min_liquidity_ratio": 0.1, "simulate_partial_fills": true}', 'Orderbook simulation settings')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- Grant permissions
-- ============================================

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO polymarket;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO polymarket;

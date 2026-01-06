-- Polymarket Trading System - Paper Trading & Signal Learning Tables
-- Run AFTER 001_schema.sql

-- ============================================
-- PAPER TRADING ORDERS
-- ============================================

CREATE TABLE IF NOT EXISTS paper_orders (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Order details
    side VARCHAR(4) NOT NULL,  -- 'buy' or 'sell'
    order_type VARCHAR(10) DEFAULT 'market',  -- 'market' or 'limit'
    requested_size DECIMAL(20,6) NOT NULL,
    requested_price DECIMAL(10,6),

    -- Execution details (from OrderBookSimulator)
    executed_size DECIMAL(20,6),
    executed_price DECIMAL(10,6),  -- VWAP of fills
    slippage_pct DECIMAL(10,6),
    fees DECIMAL(20,6),

    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- pending, filled, partial, rejected
    reject_reason TEXT,

    -- Fill details
    fills JSONB DEFAULT '[]',  -- Array of {price, size, timestamp}

    PRIMARY KEY (time, id)
);

SELECT create_hypertable('paper_orders', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_market ON paper_orders (market_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_status ON paper_orders (status, time DESC);

-- ============================================
-- PAPER TRADING POSITIONS
-- ============================================

CREATE TABLE IF NOT EXISTS paper_positions (
    id SERIAL PRIMARY KEY,
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,

    -- Position state
    side VARCHAR(4) NOT NULL,  -- 'yes' or 'no'
    size DECIMAL(20,6) NOT NULL DEFAULT 0,
    avg_entry_price DECIMAL(10,6) NOT NULL,

    -- P&L tracking
    realized_pnl DECIMAL(20,6) DEFAULT 0,
    unrealized_pnl DECIMAL(20,6) DEFAULT 0,

    -- Timestamps
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,

    -- Metadata
    metadata JSONB DEFAULT '{}',

    UNIQUE(market_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_market ON paper_positions (market_id);
CREATE INDEX IF NOT EXISTS idx_paper_positions_open ON paper_positions (closed_at) WHERE closed_at IS NULL;

-- ============================================
-- PAPER TRADING ACCOUNT STATE
-- ============================================

CREATE TABLE IF NOT EXISTS paper_account (
    id SERIAL PRIMARY KEY,

    -- Capital
    initial_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,
    current_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,
    available_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,

    -- P&L
    total_realized_pnl DECIMAL(20,6) DEFAULT 0,
    total_unrealized_pnl DECIMAL(20,6) DEFAULT 0,
    total_fees_paid DECIMAL(20,6) DEFAULT 0,

    -- Risk metrics
    max_drawdown DECIMAL(10,6) DEFAULT 0,
    peak_equity DECIMAL(20,6),

    -- Stats
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default account if not exists
INSERT INTO paper_account (initial_capital, current_capital, available_capital, peak_equity)
VALUES (10000, 10000, 10000, 10000)
ON CONFLICT DO NOTHING;

-- ============================================
-- PAPER TRADING EQUITY HISTORY
-- ============================================

CREATE TABLE IF NOT EXISTS paper_equity_history (
    time TIMESTAMPTZ NOT NULL,

    equity DECIMAL(20,6) NOT NULL,
    cash DECIMAL(20,6) NOT NULL,
    positions_value DECIMAL(20,6) NOT NULL,

    realized_pnl DECIMAL(20,6),
    unrealized_pnl DECIMAL(20,6),
    drawdown_pct DECIMAL(10,6),

    PRIMARY KEY (time)
);

SELECT create_hypertable('paper_equity_history', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ============================================
-- SIGNAL PREDICTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS signal_predictions (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(64) NOT NULL,

    -- Signal details
    signal_type VARCHAR(50) NOT NULL,  -- momentum, mean_reversion, whale_following, etc.
    direction VARCHAR(4) NOT NULL,  -- 'buy' or 'sell'
    strength DECIMAL(5,4) NOT NULL,  -- 0 to 1
    confidence DECIMAL(5,4) NOT NULL,  -- 0 to 1

    -- Price at signal
    price_at_signal DECIMAL(10,6) NOT NULL,

    -- Resolution (filled when market moves or after timeout)
    resolved_at TIMESTAMPTZ,
    price_at_resolution DECIMAL(10,6),
    was_correct BOOLEAN,
    pnl_pct DECIMAL(10,6),  -- % return if followed

    -- Link to order if executed
    order_id INTEGER,

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
-- ============================================

CREATE TABLE IF NOT EXISTS signal_weights_history (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signal_type VARCHAR(50) NOT NULL,

    -- Current weight
    weight DECIMAL(5,4) NOT NULL,

    -- Performance metrics that led to this weight
    accuracy_7d DECIMAL(5,4),
    accuracy_30d DECIMAL(5,4),
    avg_pnl_7d DECIMAL(10,6),
    avg_pnl_30d DECIMAL(10,6),
    sharpe_7d DECIMAL(10,6),

    -- Change info
    previous_weight DECIMAL(5,4),
    change_reason VARCHAR(100),  -- 'optimization', 'manual', 'initial'

    PRIMARY KEY (time, signal_type)
);

SELECT create_hypertable('signal_weights_history', 'time',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists => TRUE
);

-- Insert initial weights
INSERT INTO signal_weights_history (signal_type, weight, change_reason)
VALUES
    ('momentum', 0.5, 'initial'),
    ('mean_reversion', 0.5, 'initial'),
    ('whale_following', 0.5, 'initial'),
    ('volume_spike', 0.5, 'initial'),
    ('sentiment', 0.5, 'initial')
ON CONFLICT DO NOTHING;

-- ============================================
-- SIGNAL WEIGHTS CURRENT (for fast lookup)
-- ============================================

CREATE TABLE IF NOT EXISTS signal_weights_current (
    signal_type VARCHAR(50) PRIMARY KEY,
    weight DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    last_updated TIMESTAMPTZ DEFAULT NOW(),

    -- Cached metrics
    accuracy_7d DECIMAL(5,4),
    accuracy_30d DECIMAL(5,4),
    total_predictions INTEGER DEFAULT 0,

    -- Bounds
    min_weight DECIMAL(5,4) DEFAULT 0.1,
    max_weight DECIMAL(5,4) DEFAULT 0.9
);

-- Insert initial weights
INSERT INTO signal_weights_current (signal_type, weight)
VALUES
    ('momentum', 0.5),
    ('mean_reversion', 0.5),
    ('whale_following', 0.5),
    ('volume_spike', 0.5),
    ('sentiment', 0.5)
ON CONFLICT DO NOTHING;

-- ============================================
-- VIEWS FOR DASHBOARD
-- ============================================

-- Current P&L summary
CREATE OR REPLACE VIEW paper_pnl_summary AS
SELECT
    pa.initial_capital,
    pa.current_capital,
    pa.available_capital,
    pa.total_realized_pnl,
    pa.total_unrealized_pnl,
    pa.total_realized_pnl + pa.total_unrealized_pnl as total_pnl,
    ((pa.current_capital + pa.total_unrealized_pnl - pa.initial_capital) / pa.initial_capital * 100) as total_return_pct,
    pa.max_drawdown,
    pa.total_trades,
    pa.winning_trades,
    pa.losing_trades,
    CASE WHEN pa.total_trades > 0
         THEN (pa.winning_trades::decimal / pa.total_trades * 100)
         ELSE 0 END as win_rate_pct,
    pa.updated_at
FROM paper_account pa
LIMIT 1;

-- Signal performance summary
CREATE OR REPLACE VIEW signal_performance_summary AS
SELECT
    swc.signal_type,
    swc.weight,
    swc.accuracy_7d,
    swc.accuracy_30d,
    swc.total_predictions,
    COUNT(sp.id) FILTER (WHERE sp.time > NOW() - INTERVAL '7 days') as predictions_7d,
    COUNT(sp.id) FILTER (WHERE sp.was_correct = true AND sp.time > NOW() - INTERVAL '7 days') as correct_7d,
    AVG(sp.pnl_pct) FILTER (WHERE sp.time > NOW() - INTERVAL '7 days') as avg_pnl_7d
FROM signal_weights_current swc
LEFT JOIN signal_predictions sp ON sp.signal_type = swc.signal_type
GROUP BY swc.signal_type, swc.weight, swc.accuracy_7d, swc.accuracy_30d, swc.total_predictions;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to record equity snapshot
CREATE OR REPLACE FUNCTION record_equity_snapshot()
RETURNS void AS $$
DECLARE
    v_equity DECIMAL(20,6);
    v_cash DECIMAL(20,6);
    v_positions_value DECIMAL(20,6);
    v_realized_pnl DECIMAL(20,6);
    v_unrealized_pnl DECIMAL(20,6);
    v_peak DECIMAL(20,6);
    v_drawdown DECIMAL(10,6);
BEGIN
    SELECT current_capital, total_realized_pnl, total_unrealized_pnl, peak_equity
    INTO v_cash, v_realized_pnl, v_unrealized_pnl, v_peak
    FROM paper_account LIMIT 1;

    SELECT COALESCE(SUM(size *
        CASE WHEN side = 'yes'
             THEN (SELECT current_price_yes FROM markets WHERE id = pp.market_id)
             ELSE (SELECT current_price_no FROM markets WHERE id = pp.market_id)
        END), 0)
    INTO v_positions_value
    FROM paper_positions pp
    WHERE closed_at IS NULL;

    v_equity := v_cash + v_positions_value;

    IF v_equity > COALESCE(v_peak, 0) THEN
        v_peak := v_equity;
        UPDATE paper_account SET peak_equity = v_peak;
    END IF;

    v_drawdown := CASE WHEN v_peak > 0 THEN ((v_peak - v_equity) / v_peak * 100) ELSE 0 END;

    INSERT INTO paper_equity_history (time, equity, cash, positions_value, realized_pnl, unrealized_pnl, drawdown_pct)
    VALUES (NOW(), v_equity, v_cash, v_positions_value, v_realized_pnl, v_unrealized_pnl, v_drawdown);
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO polymarket;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO polymarket;

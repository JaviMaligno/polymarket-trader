-- Polymarket Trading System - Optimization Schema
-- Run after 001_schema.sql

-- Ensure update_updated_at function exists (in case running standalone)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- OPTIMIZATION RUNS
-- ============================================

CREATE TABLE IF NOT EXISTS optimization_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),

    -- Optimizer configuration
    optimizer_type VARCHAR(50) NOT NULL DEFAULT 'bayesian', -- 'bayesian', 'grid', 'random'
    n_iterations INTEGER NOT NULL DEFAULT 100,
    objective_metric VARCHAR(50) NOT NULL DEFAULT 'sharpe', -- 'sharpe', 'calmar', 'total_return', 'sortino'

    -- Parameter space (full definition of what's being optimized)
    parameter_space JSONB NOT NULL,

    -- Data configuration
    data_start_date TIMESTAMPTZ NOT NULL,
    data_end_date TIMESTAMPTZ NOT NULL,
    market_filter JSONB DEFAULT '{}', -- filters applied to market selection
    market_count INTEGER,

    -- Results (populated after completion)
    best_params JSONB,
    best_score FLOAT,
    iterations_completed INTEGER DEFAULT 0,

    -- Timing
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_seconds INTEGER,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by VARCHAR(100) DEFAULT 'system',
    tags JSONB DEFAULT '[]',
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_optimization_runs_status ON optimization_runs(status);
CREATE INDEX IF NOT EXISTS idx_optimization_runs_created ON optimization_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_runs_best_score ON optimization_runs(best_score DESC NULLS LAST);

-- Trigger for updated_at
CREATE TRIGGER optimization_runs_updated_at
    BEFORE UPDATE ON optimization_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- BACKTEST RESULTS
-- ============================================

CREATE TABLE IF NOT EXISTS backtest_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    optimization_run_id UUID REFERENCES optimization_runs(id) ON DELETE CASCADE,

    -- Classification
    is_exploration BOOLEAN DEFAULT TRUE, -- false = important/saved result
    iteration INTEGER,

    -- Parameters used
    params JSONB NOT NULL,

    -- Core metrics
    total_return FLOAT,
    annualized_return FLOAT,
    sharpe_ratio FLOAT,
    sortino_ratio FLOAT,
    calmar_ratio FLOAT,
    max_drawdown FLOAT,

    -- Trade metrics
    total_trades INTEGER,
    winning_trades INTEGER,
    losing_trades INTEGER,
    win_rate FLOAT,
    profit_factor FLOAT,
    avg_win FLOAT,
    avg_loss FLOAT,
    largest_win FLOAT,
    largest_loss FLOAT,
    avg_trade_duration_hours FLOAT,

    -- Position metrics
    avg_position_size FLOAT,
    max_concurrent_positions INTEGER,
    time_in_market_pct FLOAT,

    -- Extended metrics (all additional metrics)
    metrics JSONB DEFAULT '{}',

    -- Equity curve (sampled snapshots)
    equity_curve JSONB DEFAULT '[]',

    -- Execution stats
    execution_time_ms INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_optimization ON backtest_results(optimization_run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_exploration ON backtest_results(is_exploration);
CREATE INDEX IF NOT EXISTS idx_backtest_sharpe ON backtest_results(sharpe_ratio DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_backtest_return ON backtest_results(total_return DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_backtest_created ON backtest_results(created_at DESC);

-- Partial index for non-exploration results (faster queries for important results)
CREATE INDEX IF NOT EXISTS idx_backtest_important ON backtest_results(sharpe_ratio DESC)
    WHERE is_exploration = FALSE;

-- ============================================
-- SAVED STRATEGIES
-- ============================================

CREATE TABLE IF NOT EXISTS saved_strategies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    version INTEGER DEFAULT 1,

    -- Full configuration
    params JSONB NOT NULL,

    -- Lineage (where this strategy came from)
    optimization_run_id UUID REFERENCES optimization_runs(id),
    backtest_result_id UUID REFERENCES backtest_results(id),
    parent_strategy_id UUID REFERENCES saved_strategies(id), -- if derived from another

    -- Validation results
    walk_forward_passed BOOLEAN,
    walk_forward_results JSONB,
    monte_carlo_passed BOOLEAN,
    monte_carlo_results JSONB,
    overfit_score FLOAT, -- 0-1, lower is better

    -- Expected performance (from backtest)
    expected_sharpe FLOAT,
    expected_return FLOAT,
    expected_max_drawdown FLOAT,

    -- Actual performance (from paper/live trading)
    actual_sharpe FLOAT,
    actual_return FLOAT,
    actual_max_drawdown FLOAT,
    performance_drift FLOAT, -- actual vs expected difference

    -- Deployment state
    is_active BOOLEAN DEFAULT FALSE,
    mode VARCHAR(20) CHECK (mode IN ('backtest', 'paper', 'live')),
    activated_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategies_active ON saved_strategies(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_strategies_mode ON saved_strategies(mode);
CREATE INDEX IF NOT EXISTS idx_strategies_sharpe ON saved_strategies(expected_sharpe DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_strategies_created ON saved_strategies(created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER saved_strategies_updated_at
    BEFORE UPDATE ON saved_strategies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- STRATEGY PERFORMANCE LOG
-- (Track performance over time for paper/live strategies)
-- ============================================

CREATE TABLE IF NOT EXISTS strategy_performance_log (
    time TIMESTAMPTZ NOT NULL,
    strategy_id UUID NOT NULL REFERENCES saved_strategies(id) ON DELETE CASCADE,
    mode VARCHAR(20) NOT NULL, -- 'paper' or 'live'

    -- Snapshot metrics
    portfolio_value FLOAT,
    cash FLOAT,
    positions_value FLOAT,
    unrealized_pnl FLOAT,
    realized_pnl FLOAT,

    -- Period metrics (since last snapshot)
    period_return FLOAT,
    period_trades INTEGER,
    period_wins INTEGER,
    period_losses INTEGER,

    -- Cumulative metrics
    cumulative_return FLOAT,
    cumulative_sharpe FLOAT,
    max_drawdown FLOAT,

    -- Drift detection
    drift_from_expected FLOAT,

    PRIMARY KEY (time, strategy_id)
);

SELECT create_hypertable('strategy_performance_log', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_perf_log_strategy ON strategy_performance_log(strategy_id, time DESC);

-- ============================================
-- OPTIMIZATION SERVICE STATE
-- (For the continuous optimization service)
-- ============================================

CREATE TABLE IF NOT EXISTS optimization_service_state (
    id VARCHAR(50) PRIMARY KEY DEFAULT 'main',

    -- Service status
    is_running BOOLEAN DEFAULT FALSE,
    last_heartbeat TIMESTAMPTZ,

    -- Last runs
    last_incremental_run_at TIMESTAMPTZ,
    last_full_run_at TIMESTAMPTZ,
    last_validation_at TIMESTAMPTZ,

    -- Current work
    current_optimization_run_id UUID REFERENCES optimization_runs(id),

    -- Configuration (can be updated at runtime)
    config JSONB DEFAULT '{
        "incremental_cron": "0 */6 * * *",
        "full_cron": "0 0 * * 0",
        "validation_cron": "0 */24 * * *",
        "auto_activate_paper": true,
        "auto_activate_live": false,
        "min_sharpe_improvement": 0.2,
        "min_walk_forward_consistency": 0.7
    }',

    -- Statistics
    total_runs_completed INTEGER DEFAULT 0,
    total_strategies_found INTEGER DEFAULT 0,

    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default service state
INSERT INTO optimization_service_state (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;

-- ============================================
-- VIEWS
-- ============================================

-- View: Best results per optimization run
CREATE OR REPLACE VIEW v_optimization_best_results AS
SELECT DISTINCT ON (optimization_run_id)
    br.*,
    opr.name as run_name,
    opr.optimizer_type,
    opr.objective_metric
FROM backtest_results br
JOIN optimization_runs opr ON br.optimization_run_id = opr.id
WHERE br.optimization_run_id IS NOT NULL
ORDER BY optimization_run_id,
    CASE opr.objective_metric
        WHEN 'sharpe' THEN br.sharpe_ratio
        WHEN 'calmar' THEN br.calmar_ratio
        WHEN 'total_return' THEN br.total_return
        WHEN 'sortino' THEN br.sortino_ratio
        ELSE br.sharpe_ratio
    END DESC NULLS LAST;

-- View: Active strategies with performance
CREATE OR REPLACE VIEW v_active_strategies AS
SELECT
    s.*,
    pl.portfolio_value as current_value,
    pl.cumulative_return as current_return,
    pl.cumulative_sharpe as current_sharpe,
    pl.drift_from_expected,
    pl.time as last_update
FROM saved_strategies s
LEFT JOIN LATERAL (
    SELECT * FROM strategy_performance_log
    WHERE strategy_id = s.id
    ORDER BY time DESC
    LIMIT 1
) pl ON true
WHERE s.is_active = TRUE;

-- View: Optimization run summary
CREATE OR REPLACE VIEW v_optimization_summary AS
SELECT
    opr.*,
    COUNT(br.id) as total_iterations,
    AVG(br.sharpe_ratio) as avg_sharpe,
    MAX(br.sharpe_ratio) as max_sharpe,
    AVG(br.total_return) as avg_return,
    MAX(br.total_return) as max_return,
    AVG(br.execution_time_ms) as avg_execution_time_ms
FROM optimization_runs opr
LEFT JOIN backtest_results br ON br.optimization_run_id = opr.id
GROUP BY opr.id;

-- ============================================
-- CLEANUP FUNCTION
-- (Remove old exploration results to save space)
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_old_exploration_results(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM backtest_results
        WHERE is_exploration = TRUE
          AND created_at < NOW() - (days_to_keep || ' days')::INTERVAL
          AND optimization_run_id NOT IN (
              -- Keep results from runs that produced saved strategies
              SELECT DISTINCT optimization_run_id
              FROM saved_strategies
              WHERE optimization_run_id IS NOT NULL
          )
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup (optional, run manually or via cron)
-- SELECT cleanup_old_exploration_results(30);

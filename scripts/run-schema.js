const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// SQL statements to execute - broken into proper chunks
const statements = [
  // Events table
  `CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(64) PRIMARY KEY,
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_category ON events(category)`,
  `CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active) WHERE is_active = TRUE`,

  // Markets table
  `CREATE TABLE IF NOT EXISTS markets (
    id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) REFERENCES events(id),
    clob_token_id_yes VARCHAR(128) NOT NULL,
    clob_token_id_no VARCHAR(128),
    condition_id VARCHAR(128) NOT NULL,
    question TEXT NOT NULL,
    description TEXT,
    category VARCHAR(100),
    end_date TIMESTAMPTZ,
    current_price_yes DECIMAL(10,6),
    current_price_no DECIMAL(10,6),
    spread DECIMAL(10,6),
    volume_24h DECIMAL(20,6),
    liquidity DECIMAL(20,6),
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    last_trade_price DECIMAL(10,6),
    is_active BOOLEAN DEFAULT TRUE,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolution_outcome VARCHAR(10),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    first_trade_at TIMESTAMPTZ,
    last_trade_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_markets_token_yes ON markets(clob_token_id_yes)`,
  `CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(is_active) WHERE is_active = TRUE`,

  // Price history hypertable
  `CREATE TABLE IF NOT EXISTS price_history (
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    open DECIMAL(10,6),
    high DECIMAL(10,6),
    low DECIMAL(10,6),
    close DECIMAL(10,6),
    volume DECIMAL(20,6),
    vwap DECIMAL(10,6),
    trade_count INTEGER,
    bid DECIMAL(10,6),
    ask DECIMAL(10,6),
    spread DECIMAL(10,6),
    source VARCHAR(20) DEFAULT 'api',
    PRIMARY KEY (time, market_id, token_id)
  )`,
  `SELECT create_hypertable('price_history', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)`,
  `CREATE INDEX IF NOT EXISTS idx_price_market_time ON price_history (market_id, time DESC)`,

  // Trades hypertable
  `CREATE TABLE IF NOT EXISTS trades (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    side VARCHAR(4) NOT NULL,
    price DECIMAL(10,6) NOT NULL,
    size DECIMAL(20,6) NOT NULL,
    value_usd DECIMAL(20,6),
    fee DECIMAL(20,6),
    maker_address VARCHAR(42),
    taker_address VARCHAR(42),
    tx_hash VARCHAR(66),
    block_number BIGINT,
    log_index INTEGER,
    source VARCHAR(20) DEFAULT 'api',
    PRIMARY KEY (time, id)
  )`,
  `SELECT create_hypertable('trades', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)`,
  `CREATE INDEX IF NOT EXISTS idx_trades_market ON trades (market_id, time DESC)`,

  // Wallets
  `CREATE TABLE IF NOT EXISTS wallets (
    address VARCHAR(42) PRIMARY KEY,
    label VARCHAR(255),
    is_tracked BOOLEAN DEFAULT FALSE,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ,
    total_trades INTEGER DEFAULT 0,
    total_volume_usd DECIMAL(20,6) DEFAULT 0,
    total_pnl_usd DECIMAL(20,6),
    win_rate DECIMAL(5,4),
    tags JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_tracked ON wallets(is_tracked) WHERE is_tracked = TRUE`,

  // Orderbook snapshots
  `CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    spread DECIMAL(10,6),
    mid_price DECIMAL(10,6),
    bids JSONB,
    asks JSONB,
    bid_depth_10pct DECIMAL(20,6),
    ask_depth_10pct DECIMAL(20,6),
    PRIMARY KEY (time, market_id, token_id)
  )`,
  `SELECT create_hypertable('orderbook_snapshots', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)`,

  // Paper trading orders
  `CREATE TABLE IF NOT EXISTS paper_orders (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    side VARCHAR(4) NOT NULL,
    order_type VARCHAR(10) DEFAULT 'market',
    requested_size DECIMAL(20,6) NOT NULL,
    requested_price DECIMAL(10,6),
    executed_size DECIMAL(20,6),
    executed_price DECIMAL(10,6),
    slippage_pct DECIMAL(10,6),
    fees DECIMAL(20,6),
    status VARCHAR(20) DEFAULT 'pending',
    reject_reason TEXT,
    fills JSONB DEFAULT '[]',
    PRIMARY KEY (time, id)
  )`,
  `SELECT create_hypertable('paper_orders', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
  `CREATE INDEX IF NOT EXISTS idx_paper_orders_market ON paper_orders (market_id, time DESC)`,

  // Paper positions
  `CREATE TABLE IF NOT EXISTS paper_positions (
    id SERIAL PRIMARY KEY,
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    side VARCHAR(4) NOT NULL,
    size DECIMAL(20,6) NOT NULL DEFAULT 0,
    avg_entry_price DECIMAL(10,6) NOT NULL,
    realized_pnl DECIMAL(20,6) DEFAULT 0,
    unrealized_pnl DECIMAL(20,6) DEFAULT 0,
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    UNIQUE(market_id, token_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_paper_positions_market ON paper_positions (market_id)`,

  // Paper account
  `CREATE TABLE IF NOT EXISTS paper_account (
    id SERIAL PRIMARY KEY,
    initial_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,
    current_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,
    available_capital DECIMAL(20,6) NOT NULL DEFAULT 10000,
    total_realized_pnl DECIMAL(20,6) DEFAULT 0,
    total_unrealized_pnl DECIMAL(20,6) DEFAULT 0,
    total_fees_paid DECIMAL(20,6) DEFAULT 0,
    max_drawdown DECIMAL(10,6) DEFAULT 0,
    peak_equity DECIMAL(20,6),
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `INSERT INTO paper_account (initial_capital, current_capital, available_capital, peak_equity)
   SELECT 10000, 10000, 10000, 10000
   WHERE NOT EXISTS (SELECT 1 FROM paper_account)`,

  // Paper equity history
  `CREATE TABLE IF NOT EXISTS paper_equity_history (
    time TIMESTAMPTZ NOT NULL,
    equity DECIMAL(20,6) NOT NULL,
    cash DECIMAL(20,6) NOT NULL,
    positions_value DECIMAL(20,6) NOT NULL,
    realized_pnl DECIMAL(20,6),
    unrealized_pnl DECIMAL(20,6),
    drawdown_pct DECIMAL(10,6),
    PRIMARY KEY (time)
  )`,
  `SELECT create_hypertable('paper_equity_history', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,

  // Signal predictions
  `CREATE TABLE IF NOT EXISTS signal_predictions (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(64) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    strength DECIMAL(5,4) NOT NULL,
    confidence DECIMAL(5,4) NOT NULL,
    price_at_signal DECIMAL(10,6) NOT NULL,
    resolved_at TIMESTAMPTZ,
    price_at_resolution DECIMAL(10,6),
    was_correct BOOLEAN,
    pnl_pct DECIMAL(10,6),
    order_id INTEGER,
    metadata JSONB DEFAULT '{}',
    PRIMARY KEY (time, id)
  )`,
  `SELECT create_hypertable('signal_predictions', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_predictions_market ON signal_predictions (market_id, time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_predictions_type ON signal_predictions (signal_type, time DESC)`,

  // Signal weights history
  `CREATE TABLE IF NOT EXISTS signal_weights_history (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signal_type VARCHAR(50) NOT NULL,
    weight DECIMAL(5,4) NOT NULL,
    accuracy_7d DECIMAL(5,4),
    accuracy_30d DECIMAL(5,4),
    avg_pnl_7d DECIMAL(10,6),
    avg_pnl_30d DECIMAL(10,6),
    sharpe_7d DECIMAL(10,6),
    previous_weight DECIMAL(5,4),
    change_reason VARCHAR(100),
    PRIMARY KEY (time, signal_type)
  )`,
  `SELECT create_hypertable('signal_weights_history', 'time', chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE)`,

  // Signal weights current (already created, skip if exists)
  `CREATE TABLE IF NOT EXISTS signal_weights_current (
    signal_type VARCHAR(50) PRIMARY KEY,
    weight DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    accuracy_7d DECIMAL(5,4),
    accuracy_30d DECIMAL(5,4),
    total_predictions INTEGER DEFAULT 0,
    min_weight DECIMAL(5,4) DEFAULT 0.1,
    max_weight DECIMAL(5,4) DEFAULT 0.9
  )`,
  `INSERT INTO signal_weights_current (signal_type, weight)
   VALUES ('momentum', 0.5), ('mean_reversion', 0.5), ('whale_following', 0.5), ('volume_spike', 0.5), ('sentiment', 0.5)
   ON CONFLICT DO NOTHING`,
];

async function runSchema() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable not set');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected successfully!');
    console.log('Executing schema...');

    let success = 0, errors = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        success++;
        process.stdout.write('.');
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          process.stdout.write('s');
        } else {
          console.error(`\nError: ${err.message.substring(0, 100)}`);
          errors++;
        }
      }
    }

    console.log(`\n\nSchema complete! Success: ${success}, Errors: ${errors}`);

    // List tables
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    console.log(`\nTables (${res.rows.length}):`);
    res.rows.forEach(r => console.log(`  - ${r.table_name}`));

    // List hypertables
    const hyper = await client.query("SELECT hypertable_name FROM timescaledb_information.hypertables");
    console.log(`\nHypertables (${hyper.rows.length}):`);
    hyper.rows.forEach(r => console.log(`  - ${r.hypertable_name}`));

  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nDone.');
  }
}

runSchema();

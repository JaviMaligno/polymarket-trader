const { Client } = require('pg');

// Additional tables needed by repositories.ts
const statements = [
  // signal_weights - expected by signalWeightsRepo
  `CREATE TABLE IF NOT EXISTS signal_weights (
    signal_type VARCHAR(50) PRIMARY KEY,
    weight DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    is_enabled BOOLEAN DEFAULT TRUE,
    min_confidence DECIMAL(5,4) DEFAULT 0.6,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `INSERT INTO signal_weights (signal_type, weight, is_enabled)
   VALUES
     ('momentum', 0.5, true),
     ('mean_reversion', 0.5, true),
     ('whale_following', 0.5, true),
     ('volume_spike', 0.5, true),
     ('sentiment', 0.5, true)
   ON CONFLICT DO NOTHING`,

  // paper_trades - expected by paperTradesRepo (hypertable)
  `CREATE TABLE IF NOT EXISTS paper_trades (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_id VARCHAR(64) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    side VARCHAR(4) NOT NULL,
    requested_size DECIMAL(20,6) NOT NULL,
    executed_size DECIMAL(20,6),
    requested_price DECIMAL(10,6),
    executed_price DECIMAL(10,6),
    slippage_pct DECIMAL(10,6),
    fee DECIMAL(20,6) DEFAULT 0,
    value_usd DECIMAL(20,6),
    signal_id INTEGER,
    signal_type VARCHAR(50),
    order_type VARCHAR(10) DEFAULT 'market',
    fill_type VARCHAR(10) DEFAULT 'full',
    rejection_reason TEXT,
    best_bid DECIMAL(10,6),
    best_ask DECIMAL(10,6),
    PRIMARY KEY (time, id)
  )`,
  `SELECT create_hypertable('paper_trades', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
  `CREATE INDEX IF NOT EXISTS idx_paper_trades_market ON paper_trades (market_id, time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_paper_trades_signal ON paper_trades (signal_type, time DESC)`,

  // Update paper_positions - add missing columns
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS current_price DECIMAL(10,6)`,
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS unrealized_pnl_pct DECIMAL(10,6)`,
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS stop_loss DECIMAL(10,6)`,
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS take_profit DECIMAL(10,6)`,
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS signal_type VARCHAR(50)`,
  `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

  // Drop the UNIQUE constraint on (market_id, token_id) and add on market_id only
  // The repository uses ON CONFLICT (market_id)
  `ALTER TABLE paper_positions DROP CONSTRAINT IF EXISTS paper_positions_market_id_token_id_key`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_positions_market_id_key') THEN
       ALTER TABLE paper_positions ADD CONSTRAINT paper_positions_market_id_key UNIQUE (market_id);
     END IF;
   END $$`,

  // portfolio_snapshots - expected by portfolioSnapshotsRepo (hypertable)
  `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    time TIMESTAMPTZ NOT NULL PRIMARY KEY,
    initial_capital DECIMAL(20,6) NOT NULL,
    current_capital DECIMAL(20,6) NOT NULL,
    available_capital DECIMAL(20,6) NOT NULL,
    total_pnl DECIMAL(20,6) NOT NULL,
    total_pnl_pct DECIMAL(10,6) NOT NULL,
    daily_pnl DECIMAL(20,6),
    max_drawdown DECIMAL(10,6),
    current_drawdown DECIMAL(10,6),
    sharpe_ratio DECIMAL(10,6),
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    win_rate DECIMAL(10,6),
    avg_win DECIMAL(20,6),
    avg_loss DECIMAL(20,6),
    profit_factor DECIMAL(10,6),
    open_positions INTEGER DEFAULT 0,
    total_exposure DECIMAL(20,6)
  )`,
  `SELECT create_hypertable('portfolio_snapshots', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)`,

  // trading_config - key-value store for config
  `CREATE TABLE IF NOT EXISTS trading_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // Insert default config values
  `INSERT INTO trading_config (key, value, description)
   VALUES
     ('initial_capital', '10000', 'Starting paper trading capital'),
     ('fee_rate', '0.001', 'Trading fee rate (0.1%)'),
     ('max_position_size', '0.1', 'Max position as fraction of capital'),
     ('max_drawdown', '0.15', 'Maximum allowed drawdown before stopping'),
     ('min_signal_confidence', '0.6', 'Minimum confidence to act on signal')
   ON CONFLICT DO NOTHING`,

  // Update signal_weights_history to match repo expectations (add reason column alias)
  `ALTER TABLE signal_weights_history ADD COLUMN IF NOT EXISTS reason VARCHAR(100)`,
  `UPDATE signal_weights_history SET reason = change_reason WHERE reason IS NULL AND change_reason IS NOT NULL`,
];

async function addMissingTables() {
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
    console.log('Adding missing tables...');

    let success = 0, errors = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        success++;
        process.stdout.write('.');
      } catch (err) {
        if (err.message.includes('already exists') ||
            err.message.includes('duplicate') ||
            err.message.includes('already a hypertable')) {
          process.stdout.write('s');
        } else {
          console.error(`\nError: ${err.message.substring(0, 150)}`);
          errors++;
        }
      }
    }

    console.log(`\n\nDone! Success: ${success}, Errors: ${errors}`);

    // List tables
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    console.log(`\nTables (${res.rows.length}):`);
    res.rows.forEach(r => console.log(`  - ${r.table_name}`));

  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nConnection closed.');
  }
}

addMissingTables();

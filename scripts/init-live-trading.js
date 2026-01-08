/**
 * Initialize Live Trading with Real Markets
 *
 * This script:
 * 1. Loads active market IDs from the database
 * 2. Subscribes the LiveDataFeed to these markets
 * 3. Creates and registers a strategy with optimized parameters
 * 4. Starts the strategy for signal generation
 */

const pg = require('pg');

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL || 'https://polymarket-dashboard-api.onrender.com';
const DATABASE_URL = process.env.DATABASE_URL;

// Disable SSL verification for TimescaleDB
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Best parameters from optimization
const OPTIMIZED_PARAMS = {
  minEdge: 0.03,
  minConfidence: 0.43,
};

async function main() {
  console.log('=== Initializing Live Trading ===\n');

  // 1. Load active markets from database
  console.log('Loading active markets from database...');
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Get markets with recent price data and good liquidity
    // Use condition_id (hex) as that's what Polymarket API expects
    const marketsResult = await pool.query(`
      SELECT DISTINCT m.condition_id, m.question, m.volume_24h, m.liquidity
      FROM markets m
      JOIN price_history ph ON m.id = ph.market_id
      WHERE ph.time > NOW() - INTERVAL '24 hours'
        AND m.is_active = true
        AND m.condition_id IS NOT NULL
      GROUP BY m.condition_id, m.question, m.volume_24h, m.liquidity
      HAVING COUNT(*) >= 20
      ORDER BY m.volume_24h DESC NULLS LAST
      LIMIT 50
    `);

    const markets = marketsResult.rows;
    console.log(`Found ${markets.length} active markets with recent data\n`);

    if (markets.length === 0) {
      console.log('No markets found! Check data collector.');
      return;
    }

    // Show top markets
    console.log('Top markets by volume:');
    markets.slice(0, 5).forEach(m => {
      console.log(`  - ${(m.question || 'Unknown').slice(0, 50)}...`);
    });

    // 2. Subscribe markets to the feed
    console.log('\nSubscribing markets to LiveDataFeed...');
    // Use condition_id for Polymarket API
    const marketIds = markets.map(m => m.condition_id);

    const subscribeRes = await fetch(`${DASHBOARD_API_URL}/api/feed/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds }),
    });

    if (subscribeRes.ok) {
      const result = await subscribeRes.json();
      console.log(`✓ Subscribed to ${result.data?.subscribed || marketIds.length} markets`);
    } else {
      // Try individual subscriptions if bulk fails
      console.log('Bulk subscribe not available, trying individual...');
      for (const marketId of marketIds.slice(0, 10)) {
        try {
          await fetch(`${DASHBOARD_API_URL}/api/feed/subscribe/${marketId}`, {
            method: 'POST',
          });
        } catch (e) {
          // Ignore individual errors
        }
      }
    }

    // 3. Create strategy with optimized parameters
    console.log('\nCreating optimized strategy...');
    const strategyConfig = {
      name: 'optimized-live-v1',
      type: 'combo', // Uses both momentum and mean_reversion
      minEdge: OPTIMIZED_PARAMS.minEdge,
      minConfidence: OPTIMIZED_PARAMS.minConfidence,
      disableFilters: true, // Allow all markets initially
    };

    const createRes = await fetch(`${DASHBOARD_API_URL}/api/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(strategyConfig),
    });

    let strategyId = null;
    if (createRes.ok) {
      const result = await createRes.json();
      strategyId = result.data?.id;
      console.log(`✓ Strategy created: ${strategyId || result.data?.name}`);
    } else {
      const error = await createRes.text();
      console.log('Strategy creation response:', error.slice(0, 200));
    }

    // 4. Start the strategy
    if (strategyId) {
      console.log('\nStarting strategy...');
      const startRes = await fetch(`${DASHBOARD_API_URL}/api/strategies/${strategyId}/start`, {
        method: 'POST',
      });

      if (startRes.ok) {
        console.log('✓ Strategy started');
      } else {
        const error = await startRes.text();
        console.log('Start response:', error.slice(0, 100));
      }
    }

    // 5. Check final status
    console.log('\nChecking system status...');
    const statusRes = await fetch(`${DASHBOARD_API_URL}/api/status`);
    const status = await statusRes.json();

    console.log('\n=== System Status ===');
    console.log('  Connected:', status.data?.isConnected);
    console.log('  Trading:', status.data?.isTrading);
    console.log('  Active Strategies:', status.data?.activeStrategies);
    console.log('  Equity:', '$' + (status.data?.equity || 0).toFixed(2));

    // 6. Check feed status
    const feedRes = await fetch(`${DASHBOARD_API_URL}/api/feed/status`);
    if (feedRes.ok) {
      const feedStatus = await feedRes.json();
      console.log('\n=== Feed Status ===');
      console.log('  Status:', feedStatus.data?.status);
      console.log('  Subscriptions:', feedStatus.data?.subscriptions?.length || 0);
    }

    console.log('\n=== Initialization Complete ===');
    console.log('\nMonitor signals at: GET /api/signal-predictions');
    console.log('Monitor trades at: GET /api/paper-trades');

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Initialization failed:', err.message);
  process.exit(1);
});

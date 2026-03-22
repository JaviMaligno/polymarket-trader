// scripts/check-execution-quality.js
// Monitor realistic paper execution quality after deploying OrderBookExecutionSimulator
//
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/check-execution-quality.js

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Fill source distribution
  const sources = await pool.query(`
    SELECT fill_source, COUNT(*) as trades,
           ROUND(AVG(slippage_pct)::numeric, 4) as avg_slippage_pct,
           ROUND(AVG(snapshot_age_ms)::numeric, 0) as avg_snapshot_age_ms,
           COUNT(CASE WHEN executed_size < requested_size THEN 1 END) as partial_fills
    FROM paper_trades
    WHERE fill_source IS NOT NULL AND fill_source != 'legacy'
    GROUP BY fill_source;
  `);
  console.log('\n=== Fill Source Distribution ===');
  console.table(sources.rows);

  // Legacy vs new trades
  const legacy = await pool.query(`
    SELECT
      COUNT(CASE WHEN fill_source = 'legacy' OR fill_source IS NULL THEN 1 END) as legacy_trades,
      COUNT(CASE WHEN fill_source IS NOT NULL AND fill_source != 'legacy' THEN 1 END) as simulated_trades
    FROM paper_trades;
  `);
  console.log('\n=== Legacy vs Simulated ===');
  console.table(legacy.rows);

  // Slippage histogram
  const slippage = await pool.query(`
    SELECT
      CASE
        WHEN slippage_pct < 0.5 THEN '<0.5%'
        WHEN slippage_pct < 1.0 THEN '0.5-1%'
        WHEN slippage_pct < 2.0 THEN '1-2%'
        WHEN slippage_pct < 5.0 THEN '2-5%'
        ELSE '>5%'
      END as bucket,
      COUNT(*) as count
    FROM paper_trades
    WHERE slippage_pct IS NOT NULL AND fill_source != 'legacy'
    GROUP BY 1 ORDER BY MIN(slippage_pct);
  `);
  console.log('\n=== Slippage Distribution ===');
  console.table(slippage.rows);

  // Recent trades with execution data
  const recent = await pool.query(`
    SELECT
      LEFT(market_id, 12) as market,
      side,
      requested_size as req,
      executed_size as exec,
      ROUND(requested_price::numeric, 4) as req_price,
      ROUND(executed_price::numeric, 4) as exec_price,
      ROUND(slippage_pct::numeric, 3) as slip_pct,
      fill_source as source,
      snapshot_age_ms as snap_ms,
      time::timestamp(0)
    FROM paper_trades
    WHERE fill_source IS NOT NULL AND fill_source != 'legacy'
    ORDER BY time DESC LIMIT 10;
  `);
  console.log('\n=== Recent Simulated Trades ===');
  console.table(recent.rows);

  await pool.end();
}

main().catch(console.error);

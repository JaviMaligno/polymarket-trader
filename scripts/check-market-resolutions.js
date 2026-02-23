const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkMarketResolutions() {
  console.log('=== CHECKING MARKET RESOLUTIONS ===\n');

  // Get recent trades with extreme price movements
  const extremeMoves = await pool.query(`
    SELECT
      pt.market_id,
      pt.executed_price as entry_price,
      pt.time as entry_time,
      m.question,
      m.current_price_yes,
      m.current_price_no,
      m.is_active,
      m.is_resolved,
      m.end_date,
      ((m.current_price_yes - pt.executed_price) / pt.executed_price * 100) as price_change_pct
    FROM paper_trades pt
    JOIN markets m ON pt.market_id = m.id OR pt.market_id = m.condition_id
    WHERE pt.time > NOW() - INTERVAL '24 hours'
      AND pt.side = 'buy'
    ORDER BY ABS((m.current_price_yes - pt.executed_price) / pt.executed_price) DESC
    LIMIT 20
  `);

  console.log('=== TRADES WITH EXTREME PRICE MOVEMENTS ===\n');

  let resolvedCount = 0;
  let unresolvedCount = 0;

  for (const r of extremeMoves.rows) {
    const entry = parseFloat(r.entry_price);
    const current = parseFloat(r.current_price_yes);
    const change = ((current - entry) / entry * 100);
    const isResolved = current <= 0.02 || current >= 0.98;

    if (isResolved) resolvedCount++;
    else unresolvedCount++;

    console.log(`Market: ${(r.question || 'Unknown').substring(0, 50)}...`);
    console.log(`  Entry: $${entry.toFixed(4)} | Current: $${current.toFixed(4)} | Change: ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`);
    console.log(`  Active: ${r.is_active} | Resolved: ${r.is_resolved} | End: ${r.end_date ? new Date(r.end_date).toLocaleDateString() : 'N/A'}`);
    console.log(`  ${isResolved ? '⚠️ LIKELY RESOLVED (price at extreme)' : '✓ Normal price movement'}`);
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`Trades in resolved markets: ${resolvedCount}`);
  console.log(`Trades in normal markets: ${unresolvedCount}`);

  // Check markets with prices at extremes (near resolution)
  const nearResolution = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE current_price_yes <= 0.05 OR current_price_yes >= 0.95) as extreme
    FROM markets
    WHERE is_active = true
  `);

  console.log(`\n=== ACTIVE MARKETS ANALYSIS ===`);
  console.log(`Total active: ${nearResolution.rows[0].total}`);
  console.log(`At extreme prices (≤5% or ≥95%): ${nearResolution.rows[0].extreme}`);

  // Check what price range we're trading in
  const tradePrices = await pool.query(`
    SELECT
      CASE
        WHEN executed_price <= 0.10 THEN '0-10%'
        WHEN executed_price <= 0.20 THEN '10-20%'
        WHEN executed_price <= 0.30 THEN '20-30%'
        WHEN executed_price <= 0.70 THEN '30-70%'
        WHEN executed_price <= 0.80 THEN '70-80%'
        WHEN executed_price <= 0.90 THEN '80-90%'
        ELSE '90-100%'
      END as price_range,
      COUNT(*) as cnt,
      AVG(value_usd) as avg_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND side = 'buy'
    GROUP BY 1
    ORDER BY 1
  `);

  console.log('\n=== TRADE DISTRIBUTION BY PRICE RANGE ===');
  tradePrices.rows.forEach(r => {
    console.log(`  ${r.price_range}: ${r.cnt} trades (avg $${parseFloat(r.avg_value).toFixed(2)})`);
  });

  await pool.end();
}

checkMarketResolutions().catch(e => { console.error(e); process.exit(1); });

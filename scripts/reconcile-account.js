const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=disable')
    ? false
    : { rejectUnauthorized: false },
});

async function reconcile() {
  // ─────────────────────────────────────────────────────────
  // 1. Current account state
  // ─────────────────────────────────────────────────────────
  console.log('=== 1. CURRENT ACCOUNT STATE ===\n');

  const account = await pool.query('SELECT * FROM paper_account WHERE id = 1');
  if (account.rows.length === 0) {
    console.error('No paper_account row with id=1 found.');
    await pool.end();
    return;
  }
  const a = account.rows[0];

  console.table({
    initial_capital: parseFloat(a.initial_capital).toFixed(2),
    current_capital: parseFloat(a.current_capital).toFixed(2),
    available_capital: parseFloat(a.available_capital).toFixed(2),
    total_realized_pnl: parseFloat(a.total_realized_pnl).toFixed(2),
    total_fees_paid: parseFloat(a.total_fees_paid).toFixed(2),
    total_trades: parseInt(a.total_trades),
    winning_trades: parseInt(a.winning_trades),
    losing_trades: parseInt(a.losing_trades),
  });

  // ─────────────────────────────────────────────────────────
  // 2. Sum all trades
  // ─────────────────────────────────────────────────────────
  console.log('\n=== 2. SUM ALL TRADES ===\n');

  const buys = await pool.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(value_usd), 0) as total_value, COALESCE(SUM(fee), 0) as total_fee
    FROM paper_trades WHERE side = 'buy'
  `);
  const sells = await pool.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(value_usd), 0) as total_value, COALESCE(SUM(fee), 0) as total_fee
    FROM paper_trades WHERE side = 'sell'
  `);

  const buyCount = parseInt(buys.rows[0].count);
  const buyTotal = parseFloat(buys.rows[0].total_value);
  const buyFees = parseFloat(buys.rows[0].total_fee);
  const sellCount = parseInt(sells.rows[0].count);
  const sellTotal = parseFloat(sells.rows[0].total_value);
  const sellFees = parseFloat(sells.rows[0].total_fee);
  const totalFees = buyFees + sellFees;

  console.table({
    'BUY trades': { count: buyCount, total_value_usd: '$' + buyTotal.toFixed(2), total_fee: '$' + buyFees.toFixed(2) },
    'SELL trades': { count: sellCount, total_value_usd: '$' + sellTotal.toFixed(2), total_fee: '$' + sellFees.toFixed(2) },
  });

  // ─────────────────────────────────────────────────────────
  // 3. Expected capital vs actual
  // ─────────────────────────────────────────────────────────
  console.log('\n=== 3. EXPECTED CAPITAL ===\n');

  const initialCapital = parseFloat(a.initial_capital);
  const expectedCapital = initialCapital - buyTotal + sellTotal - totalFees;
  const actualCapital = parseFloat(a.current_capital);
  const difference = actualCapital - expectedCapital;

  console.log('Formula: initial_capital - buyTotal + sellTotal - totalFees');
  console.log(`  ${initialCapital.toFixed(2)} - ${buyTotal.toFixed(2)} + ${sellTotal.toFixed(2)} - ${totalFees.toFixed(2)}`);
  console.log('');
  console.log('Expected capital (from trades):', '$' + expectedCapital.toFixed(2));
  console.log('Actual current_capital (DB):   ', '$' + actualCapital.toFixed(2));
  console.log('Difference (actual - expected): ', '$' + difference.toFixed(2));
  if (Math.abs(difference) > 1) {
    console.log('  ** MISMATCH DETECTED **');
  } else {
    console.log('  (OK - within $1 tolerance)');
  }

  // ─────────────────────────────────────────────────────────
  // 4. Open positions
  // ─────────────────────────────────────────────────────────
  console.log('\n=== 4. OPEN POSITIONS ===\n');

  const openPos = await pool.query(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(size * avg_entry_price), 0) as capital_locked
    FROM paper_positions
    WHERE closed_at IS NULL AND size > 0
  `);
  const openCount = parseInt(openPos.rows[0].count);
  const capitalLocked = parseFloat(openPos.rows[0].capital_locked);

  console.log('Open positions count:', openCount);
  console.log('Capital locked (SUM(size * avg_entry_price)):', '$' + capitalLocked.toFixed(2));

  // ─────────────────────────────────────────────────────────
  // 5. Orphaned BUYs
  // ─────────────────────────────────────────────────────────
  console.log('\n=== 5. ORPHANED BUYS ===\n');
  console.log('Buy trades with no matching sell AND no open position:\n');

  const orphans = await pool.query(`
    WITH buy_trades AS (
      SELECT
        id, time, market_id, token_id, value_usd, executed_size, executed_price
      FROM paper_trades
      WHERE side = 'buy'
    ),
    matched_sells AS (
      SELECT DISTINCT bt.id as buy_id
      FROM buy_trades bt
      INNER JOIN paper_trades st
        ON st.market_id = bt.market_id
        AND st.token_id = bt.token_id
        AND st.side = 'sell'
        AND st.time > bt.time
    ),
    matched_positions AS (
      SELECT DISTINCT bt.id as buy_id
      FROM buy_trades bt
      INNER JOIN paper_positions pp
        ON pp.market_id = bt.market_id
        AND pp.token_id = bt.token_id
        AND pp.closed_at IS NULL
        AND pp.size > 0
    )
    SELECT
      bt.id, bt.time, bt.market_id, bt.token_id, bt.value_usd, bt.executed_size, bt.executed_price
    FROM buy_trades bt
    LEFT JOIN matched_sells ms ON ms.buy_id = bt.id
    LEFT JOIN matched_positions mp ON mp.buy_id = bt.id
    WHERE ms.buy_id IS NULL AND mp.buy_id IS NULL
    ORDER BY bt.value_usd DESC
  `);

  if (orphans.rows.length === 0) {
    console.log('No orphaned buys found.');
  } else {
    const displayRows = orphans.rows.map(r => ({
      time: new Date(r.time).toISOString().replace('T', ' ').slice(0, 19),
      market_id: r.market_id?.slice(0, 30) + '...',
      value_usd: '$' + parseFloat(r.value_usd).toFixed(2),
      size: parseFloat(r.executed_size).toFixed(4),
      price: '$' + parseFloat(r.executed_price).toFixed(4),
    }));
    console.table(displayRows);

    const orphanTotal = orphans.rows.reduce((sum, r) => sum + parseFloat(r.value_usd), 0);
    console.log('Total orphaned buys:', orphans.rows.length);
    console.log('Total orphaned value:', '$' + orphanTotal.toFixed(2));
  }

  // ─────────────────────────────────────────────────────────
  // 6. Recommendation
  // ─────────────────────────────────────────────────────────
  console.log('\n=== 6. RECOMMENDATION ===\n');

  // The adjustment is the gap between expected and actual.
  // If expected > actual, we need to ADD the difference back (positive adjustment).
  // adjustment = expectedCapital - actualCapital
  const adjustment = expectedCapital - actualCapital;

  if (Math.abs(adjustment) <= 1) {
    console.log('No adjustment needed (difference within $1 tolerance).');
  } else {
    console.log(`Adjustment needed: $${adjustment.toFixed(2)}`);
    console.log('');
    console.log('Run this SQL to fix (DO NOT execute automatically):');
    console.log('');
    console.log('  UPDATE paper_account SET');
    console.log(`    current_capital = current_capital + (${adjustment.toFixed(2)}),`);
    console.log(`    available_capital = available_capital + (${adjustment.toFixed(2)})`);
    console.log('  WHERE id = 1;');
    console.log('');
    console.log('This will bring current_capital from $' + actualCapital.toFixed(2) + ' to $' + expectedCapital.toFixed(2));
  }

  console.log('\n=== RECONCILIATION COMPLETE ===');
  await pool.end();
}

reconcile().catch(e => {
  console.error('Error:', e.message);
  pool.end();
  process.exit(1);
});

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function diagnose() {
  console.log('=== DIAGNÓSTICO DE PÉRDIDAS ===\n');

  // 1. Account summary
  const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
  const a = account.rows[0];
  const capital = parseFloat(a.current_capital);
  const initial = parseFloat(a.initial_capital);
  const realized = parseFloat(a.total_realized_pnl);
  const unrealized = parseFloat(a.total_unrealized_pnl);

  console.log('=== RESUMEN CUENTA ===');
  console.log('Capital inicial:', '$' + initial.toFixed(2));
  console.log('Capital actual:', '$' + capital.toFixed(2));
  console.log('PnL realizado:', '$' + realized.toFixed(2));
  console.log('PnL no realizado:', '$' + unrealized.toFixed(2));
  console.log('Diferencia inexplicada:', '$' + (capital - initial - realized).toFixed(2));

  // 2. Closed trades analysis (realized PnL)
  console.log('\n=== TRADES CERRADOS (PnL REALIZADO) ===');
  const closedTrades = await pool.query(`
    SELECT
      side,
      COUNT(*) as count,
      SUM(value_usd) as total_value,
      SUM(fee) as total_fees,
      AVG(executed_price) as avg_price
    FROM paper_trades
    GROUP BY side
  `);
  console.table(closedTrades.rows.map(t => ({
    side: t.side,
    count: t.count,
    value: '$' + parseFloat(t.total_value || 0).toFixed(2),
    fees: '$' + parseFloat(t.total_fees || 0).toFixed(2),
    avg_price: parseFloat(t.avg_price || 0).toFixed(4)
  })));

  // 3. Open positions analysis (unrealized PnL)
  console.log('\n=== POSICIONES ABIERTAS (PnL NO REALIZADO) ===');
  const positions = await pool.query(`
    SELECT
      market_id,
      token_id,
      side,
      size,
      avg_entry_price,
      current_price,
      unrealized_pnl,
      unrealized_pnl_pct,
      opened_at
    FROM paper_positions
    WHERE size > 0 AND closed_at IS NULL
    ORDER BY unrealized_pnl ASC
    LIMIT 20
  `);

  let totalUnrealized = 0;
  let totalInvested = 0;
  let positionsInLoss = 0;
  let positionsInProfit = 0;

  console.log('Top 20 peores posiciones:');
  positions.rows.forEach(p => {
    const size = parseFloat(p.size);
    const entry = parseFloat(p.avg_entry_price);
    const current = parseFloat(p.current_price);
    const pnl = parseFloat(p.unrealized_pnl || 0);
    const invested = size * entry;

    totalUnrealized += pnl;
    totalInvested += invested;
    if (pnl < 0) positionsInLoss++;
    else positionsInProfit++;

    const pnlPct = invested > 0 ? (pnl / invested * 100) : 0;
    console.log(`  ${p.market_id.slice(0,15)}... | Entry: ${entry.toFixed(3)} | Current: ${current.toFixed(3)} | PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
  });

  // 4. Position statistics
  const posStats = await pool.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN unrealized_pnl < 0 THEN 1 ELSE 0 END) as losing,
      SUM(CASE WHEN unrealized_pnl >= 0 THEN 1 ELSE 0 END) as winning,
      SUM(unrealized_pnl) as total_unrealized,
      SUM(size * avg_entry_price) as total_invested
    FROM paper_positions
    WHERE size > 0 AND closed_at IS NULL
  `);
  const ps = posStats.rows[0];
  console.log('\n=== ESTADÍSTICAS POSICIONES ===');
  console.log('Total posiciones:', ps.total);
  console.log('En pérdida:', ps.losing);
  console.log('En ganancia:', ps.winning);
  console.log('PnL no realizado total:', '$' + parseFloat(ps.total_unrealized || 0).toFixed(2));
  console.log('Capital invertido:', '$' + parseFloat(ps.total_invested || 0).toFixed(2));

  // 5. Price movement analysis - are we buying at wrong times?
  console.log('\n=== ANÁLISIS DE TIMING ===');
  const timing = await pool.query(`
    SELECT
      p.market_id,
      p.avg_entry_price as entry,
      p.current_price as current,
      (p.current_price - p.avg_entry_price) / p.avg_entry_price * 100 as price_change_pct
    FROM paper_positions p
    WHERE p.size > 0 AND p.closed_at IS NULL
    ORDER BY (p.current_price - p.avg_entry_price) / p.avg_entry_price ASC
    LIMIT 10
  `);
  console.log('Peores movimientos de precio desde entrada:');
  timing.rows.forEach(t => {
    const change = parseFloat(t.price_change_pct);
    console.log(`  Entry: ${parseFloat(t.entry).toFixed(3)} → Current: ${parseFloat(t.current).toFixed(3)} (${change.toFixed(1)}%)`);
  });

  // 6. Check if positions are old (stale)
  console.log('\n=== ANTIGÜEDAD DE POSICIONES ===');
  const age = await pool.query(`
    SELECT
      CASE
        WHEN opened_at > NOW() - INTERVAL '1 day' THEN 'Hoy'
        WHEN opened_at > NOW() - INTERVAL '7 days' THEN '1-7 días'
        WHEN opened_at > NOW() - INTERVAL '30 days' THEN '7-30 días'
        ELSE 'Más de 30 días'
      END as age_group,
      COUNT(*) as count,
      SUM(unrealized_pnl) as total_pnl
    FROM paper_positions
    WHERE size > 0 AND closed_at IS NULL
    GROUP BY 1
    ORDER BY 1
  `);
  console.table(age.rows.map(a => ({
    edad: a.age_group,
    cantidad: a.count,
    pnl: '$' + parseFloat(a.total_pnl || 0).toFixed(2)
  })));

  // 7. Capital flow - where did the money go?
  console.log('\n=== FLUJO DE CAPITAL ===');
  const buys = await pool.query(`SELECT SUM(value_usd) as total FROM paper_trades WHERE side = 'buy'`);
  const sells = await pool.query(`SELECT SUM(value_usd) as total FROM paper_trades WHERE side = 'sell'`);
  const fees = await pool.query(`SELECT SUM(fee) as total FROM paper_trades`);

  const totalBuys = parseFloat(buys.rows[0].total || 0);
  const totalSells = parseFloat(sells.rows[0].total || 0);
  const totalFees = parseFloat(fees.rows[0].total || 0);

  console.log('Total compras:', '$' + totalBuys.toFixed(2));
  console.log('Total ventas:', '$' + totalSells.toFixed(2));
  console.log('Total fees:', '$' + totalFees.toFixed(2));
  console.log('Neto trades:', '$' + (totalSells - totalBuys - totalFees).toFixed(2));

  await pool.end();
}

diagnose().catch(e => console.error('Error:', e.message));

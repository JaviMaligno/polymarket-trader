const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function investigate() {
  // 1. Verificar todas las posiciones (abiertas y cerradas)
  console.log('=== TODAS LAS POSICIONES (últimas 48h) ===');
  const allPositions = await pool.query(`
    SELECT
      id, market_id, side, size, avg_entry_price,
      current_price, realized_pnl, unrealized_pnl,
      opened_at, closed_at
    FROM paper_positions
    WHERE opened_at > NOW() - INTERVAL '48 hours' OR closed_at > NOW() - INTERVAL '48 hours'
    ORDER BY COALESCE(closed_at, opened_at) DESC
    LIMIT 30
  `);

  console.log('Posiciones encontradas:', allPositions.rows.length);
  for (const p of allPositions.rows) {
    const status = p.closed_at ? 'CERRADA' : 'ABIERTA';
    const size = parseFloat(p.size || 0).toFixed(2);
    const entry = parseFloat(p.avg_entry_price || 0).toFixed(4);
    const pnl = parseFloat(p.realized_pnl || 0).toFixed(2);
    const opened = p.opened_at ? new Date(p.opened_at).toISOString().substring(0, 19) : 'N/A';
    const closed = p.closed_at ? new Date(p.closed_at).toISOString().substring(0, 19) : 'OPEN';
    console.log(`[${status}] Size: ${size} @ ${entry} | PnL: $${pnl} | Opened: ${opened} | Closed: ${closed}`);
  }

  // 2. Verificar posiciones cerradas recientemente
  console.log('\n=== POSICIONES CERRADAS EN 24h ===');
  const closedRecent = await pool.query(`
    SELECT
      id, market_id, size, realized_pnl, closed_at
    FROM paper_positions
    WHERE closed_at > NOW() - INTERVAL '24 hours'
    ORDER BY closed_at DESC
  `);

  console.log('Posiciones cerradas en 24h:', closedRecent.rows.length);
  let totalClosedPnl = 0;
  for (const p of closedRecent.rows) {
    const pnl = parseFloat(p.realized_pnl || 0);
    totalClosedPnl += pnl;
    const closed = new Date(p.closed_at).toISOString().substring(0, 19);
    console.log(`Closed: ${closed} | PnL: $${pnl.toFixed(2)} | ${p.market_id.substring(0,40)}`);
  }
  console.log('Total PnL de posiciones cerradas:', totalClosedPnl.toFixed(2));

  // 3. Ver los últimos logs de paper_account
  console.log('\n=== ESTADO ACTUAL DE CUENTA ===');
  const accountHistory = await pool.query(`
    SELECT current_capital, available_capital, total_realized_pnl, updated_at
    FROM paper_account WHERE id = 1
  `);
  const a = accountHistory.rows[0];
  console.log('Current capital:', parseFloat(a.current_capital).toFixed(2));
  console.log('Available capital:', parseFloat(a.available_capital).toFixed(2));
  console.log('Total realized PnL:', parseFloat(a.total_realized_pnl).toFixed(2));
  console.log('Updated at:', a.updated_at);

  // 4. Verificar discrepancias en trades vs posiciones
  console.log('\n=== ANÁLISIS DE TRADES (48h) ===');
  const tradeStats = await pool.query(`
    SELECT
      side,
      COUNT(*) as count,
      SUM(value_usd) as total_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '48 hours'
    GROUP BY side
  `);

  for (const t of tradeStats.rows) {
    console.log(`${t.side}: ${t.count} trades, total: $${parseFloat(t.total_value || 0).toFixed(2)}`);
  }

  // 5. Verificar mercados de los trades recientes
  console.log('\n=== MERCADOS DE COMPRAS RECIENTES ===');
  const recentMarkets = await pool.query(`
    SELECT DISTINCT pt.market_id, m.question, m.is_active, m.is_resolved
    FROM paper_trades pt
    LEFT JOIN markets m ON pt.market_id = m.id
    WHERE pt.time > NOW() - INTERVAL '24 hours' AND pt.side = 'buy'
    LIMIT 10
  `);

  for (const m of recentMarkets.rows) {
    const active = m.is_active ? 'ACTIVO' : 'INACTIVO';
    const resolved = m.is_resolved ? 'RESUELTO' : 'NO RESUELTO';
    const question = (m.question || m.market_id).substring(0, 50);
    console.log(`[${active}] [${resolved}] ${question}`);
  }

  // 6. Contar posiciones totales
  console.log('\n=== CONTEO DE POSICIONES ===');
  const positionCounts = await pool.query(`
    SELECT
      CASE WHEN closed_at IS NULL THEN 'ABIERTAS' ELSE 'CERRADAS' END as status,
      COUNT(*) as count
    FROM paper_positions
    GROUP BY CASE WHEN closed_at IS NULL THEN 'ABIERTAS' ELSE 'CERRADAS' END
  `);

  for (const p of positionCounts.rows) {
    console.log(`${p.status}: ${p.count}`);
  }

  // 7. Verificar si hay trades sin posición correspondiente
  console.log('\n=== TRADES BUY SIN POSICIÓN ABIERTA (últimas 24h) ===');
  const orphanTrades = await pool.query(`
    SELECT pt.time, pt.market_id, pt.value_usd
    FROM paper_trades pt
    WHERE pt.time > NOW() - INTERVAL '24 hours'
      AND pt.side = 'buy'
      AND NOT EXISTS (
        SELECT 1 FROM paper_positions pp
        WHERE pp.market_id = pt.market_id
          AND pp.closed_at IS NULL
      )
    ORDER BY pt.time DESC
    LIMIT 20
  `);

  console.log('Trades de compra sin posición abierta:', orphanTrades.rows.length);
  let totalOrphanValue = 0;
  for (const t of orphanTrades.rows) {
    const time = new Date(t.time).toISOString().substring(0, 19);
    const value = parseFloat(t.value_usd || 0);
    totalOrphanValue += value;
    console.log(`${time} | $${value.toFixed(2)} | ${t.market_id.substring(0,40)}`);
  }
  console.log('Total valor en trades huérfanos:', totalOrphanValue.toFixed(2));

  await pool.end();
}

investigate().catch(console.error);

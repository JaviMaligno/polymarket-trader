const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log('=== ANÁLISIS DE TRADES DESDE AYER ===\n');

  // 1. Trades recientes (últimas 48h)
  const trades = await pool.query(`
    SELECT
      time,
      side,
      executed_size,
      executed_price,
      value_usd,
      signal_type,
      fill_type,
      market_id
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '48 hours'
    ORDER BY time DESC
    LIMIT 30
  `);

  console.log('📊 ÚLTIMOS 30 TRADES (48h):');
  console.log('─'.repeat(100));
  for (const t of trades.rows) {
    const time = new Date(t.time).toISOString().replace('T', ' ').substring(0, 19);
    const signal = (t.signal_type || 'unknown').padEnd(20);
    const side = t.side.padEnd(5);
    const value = parseFloat(t.value_usd || 0).toFixed(2).padStart(10);
    const price = parseFloat(t.executed_price || 0).toFixed(4);
    console.log(`${time} | ${side} | $${value} | @${price} | ${signal}`);
  }

  // 2. Resumen por tipo de señal
  const bySignal = await pool.query(`
    SELECT
      signal_type,
      COUNT(*) as count,
      SUM(CASE WHEN side = 'buy' THEN value_usd ELSE 0 END) as total_buys,
      SUM(CASE WHEN side = 'sell' THEN value_usd ELSE 0 END) as total_sells
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY count DESC
  `);

  console.log('\n📈 DISTRIBUCIÓN POR TIPO DE SEÑAL (24h):');
  console.log('─'.repeat(60));
  for (const s of bySignal.rows) {
    const buys = parseFloat(s.total_buys || 0).toFixed(2);
    const sells = parseFloat(s.total_sells || 0).toFixed(2);
    console.log(`${(s.signal_type || 'unknown').padEnd(25)} | ${s.count} trades | Compras: $${buys} | Ventas: $${sells}`);
  }

  // 3. Trades de stop_loss y take_profit específicamente
  const stopLossTrades = await pool.query(`
    SELECT
      time,
      market_id,
      executed_price,
      value_usd,
      signal_type
    FROM paper_trades
    WHERE signal_type IN ('stop_loss', 'take_profit', 'cleanup_inactive', 'cleanup_resolved')
      AND time > NOW() - INTERVAL '48 hours'
    ORDER BY time DESC
  `);

  console.log('\n🛡️ TRADES DE PROTECCIÓN (Stop Loss / Take Profit / Cleanup):');
  console.log('─'.repeat(80));
  if (stopLossTrades.rows.length === 0) {
    console.log('No hay trades de protección en las últimas 48h');
  } else {
    for (const t of stopLossTrades.rows) {
      const time = new Date(t.time).toISOString().replace('T', ' ').substring(0, 19);
      const value = parseFloat(t.value_usd || 0).toFixed(2);
      console.log(`${time} | ${t.signal_type.padEnd(18)} | $${value}`);
    }
  }

  // 4. Estado actual de la cuenta
  const account = await pool.query(`
    SELECT
      initial_capital,
      current_capital,
      available_capital,
      total_realized_pnl,
      winning_trades,
      losing_trades,
      updated_at
    FROM paper_account
    WHERE id = 1
  `);

  if (account.rows.length > 0) {
    const a = account.rows[0];
    const pnlPct = ((parseFloat(a.current_capital) - parseFloat(a.initial_capital)) / parseFloat(a.initial_capital) * 100).toFixed(2);
    const winRate = a.winning_trades + a.losing_trades > 0
      ? (a.winning_trades / (a.winning_trades + a.losing_trades) * 100).toFixed(1)
      : 'N/A';

    console.log('\n💰 ESTADO DE LA CUENTA:');
    console.log('─'.repeat(40));
    console.log(`Capital Inicial:    $${parseFloat(a.initial_capital).toFixed(2)}`);
    console.log(`Capital Actual:     $${parseFloat(a.current_capital).toFixed(2)}`);
    console.log(`Capital Disponible: $${parseFloat(a.available_capital).toFixed(2)}`);
    console.log(`PnL Realizado:      $${parseFloat(a.total_realized_pnl).toFixed(2)} (${pnlPct}%)`);
    console.log(`Trades Ganadores:   ${a.winning_trades}`);
    console.log(`Trades Perdedores:  ${a.losing_trades}`);
    console.log(`Win Rate:           ${winRate}%`);
    console.log(`Última actualización: ${new Date(a.updated_at).toISOString().replace('T', ' ').substring(0, 19)}`);
  }

  // 5. Posiciones abiertas actuales
  const positions = await pool.query(`
    SELECT
      pp.market_id,
      pp.side,
      pp.size,
      pp.avg_entry_price,
      pp.current_price,
      pp.unrealized_pnl,
      pp.unrealized_pnl_pct,
      pp.opened_at,
      m.question,
      m.is_active
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id
    WHERE pp.closed_at IS NULL
    ORDER BY pp.opened_at DESC
  `);

  console.log(`\n📂 POSICIONES ABIERTAS (${positions.rows.length}):`);
  console.log('─'.repeat(100));

  let totalUnrealizedPnl = 0;
  let totalInvested = 0;

  for (const p of positions.rows) {
    const question = (p.question || p.market_id).substring(0, 50);
    const size = parseFloat(p.size || 0);
    const entry = parseFloat(p.avg_entry_price || 0);
    const current = parseFloat(p.current_price || entry);
    const invested = size * entry;
    const unrealized = parseFloat(p.unrealized_pnl || 0);
    const pnlPct = parseFloat(p.unrealized_pnl_pct || 0);
    const status = p.is_active ? '✅' : '❌';

    totalUnrealizedPnl += unrealized;
    totalInvested += invested;

    console.log(`${status} ${question}...`);
    console.log(`   Entry: @${entry.toFixed(4)} | Current: @${current.toFixed(4)} | Invested: $${invested.toFixed(2)} | PnL: $${unrealized.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
  }

  console.log('─'.repeat(100));
  console.log(`TOTAL INVERTIDO: $${totalInvested.toFixed(2)}`);
  console.log(`TOTAL PNL NO REALIZADO: $${totalUnrealizedPnl.toFixed(2)}`);

  // 6. Resumen de trades por hora (últimas 24h)
  const hourly = await pool.query(`
    SELECT
      date_trunc('hour', time) as hour,
      COUNT(*) as count,
      SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) as buys,
      SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) as sells,
      SUM(value_usd) as total_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', time)
    ORDER BY hour DESC
  `);

  console.log('\n⏰ ACTIVIDAD POR HORA (24h):');
  console.log('─'.repeat(70));
  for (const h of hourly.rows) {
    const hour = new Date(h.hour).toISOString().replace('T', ' ').substring(0, 16);
    const value = parseFloat(h.total_value || 0).toFixed(2);
    console.log(`${hour} | ${h.count} trades (${h.buys}B/${h.sells}S) | Total: $${value}`);
  }

  await pool.end();
}

analyze().catch(console.error);

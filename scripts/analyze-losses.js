const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log('=== ANÁLISIS DE PÉRDIDAS ===\n');

  // 1. Trade analysis
  console.log('1. ANÁLISIS DE TRADES:');
  const tradeStats = await pool.query(`
    SELECT
      side,
      COUNT(*) as count,
      AVG(executed_price::numeric) as avg_price,
      SUM(executed_size::numeric * executed_price::numeric) as total_value
    FROM paper_trades
    WHERE time > CURRENT_DATE
    GROUP BY side
  `);
  tradeStats.rows.forEach(r => {
    console.log('  ' + r.side.toUpperCase() + ': ' + r.count + ' trades, avg price: $' + parseFloat(r.avg_price).toFixed(4) + ', total value: $' + parseFloat(r.total_value).toFixed(2));
  });

  // 2. Check buy vs sell prices
  console.log('\n2. PATRÓN DE PRECIOS:');
  const pricePattern = await pool.query(`
    SELECT
      side,
      MIN(executed_price::numeric) as min_price,
      MAX(executed_price::numeric) as max_price,
      AVG(executed_price::numeric) as avg_price
    FROM paper_trades
    WHERE time > CURRENT_DATE
    GROUP BY side
  `);
  pricePattern.rows.forEach(r => {
    console.log('  ' + r.side.toUpperCase() + ': min=$' + parseFloat(r.min_price).toFixed(4) + ', max=$' + parseFloat(r.max_price).toFixed(4) + ', avg=$' + parseFloat(r.avg_price).toFixed(4));
  });

  // 3. Signal quality
  console.log('\n3. CALIDAD DE SEÑALES:');
  const signals = await pool.query(`
    SELECT direction, strength, confidence
    FROM signal_predictions
    WHERE time > CURRENT_DATE
    ORDER BY time DESC
  `);
  let longCount = 0, shortCount = 0;
  signals.rows.forEach(s => {
    if (s.direction === 'long' || s.direction === 'LONG') longCount++;
    else if (s.direction === 'short' || s.direction === 'SHORT') shortCount++;
  });
  console.log('  LONG: ' + longCount + ', SHORT: ' + shortCount);
  console.log('  Sesgo: ' + (longCount > shortCount * 3 ? 'MUY ALCISTA (posible problema)' : 'Normal'));

  // 4. Check optimization results
  console.log('\n4. OPTIMIZACIONES RECIENTES:');
  const opts = await pool.query(`
    SELECT time, sharpe_ratio, total_return, win_rate, is_applied
    FROM optimization_results
    ORDER BY time DESC
    LIMIT 5
  `);
  if (opts.rows.length === 0) {
    console.log('  No hay resultados de optimización en la base de datos');
  } else {
    opts.rows.forEach(o => {
      console.log('  ' + o.time.toISOString().substring(0,16) + ' | Sharpe: ' + parseFloat(o.sharpe_ratio || 0).toFixed(2) + ' | Return: ' + (parseFloat(o.total_return || 0) * 100).toFixed(1) + '% | Applied: ' + o.is_applied);
    });
  }

  // 5. Current signal weights
  console.log('\n5. PESOS DE SEÑALES:');
  const weights = await pool.query('SELECT signal_type, weight, is_enabled FROM signal_weights ORDER BY weight DESC');
  weights.rows.forEach(w => {
    console.log('  ' + w.signal_type.padEnd(10) + ': ' + parseFloat(w.weight).toFixed(2) + ' (enabled: ' + w.is_enabled + ')');
  });

  // 6. Trading config
  console.log('\n6. CONFIGURACIÓN DE TRADING:');
  const config = await pool.query("SELECT key, value FROM trading_config");
  config.rows.forEach(c => {
    console.log('  ' + c.key + ': ' + (c.value ? c.value.substring(0, 80) : 'null'));
  });

  // 7. Market performance
  console.log('\n7. RENDIMIENTO POR MERCADO (top 5):');
  const marketPerf = await pool.query(`
    SELECT
      SUBSTRING(market_id, 1, 50) as market,
      COUNT(*) as trades,
      SUM(CASE WHEN side = 'buy' THEN executed_size::numeric * executed_price::numeric ELSE 0 END) as bought,
      SUM(CASE WHEN side = 'sell' THEN executed_size::numeric * executed_price::numeric ELSE 0 END) as sold
    FROM paper_trades
    WHERE time > CURRENT_DATE
    GROUP BY market_id
    ORDER BY trades DESC
    LIMIT 5
  `);
  marketPerf.rows.forEach(m => {
    const bought = parseFloat(m.bought || 0);
    const sold = parseFloat(m.sold || 0);
    const netFlow = sold - bought;
    console.log('  ' + m.market + '...');
    console.log('    Trades: ' + m.trades + ', Comprado: $' + bought.toFixed(2) + ', Vendido: $' + sold.toFixed(2) + ', Neto: $' + netFlow.toFixed(2));
  });

  // 8. Check if positions are being closed or left open
  console.log('\n8. PROBLEMA DE POSICIONES:');
  const openPos = await pool.query('SELECT COUNT(*) as cnt FROM paper_positions WHERE closed_at IS NULL');
  const closedPos = await pool.query('SELECT COUNT(*) as cnt FROM paper_positions WHERE closed_at IS NOT NULL');
  console.log('  Posiciones abiertas: ' + openPos.rows[0].cnt);
  console.log('  Posiciones cerradas: ' + closedPos.rows[0].cnt);

  // 9. Check executor thresholds
  console.log('\n9. UMBRALES DEL EXECUTOR:');
  const execConfig = await pool.query("SELECT key, value FROM trading_config WHERE key LIKE '%executor%' OR key LIKE '%threshold%' OR key LIKE '%min_%'");
  if (execConfig.rows.length === 0) {
    console.log('  No hay configuración de umbrales en DB (usa valores por defecto del código)');
  } else {
    execConfig.rows.forEach(c => console.log('  ' + c.key + ': ' + c.value));
  }

  await pool.end();
}

analyze().catch(e => {
  console.error('Error:', e.message);
  pool.end();
});

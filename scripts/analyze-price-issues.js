const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log('=== ANÁLISIS COMPLETO DE PRECIOS ===\n');

  // 1. Distribution of signal prices
  console.log('1. DISTRIBUCIÓN DE PRECIOS EN SEÑALES (últimas 24h):');
  const signalPrices = await pool.query(`
    SELECT
      CASE
        WHEN price_at_signal >= 0.95 THEN '0.95-1.00 (muy alto)'
        WHEN price_at_signal >= 0.80 THEN '0.80-0.95 (alto)'
        WHEN price_at_signal >= 0.50 THEN '0.50-0.80 (medio-alto)'
        WHEN price_at_signal >= 0.20 THEN '0.20-0.50 (medio-bajo)'
        WHEN price_at_signal >= 0.05 THEN '0.05-0.20 (bajo)'
        ELSE '0.00-0.05 (muy bajo)'
      END as rango,
      direction,
      COUNT(*) as count,
      AVG(strength) as avg_strength
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  signalPrices.rows.forEach(r => {
    console.log('  ' + r.rango.padEnd(25) + ' | ' + r.direction.padEnd(6) + ' | ' + r.count + ' señales | avg_str: ' + parseFloat(r.avg_strength).toFixed(3));
  });

  // 2. Trades by price range
  console.log('\n2. TRADES POR RANGO DE PRECIO (últimas 24h):');
  const tradePrices = await pool.query(`
    SELECT
      CASE
        WHEN executed_price >= 0.95 THEN '0.95-1.00 (muy alto)'
        WHEN executed_price >= 0.80 THEN '0.80-0.95 (alto)'
        WHEN executed_price >= 0.50 THEN '0.50-0.80 (medio-alto)'
        WHEN executed_price >= 0.20 THEN '0.20-0.50 (medio-bajo)'
        WHEN executed_price >= 0.05 THEN '0.05-0.20 (bajo)'
        ELSE '0.00-0.05 (muy bajo)'
      END as rango,
      side,
      COUNT(*) as count,
      SUM(executed_size * executed_price) as total_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  tradePrices.rows.forEach(r => {
    console.log('  ' + r.rango.padEnd(25) + ' | ' + r.side.padEnd(4) + ' | ' + r.count + ' trades | $' + parseFloat(r.total_value).toFixed(2));
  });

  // 3. Check extreme price trades specifically
  console.log('\n3. TRADES EN PRECIOS EXTREMOS (>=0.95 o <=0.05):');
  const extremeTrades = await pool.query(`
    SELECT
      time,
      side,
      executed_price::numeric as price,
      executed_size::numeric as size,
      (executed_size * executed_price)::numeric as value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND (executed_price >= 0.95 OR executed_price <= 0.05)
    ORDER BY time DESC
    LIMIT 15
  `);
  if (extremeTrades.rows.length === 0) {
    console.log('  No hay trades en precios extremos');
  } else {
    let totalExtremeValue = 0;
    extremeTrades.rows.forEach(t => {
      totalExtremeValue += parseFloat(t.value);
      console.log('  ' + t.time.toISOString().substring(11,19) + ' | ' + t.side + ' @ $' + parseFloat(t.price).toFixed(4) + ' | size: ' + parseFloat(t.size).toFixed(0) + ' | value: $' + parseFloat(t.value).toFixed(2));
    });
    console.log('  TOTAL EN PRECIOS EXTREMOS: $' + totalExtremeValue.toFixed(2));
  }

  // 4. Check if we have spread data
  console.log('\n4. ¿TENEMOS DATOS DE SPREAD (bid/ask)?');
  const spreadData = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE best_bid IS NOT NULL) as with_bid,
      COUNT(*) FILTER (WHERE best_ask IS NOT NULL) as with_ask
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
  `);
  const sd = spreadData.rows[0];
  console.log('  Total trades: ' + sd.total);
  console.log('  Con bid data: ' + sd.with_bid + ' (' + (sd.with_bid/sd.total*100).toFixed(1) + '%)');
  console.log('  Con ask data: ' + sd.with_ask + ' (' + (sd.with_ask/sd.total*100).toFixed(1) + '%)');

  // 5. P&L by price range for closed positions
  console.log('\n5. P&L POR RANGO DE PRECIO DE ENTRADA (posiciones cerradas):');
  const pnlByPrice = await pool.query(`
    SELECT
      CASE
        WHEN avg_entry_price >= 0.95 THEN '0.95-1.00'
        WHEN avg_entry_price >= 0.80 THEN '0.80-0.95'
        WHEN avg_entry_price >= 0.50 THEN '0.50-0.80'
        WHEN avg_entry_price >= 0.20 THEN '0.20-0.50'
        WHEN avg_entry_price >= 0.05 THEN '0.05-0.20'
        ELSE '0.00-0.05'
      END as rango,
      COUNT(*) as positions,
      SUM(realized_pnl) as total_pnl
    FROM paper_positions
    WHERE closed_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  if (pnlByPrice.rows.length === 0) {
    console.log('  No hay posiciones cerradas suficientes para analizar');
  } else {
    pnlByPrice.rows.forEach(r => {
      console.log('  ' + r.rango.padEnd(12) + ' | ' + r.positions + ' pos | P&L: $' + parseFloat(r.total_pnl || 0).toFixed(2));
    });
  }

  // 6. What percentage of capital is in extreme prices?
  console.log('\n6. CAPITAL ATRAPADO EN PRECIOS EXTREMOS:');
  const capitalInExtreme = await pool.query(`
    SELECT
      SUM(CASE WHEN avg_entry_price >= 0.95 OR avg_entry_price <= 0.05 THEN size * avg_entry_price ELSE 0 END) as extreme_value,
      SUM(size * avg_entry_price) as total_value
    FROM paper_positions
    WHERE closed_at IS NULL
  `);
  const ce = capitalInExtreme.rows[0];
  const extremeVal = parseFloat(ce.extreme_value || 0);
  const totalVal = parseFloat(ce.total_value || 0);
  console.log('  En precios extremos: $' + extremeVal.toFixed(2));
  console.log('  Total en posiciones: $' + totalVal.toFixed(2));
  console.log('  Porcentaje atrapado: ' + (totalVal > 0 ? (extremeVal/totalVal*100).toFixed(1) : 0) + '%');

  // 7. Analyze potential good vs bad price ranges
  console.log('\n7. ANÁLISIS DE RANGOS ÓPTIMOS:');
  console.log('  Rango 0.95-1.00: PELIGROSO - Sin upside, mercado casi resuelto');
  console.log('  Rango 0.80-0.95: RIESGOSO - Poco upside, alto precio');
  console.log('  Rango 0.50-0.80: MODERADO - Equilibrio riesgo/recompensa');
  console.log('  Rango 0.20-0.50: BUENO - Mayor upside potencial');
  console.log('  Rango 0.05-0.20: ESPECULATIVO - Alto riesgo, alto reward');
  console.log('  Rango 0.00-0.05: PELIGROSO - Mercado casi resuelto a NO');

  await pool.end();
}
analyze().catch(e => { console.error(e.message); process.exit(1); });

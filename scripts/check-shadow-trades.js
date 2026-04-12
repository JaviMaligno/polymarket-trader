const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function computeTier(stats) {
  if (stats.resolved < 10) return { tier: 3, label: 'Insufficient data' };
  if (stats.sharpe <= 0) return { tier: 4, label: 'Not viable' };
  if (stats.sharpe > 0.5 && stats.winPct > 55 && stats.resolved >= 20) return { tier: 1, label: 'Ready' };
  return { tier: 2, label: 'Promising' };
}

async function check() {
  // Summary by market type
  const summary = await pool.query(`
    SELECT
      market_type,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE resolved_at IS NULL) as pending,
      ROUND(AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END) FILTER (WHERE resolved_at IS NOT NULL) * 100, 1) as win_pct,
      ROUND(SUM(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) as total_pnl,
      ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) as avg_pnl,
      CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0
           THEN ROUND((AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
                      / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL))::numeric, 3)
           ELSE 0 END as sharpe
    FROM shadow_trades
    GROUP BY market_type
    ORDER BY total DESC
  `);

  console.log('=== SHADOW TRADES POR TIPO ===');
  if (summary.rows.length === 0) {
    console.log('(sin shadow trades registrados)');
    await pool.end();
    return;
  }
  console.table(summary.rows.map(r => ({
    type: r.market_type,
    total: r.total,
    resolved: r.resolved,
    pending: r.pending,
    win: r.win_pct ? r.win_pct + '%' : '-',
    total_pnl: r.total_pnl ? '$' + parseFloat(r.total_pnl).toFixed(2) : '-',
    avg_pnl: r.avg_pnl ? '$' + parseFloat(r.avg_pnl).toFixed(2) : '-',
    sharpe: parseFloat(r.sharpe) || '-'
  })));

  // Readiness tiers
  console.log('\n=== READINESS TIERS ===');
  for (const r of summary.rows) {
    const stats = {
      resolved: parseInt(r.resolved),
      winPct: parseFloat(r.win_pct) || 0,
      sharpe: parseFloat(r.sharpe) || 0,
    };
    const { tier, label } = computeTier(stats);
    const winStr = stats.resolved > 0 ? `win ${r.win_pct}%` : '-';
    const sharpeStr = stats.resolved >= 10 ? `sharpe ${r.sharpe}` : '-';
    console.log(`  ${r.market_type.padEnd(18)} | Tier ${tier} (${label.padEnd(19)}) | ${r.resolved} resolved | ${winStr} | ${sharpeStr}`);
  }

  // Comparison with real trading
  const realPerf = await pool.query(`
    SELECT
      COALESCE(m.market_type, 'unclassified') as market_type,
      COUNT(*) as trades,
      ROUND(AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct,
      ROUND(SUM(p.realized_pnl)::numeric, 2) as total_pnl
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at IS NOT NULL AND p.realized_pnl IS NOT NULL
    GROUP BY m.market_type
    ORDER BY total_pnl DESC
  `);
  console.log('\n=== REAL TRADING (comparación) ===');
  if (realPerf.rows.length === 0) {
    console.log('(sin trades reales)');
  } else {
    console.table(realPerf.rows.map(r => ({
      type: r.market_type,
      trades: r.trades,
      win: r.win_pct + '%',
      total_pnl: '$' + parseFloat(r.total_pnl).toFixed(2)
    })));
  }

  // Recent shadow trades (last 10)
  const recent = await pool.query(`
    SELECT time, market_type, direction, entry_price, theoretical_size, signal_confidence, signal_type
    FROM shadow_trades
    ORDER BY time DESC
    LIMIT 10
  `);
  console.log('\n=== ÚLTIMOS 10 SHADOW TRADES ===');
  if (recent.rows.length === 0) {
    console.log('(ninguno)');
  } else {
    console.table(recent.rows.map(r => ({
      time: new Date(r.time).toISOString().slice(11, 19),
      type: r.market_type,
      dir: r.direction,
      price: parseFloat(r.entry_price).toFixed(4),
      size: r.theoretical_size,
      conf: parseFloat(r.signal_confidence).toFixed(2),
      signal: r.signal_type
    })));
  }

  await pool.end();
}
check().catch(e => console.error(e.message));

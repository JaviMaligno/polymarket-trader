const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log("=== SIGNAL QUALITY ANALYSIS ===\n");

  // Check recent signals that led to trades
  const recentTrades = await pool.query(`
    SELECT
      pt.time,
      pt.side,
      pt.executed_price,
      pt.value_usd,
      pt.signal_type,
      sp.confidence,
      sp.strength,
      pp.realized_pnl,
      pp.side as position_side,
      EXTRACT(EPOCH FROM (pp.closed_at - pp.opened_at))/60 as hold_minutes
    FROM paper_trades pt
    LEFT JOIN signal_predictions sp ON pt.signal_id = sp.id
    LEFT JOIN paper_positions pp ON pt.market_id = pp.market_id
      AND pt.time BETWEEN pp.opened_at - INTERVAL '5 seconds' AND pp.opened_at + INTERVAL '5 seconds'
    WHERE pt.time > NOW() - INTERVAL '2 hours'
      AND pt.side = 'buy'
    ORDER BY pt.time DESC
    LIMIT 30
  `);

  console.log("=== RECENT BUY SIGNALS (last 2 hours) ===");
  console.log("Time     | Price  | Conf  | Str   | Signal Type    | PnL    | Hold");
  console.log("-".repeat(75));

  let totalConf = 0;
  let totalStr = 0;
  let count = 0;
  let winning = 0;
  let losing = 0;

  recentTrades.rows.forEach(r => {
    const time = new Date(r.time).toISOString().substring(11, 19);
    const price = parseFloat(r.executed_price).toFixed(3);
    const conf = r.confidence ? parseFloat(r.confidence).toFixed(2) : "N/A";
    const str = r.strength ? parseFloat(r.strength).toFixed(2) : "N/A";
    const signal = (r.signal_type || "unknown").substring(0, 14).padEnd(14);
    const pnl = r.realized_pnl ? parseFloat(r.realized_pnl).toFixed(2).padStart(6) : "  OPEN";
    const hold = r.hold_minutes ? parseFloat(r.hold_minutes).toFixed(1).padStart(5) + "m" : "     ";

    console.log(time + " | " + price + " | " + conf.padStart(5) + " | " + str.padStart(5) + " | " + signal + " | $" + pnl + " | " + hold);

    if (r.confidence && r.strength) {
      totalConf += parseFloat(r.confidence);
      totalStr += parseFloat(r.strength);
      count++;
    }

    if (r.realized_pnl) {
      if (parseFloat(r.realized_pnl) > 0) winning++;
      else if (parseFloat(r.realized_pnl) < 0) losing++;
    }
  });

  console.log("\n=== SIGNAL STATISTICS ===");
  if (count > 0) {
    console.log("Average Confidence: " + (totalConf / count).toFixed(3));
    console.log("Average Strength: " + (totalStr / count).toFixed(3));
  }
  console.log("Winning trades: " + winning);
  console.log("Losing trades: " + losing);
  console.log("Win rate: " + (winning / (winning + losing) * 100).toFixed(1) + "%");

  // Check signal generator distribution
  console.log("\n=== SIGNAL GENERATORS (24h) ===");
  const generators = await pool.query(`
    SELECT pt.signal_type, COUNT(*) as cnt, AVG(sp.confidence) as avg_conf, AVG(sp.strength) as avg_str
    FROM paper_trades pt
    LEFT JOIN signal_predictions sp ON pt.signal_id = sp.id
    WHERE pt.time > NOW() - INTERVAL '24 hours' AND pt.side = 'buy'
    GROUP BY pt.signal_type
    ORDER BY cnt DESC
  `);

  console.log("Generator          | Count | Avg Conf | Avg Str");
  console.log("-".repeat(55));
  generators.rows.forEach(r => {
    const gen = (r.signal_type || "unknown").substring(0, 18).padEnd(18);
    const cnt = r.cnt.toString().padStart(5);
    const conf = r.avg_conf ? parseFloat(r.avg_conf).toFixed(3) : "N/A";
    const str = r.avg_str ? parseFloat(r.avg_str).toFixed(3) : "N/A";
    console.log(gen + " | " + cnt + " | " + conf.padStart(8) + " | " + str.padStart(7));
  });

  // Check combiner thresholds
  console.log("\n=== COMBINER THRESHOLD CHECK ===");
  const belowThreshold = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM paper_trades pt
    LEFT JOIN signal_predictions sp ON pt.signal_id = sp.id
    WHERE pt.time > NOW() - INTERVAL '24 hours'
      AND pt.side = 'buy'
      AND (sp.confidence < 0.43 OR sp.strength < 0.27)
  `);
  const totalTrades = await pool.query(`
    SELECT COUNT(*) as cnt FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours' AND side = 'buy'
  `);

  console.log("Trades below threshold (conf<0.43 or str<0.27): " + belowThreshold.rows[0].cnt);
  console.log("Total buy trades: " + totalTrades.rows[0].cnt);
  console.log("Percentage below threshold: " + (belowThreshold.rows[0].cnt / totalTrades.rows[0].cnt * 100).toFixed(1) + "%");

  // Check position profitability by side
  console.log("\n=== PROFITABILITY BY POSITION SIDE ===");
  const bySide = await pool.query(`
    SELECT
      side,
      COUNT(*) as total,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as winners,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losers,
      AVG(realized_pnl) as avg_pnl,
      SUM(realized_pnl) as total_pnl
    FROM paper_positions
    WHERE closed_at > NOW() - INTERVAL '24 hours'
    GROUP BY side
  `);

  console.log("Side  | Total | Win | Loss | Win% | Avg PnL | Total PnL");
  console.log("-".repeat(65));
  bySide.rows.forEach(r => {
    const side = r.side.padEnd(5);
    const total = r.total.toString().padStart(5);
    const win = r.winners.toString().padStart(3);
    const loss = r.losers.toString().padStart(4);
    const winRate = (r.winners / r.total * 100).toFixed(1).padStart(5) + "%";
    const avgPnl = "$" + parseFloat(r.avg_pnl).toFixed(2).padStart(6);
    const totalPnl = "$" + parseFloat(r.total_pnl).toFixed(2).padStart(7);
    console.log(side + " | " + total + " | " + win + " | " + loss + " | " + winRate + " | " + avgPnl + " | " + totalPnl);
  });

  await pool.end();
}

analyze().catch(e => {
  console.error(e);
  process.exit(1);
});

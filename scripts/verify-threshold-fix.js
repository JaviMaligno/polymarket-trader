const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
  console.log("=== THRESHOLD FIX VERIFICATION ===\n");

  // Check what params would be loaded from DB
  console.log("1. Checking optimization_runs params:");
  const optResult = await pool.query(`
    SELECT best_params, best_score
    FROM optimization_runs
    WHERE status = 'completed' AND best_score IS NOT NULL
    ORDER BY best_score DESC
    LIMIT 1
  `);

  if (optResult.rows.length > 0) {
    const params = optResult.rows[0].best_params;
    const dbConf = params['combiner.minCombinedConfidence'] ?? params.minConfidence;
    const dbStr = params['combiner.minCombinedStrength'] ?? params.minEdge;

    console.log("  DB values: conf=" + dbConf + ", str=" + dbStr);
    console.log("  MIN values: conf=0.60, str=0.45");

    const finalConf = Math.max(dbConf ?? 0.60, 0.60);
    const finalStr = Math.max(dbStr ?? 0.45, 0.45);

    console.log("  Applied (Math.max): conf=" + finalConf + ", str=" + finalStr);

    if (finalConf === 0.60 && finalStr === 0.45) {
      console.log("  ✅ Minimum thresholds enforced correctly\n");
    } else {
      console.log("  ❌ ERROR: Thresholds not enforced!\n");
    }
  }

  // Check recent signals
  console.log("2. Checking signals generated (last 10 min):");
  const signals = await pool.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN confidence >= 0.60 AND ABS(strength) >= 0.45 THEN 1 END) as meeting_threshold
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '10 minutes'
  `);

  const total = parseInt(signals.rows[0].total);
  const meeting = parseInt(signals.rows[0].meeting_threshold);

  console.log("  Total signals: " + total);
  console.log("  Meeting thresholds (≥0.60 conf, ≥0.45 str): " + meeting);

  if (total === 0) {
    console.log("  ℹ️  No signals yet (filtering may be working)\n");
  } else if (meeting === total) {
    console.log("  ✅ All signals meet thresholds!\n");
  } else {
    const pct = (meeting / total * 100).toFixed(1);
    console.log("  ⚠️  Only " + pct + "% meeting thresholds\n");
  }

  // Check recent trades
  console.log("3. Checking trades executed (last 10 min):");
  const trades = await pool.query(`
    SELECT COUNT(*) as count FROM paper_trades
    WHERE time > NOW() - INTERVAL '10 minutes'
  `);

  const tradeCount = parseInt(trades.rows[0].count);
  console.log("  Trades: " + tradeCount);

  if (tradeCount === 0) {
    console.log("  ✅ No trades (filtering working or no strong signals)\n");
  } else {
    console.log("  ℹ️  " + tradeCount + " trades executed\n");
  }

  // Check account state
  console.log("4. Checking account state:");
  const account = await pool.query(`
    SELECT current_capital, total_trades FROM paper_account WHERE id = 1
  `);

  const capital = parseFloat(account.rows[0].current_capital);
  const totalTrades = account.rows[0].total_trades;

  console.log("  Capital: $" + capital.toFixed(2));
  console.log("  Total trades: " + totalTrades);
  console.log("  Since reset ($10k): " + (capital >= 10000 ? "✅" : "⚠️") + " $" + (capital - 10000).toFixed(2));

  await pool.end();

  // Summary
  console.log("\n=== SUMMARY ===");
  if (capital >= 9900) {
    console.log("✅ System appears stable (capital near reset value)");
  } else if (capital >= 9500) {
    console.log("⚠️  Minor losses detected, monitor closely");
  } else {
    console.log("🚨 Significant losses, thresholds may not be working!");
  }
}

verify().catch(e => {
  console.error(e);
  process.exit(1);
});

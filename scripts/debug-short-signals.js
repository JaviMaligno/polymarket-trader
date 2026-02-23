const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log("=== DEBUGGING SHORT SIGNAL EXECUTION ===\n");

  const shortSignals = await pool.query("SELECT metadata FROM signal_predictions WHERE direction = 'short' LIMIT 5");
  console.log("=== SHORT SIGNAL METADATA (sample) ===");
  shortSignals.rows.forEach(r => console.log(JSON.stringify(r.metadata)));

  const marketTokens = await pool.query("SELECT sp.market_id, m.clob_token_id_no, m.is_active FROM signal_predictions sp JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id WHERE sp.direction = 'short' LIMIT 10");
  console.log("\n=== SHORT SIGNAL MARKETS TOKEN INFO ===");
  marketTokens.rows.forEach(r => {
    const mid = r.market_id ? r.market_id.substring(0, 20) : "unknown";
    console.log("Market: " + mid + "... | No Token: " + (r.clob_token_id_no ? "PRESENT" : "MISSING") + " | Active: " + r.is_active);
  });

  const shortNoPosition = await pool.query("SELECT COUNT(*) as cnt FROM signal_predictions sp WHERE sp.direction = 'short' AND NOT EXISTS (SELECT 1 FROM paper_positions pp WHERE pp.market_id = sp.market_id AND pp.closed_at IS NULL)");
  console.log("\n=== SHORT SIGNALS WITHOUT OPEN POSITION ===");
  console.log("SHORT signals that would need to open No positions:", shortNoPosition.rows[0].cnt);

  const signalFlow = await pool.query("SELECT signal_type, direction, COUNT(*) as predictions, COUNT(*) FILTER (WHERE id IN (SELECT signal_id FROM paper_trades)) as became_trades FROM signal_predictions GROUP BY signal_type, direction ORDER BY signal_type, direction");
  console.log("\n=== SIGNAL TO TRADE CONVERSION ===");
  console.log("Signal Type | Direction | Predictions | Became Trades");
  signalFlow.rows.forEach(r => {
    const st = (r.signal_type || "unknown").padEnd(15);
    console.log(st + " | " + r.direction.padEnd(5) + " | " + String(r.predictions).padStart(5) + " | " + String(r.became_trades).padStart(5));
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });

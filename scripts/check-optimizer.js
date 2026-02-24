const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log("=== OPTIMIZATION RUNS ===");
  const runs = await pool.query(`
    SELECT
      id,
      name,
      started_at,
      completed_at,
      status,
      best_score,
      best_params,
      iterations_completed,
      n_iterations
    FROM optimization_runs
    ORDER BY started_at DESC
    LIMIT 5
  `);

  if (runs.rows.length === 0) {
    console.log("No optimization runs found!");
  } else {
    runs.rows.forEach(r => {
      console.log("\nRun: " + r.name);
      console.log("  Started: " + new Date(r.started_at).toISOString());
      console.log("  Status: " + r.status);
      console.log("  Iterations: " + r.iterations_completed + "/" + r.n_iterations);
      if (r.best_score) {
        console.log("  Best Score: " + parseFloat(r.best_score).toFixed(3));
      }
      if (r.best_params) {
        const params = typeof r.best_params === "string" ? JSON.parse(r.best_params) : r.best_params;
        console.log("  Best params:");
        Object.entries(params).forEach(([k, v]) => {
          if (k.includes("Confidence") || k.includes("Strength") || k.includes("min")) {
            console.log("    " + k + ": " + (typeof v === "number" ? v.toFixed(3) : v));
          }
        });
      }
    });
  }

  // Check current weights
  console.log("\n=== CURRENT SIGNAL WEIGHTS ===");
  const weights = await pool.query(`
    SELECT signal_type, weight, last_updated
    FROM signal_weights_current
    ORDER BY signal_type
  `);

  if (weights.rows.length === 0) {
    console.log("No current weights found!");
  } else {
    weights.rows.forEach(r => {
      const lastUpdate = new Date(r.last_updated).toISOString().substring(0, 19);
      console.log("  " + r.signal_type.padEnd(20) + ": " + parseFloat(r.weight).toFixed(3) + " (updated: " + lastUpdate + ")");
    });
  }

  // Check optimization service state
  console.log("\n=== OPTIMIZATION SERVICE STATE ===");
  const state = await pool.query(`
    SELECT * FROM optimization_service_state ORDER BY last_updated DESC LIMIT 1
  `);

  if (state.rows.length > 0) {
    const s = state.rows[0];
    console.log("  Status: " + s.status);
    console.log("  Current run: " + (s.current_run_id || "none"));
    console.log("  Last updated: " + new Date(s.last_updated).toISOString());
  } else {
    console.log("  No service state found");
  }

  await pool.end();
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});

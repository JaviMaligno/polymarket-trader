const { Pool } = require('pg');

async function check() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const result = await pool.query(`
    SELECT name, best_params, best_score, status, created_at
    FROM optimization_runs
    WHERE status = 'completed' AND best_score IS NOT NULL
    ORDER BY best_score DESC
    LIMIT 1
  `);

  if (result.rows.length > 0) {
    const r = result.rows[0];
    console.log('Best optimization run:');
    console.log('  name:', r.name);
    console.log('  status:', r.status);
    console.log('  best_score:', r.best_score);
    console.log('  best_params:', JSON.stringify(r.best_params, null, 2));
    console.log('  created_at:', r.created_at);

    // Simulate what loadBestOptimizationParams does
    const params = r.best_params;
    console.log('\nloadBestOptimizationParams would return:');
    console.log('  minEdge:', params.execution_minEdge || params.minEdge || 'fallback');
    console.log('  minConfidence:', params.combiner_minCombinedConfidence || params.minConfidence || 'fallback');
  } else {
    console.log('No completed optimization runs found');
  }

  await pool.end();
}
check();

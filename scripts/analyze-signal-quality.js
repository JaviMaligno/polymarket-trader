const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log('=== SIGNAL QUALITY ANALYSIS ===\n');

  // Check signal predictions with outcomes
  const predictions = await pool.query(`
    SELECT
      direction,
      was_correct,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence,
      AVG(ABS(strength)) as avg_strength
    FROM signal_predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY direction, was_correct
    ORDER BY direction, was_correct
  `);
  
  console.log('Signal Outcomes (resolved predictions):');
  let totalCorrect = 0, totalIncorrect = 0;
  predictions.rows.forEach(r => {
    const outcome = r.was_correct ? 'CORRECT' : 'INCORRECT';
    console.log('  ' + r.direction.toUpperCase() + ' ' + outcome + ': ' + r.count + 
      ' (avg conf: ' + parseFloat(r.avg_confidence || 0).toFixed(3) + 
      ', avg str: ' + parseFloat(r.avg_strength || 0).toFixed(3) + ')');
    if (r.was_correct) totalCorrect += parseInt(r.count);
    else totalIncorrect += parseInt(r.count);
  });
  
  if (totalCorrect + totalIncorrect > 0) {
    const accuracy = (totalCorrect / (totalCorrect + totalIncorrect) * 100).toFixed(1);
    console.log('\nOverall Signal Accuracy: ' + accuracy + '%');
    console.log('Total resolved: ' + (totalCorrect + totalIncorrect) + ' | Correct: ' + totalCorrect + ' | Incorrect: ' + totalIncorrect);
  }

  // Check unresolved predictions
  const unresolved = await pool.query(`
    SELECT
      direction,
      COUNT(*) as count
    FROM signal_predictions
    WHERE resolved_at IS NULL
    GROUP BY direction
  `);
  console.log('\nUnresolved predictions:');
  unresolved.rows.forEach(r => {
    console.log('  ' + r.direction + ': ' + r.count);
  });

  // Check prediction resolution by time
  console.log('\n=== RECENT PREDICTION OUTCOMES ===');
  const recentOutcomes = await pool.query(`
    SELECT
      DATE_TRUNC('hour', resolved_at) as hour,
      COUNT(*) as total,
      COUNT(CASE WHEN was_correct THEN 1 END) as correct
    FROM signal_predictions
    WHERE resolved_at > NOW() - INTERVAL '24 hours'
    GROUP BY DATE_TRUNC('hour', resolved_at)
    ORDER BY hour DESC
    LIMIT 12
  `);
  recentOutcomes.rows.forEach(r => {
    const hour = new Date(r.hour).toISOString().substring(11, 16);
    const accuracy = (r.correct / r.total * 100).toFixed(0);
    console.log('  ' + hour + ' UTC | ' + r.correct + '/' + r.total + ' correct (' + accuracy + '%)');
  });

  // Check which signal types are most accurate
  console.log('\n=== ACCURACY BY SIGNAL GENERATOR ===');
  const byGenerator = await pool.query(`
    SELECT
      signal_type,
      COUNT(*) as total,
      COUNT(CASE WHEN was_correct THEN 1 END) as correct
    FROM signal_predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY signal_type
    ORDER BY total DESC
  `);
  byGenerator.rows.forEach(r => {
    const accuracy = r.total > 0 ? (r.correct / r.total * 100).toFixed(1) : '0';
    console.log('  ' + (r.signal_type || 'unknown').padEnd(20) + ' | ' + r.correct + '/' + r.total + ' (' + accuracy + '%)');
  });

  await pool.end();
}

analyze().catch(e => { console.error(e); process.exit(1); });

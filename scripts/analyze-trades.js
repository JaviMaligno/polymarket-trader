const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  // Get recent paper trades
  const trades = await client.query(`
    SELECT market_id, side, executed_size, executed_price, signal_type, time
    FROM paper_trades
    ORDER BY time DESC
    LIMIT 15
  `);

  console.log('=== ÚLTIMOS TRADES ===\n');
  trades.rows.forEach(t => {
    const time = t.time.toISOString().slice(0,16).replace('T', ' ');
    const size = parseFloat(t.executed_size) || 0;
    const price = parseFloat(t.executed_price) || 0;
    console.log(`${time} | ${t.side.padEnd(5)} | $${size.toFixed(2)} @ ${price.toFixed(4)}`);
    console.log(`  Signal: ${t.signal_type || 'N/A'}`);
    console.log(`  Market: ${t.market_id.slice(0,60)}...`);
    console.log('');
  });

  // Get optimization history
  const opts = await client.query(`
    SELECT name, iteration, sharpe, total_return, win_rate, created_at
    FROM optimization_results
    ORDER BY created_at DESC
    LIMIT 10
  `);

  console.log('\n=== ÚLTIMAS OPTIMIZACIONES ===\n');
  opts.rows.forEach(o => {
    const time = o.created_at.toISOString().slice(0,16).replace('T', ' ');
    console.log(`${time} | ${o.name} #${o.iteration}`);
    console.log(`  Sharpe: ${o.sharpe?.toFixed(3) || 'N/A'} | Return: ${(o.total_return * 100)?.toFixed(2) || 'N/A'}% | WinRate: ${(o.win_rate * 100)?.toFixed(1) || 'N/A'}%`);
    console.log('');
  });

  // Get current active params
  const params = await client.query(`
    SELECT params, created_at
    FROM optimization_results
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (params.rows.length > 0) {
    console.log('\n=== PARÁMETROS ACTIVOS ===\n');
    const p = params.rows[0].params;
    console.log(JSON.stringify(p, null, 2));
  }

  await client.end();
}

main().catch(console.error);

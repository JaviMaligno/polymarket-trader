const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check the rejected market IDs
  const id1 = '0xdd42e83a5365621cb1648d1d1d5f0b0b124dfa8def5dce21b6e1ae3ce0d6b81b';
  const id2 = '0x1abcad867bb7e62c26c0cfb2d72e4e030e8e5ae22e4f0bb65a5a3c82b0298a7e';

  console.log('=== VERIFICANDO MERCADOS RECHAZADOS ===');

  const r1 = await pool.query('SELECT id, question FROM markets WHERE id = $1', [id1]);
  console.log('Market 1 (0xdd42...):', r1.rows.length > 0 ? 'EXISTE' : 'NO EXISTE');

  const r2 = await pool.query('SELECT id, question FROM markets WHERE id = $1', [id2]);
  console.log('Market 2 (0x1abc...):', r2.rows.length > 0 ? 'EXISTE' : 'NO EXISTE');

  // Check data-collector tracked markets
  console.log('\n=== MERCADOS TRACKED POR DATA-COLLECTOR ===');
  const tracked = await pool.query(`
    SELECT market_id, COUNT(*) as prices
    FROM price_history
    WHERE time > NOW() - INTERVAL '30 minutes'
    GROUP BY market_id
    ORDER BY prices DESC
    LIMIT 5
  `);

  for (const t of tracked.rows) {
    const m = await pool.query('SELECT question, is_active FROM markets WHERE id = $1', [t.market_id]);
    const info = m.rows[0];
    const status = info ? (info.is_active ? 'ACTIVO' : 'INACTIVO') : 'NO EN DB';
    console.log('[' + status + '] ' + t.prices + ' prices -', (info?.question || t.market_id).substring(0, 45));
  }

  // Check what SignalEngine should be using
  console.log('\n=== MERCADOS EN DB CON DATOS RECIENTES ===');
  const dbMarkets = await pool.query(`
    SELECT m.id, m.question, m.is_active, m.current_price_yes
    FROM markets m
    WHERE m.is_active = true
      AND m.current_price_yes > 0.05
      AND m.current_price_yes < 0.95
    ORDER BY m.updated_at DESC
    LIMIT 5
  `);

  for (const m of dbMarkets.rows) {
    const price = parseFloat(m.current_price_yes || 0).toFixed(2);
    console.log('[$' + price + '] ' + m.question?.substring(0, 50));
  }

  await pool.end();
}

check().catch(console.error);

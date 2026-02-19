const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const ids = [
    '0x0fe5782096b3d94d96ba72a92c60c26e22a95ca7e4b5d09b3f6eac2f5afa7e65',
    '0x1abcad867bb7e62c26c0cfb2d72e4e030e8e5ae22e4f0bb65a5a3c82b0298a7e',
    '0xdd42e83a5365621cb1648d1d1d5f0b0b124dfa8def5dce21b6e1ae3ce0d6b81b'
  ];

  console.log('=== BUSQUEDA DE MERCADOS RECHAZADOS ===');

  for (const id of ids) {
    const shortId = id.substring(0, 14) + '...';

    // Search by id
    const byId = await pool.query('SELECT id, question, is_active FROM markets WHERE id = $1', [id]);
    // Search by condition_id
    const byCondition = await pool.query('SELECT id, condition_id, question, is_active FROM markets WHERE condition_id = $1', [id]);

    console.log('\n' + shortId + ':');
    console.log('  By id:', byId.rows.length > 0 ? 'FOUND' : 'not found');
    console.log('  By condition_id:', byCondition.rows.length > 0 ? 'FOUND' : 'not found');

    if (byCondition.rows.length > 0) {
      console.log('  DB id:', byCondition.rows[0].id.substring(0, 30) + '...');
    }
  }

  // Show a sample of what condition_id looks like in DB
  const sample = await pool.query('SELECT id, condition_id FROM markets WHERE condition_id IS NOT NULL LIMIT 3');
  console.log('\n=== MUESTRA DE IDs EN DB ===');
  sample.rows.forEach(r => {
    const id = r.id ? r.id.substring(0, 25) + '...' : 'null';
    const cond = r.condition_id ? r.condition_id.substring(0, 25) + '...' : 'null';
    console.log('  id:', id, ' | condition_id:', cond);
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });

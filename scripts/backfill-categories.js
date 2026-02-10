/**
 * Backfill market categories from question text
 *
 * Run with: NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/backfill-categories.js
 */

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function inferCategoryFromQuestion(question) {
  if (!question) return null;
  const q = question.toLowerCase();

  // Politics
  if (/trump|biden|democrat|republican|election|president|congress|senate|governor|vote|poll/i.test(q)) {
    return 'Politics';
  }
  // Crypto
  if (/bitcoin|btc|ethereum|eth|crypto|solana|sol|token|blockchain|defi/i.test(q)) {
    return 'Crypto';
  }
  // Sports
  if (/nfl|nba|mlb|nhl|soccer|football|basketball|tennis|golf|championship|super bowl|world cup|olympics/i.test(q)) {
    return 'Sports';
  }
  // Entertainment
  if (/oscar|emmy|grammy|movie|film|album|artist|celebrity|netflix|spotify|tiktok/i.test(q)) {
    return 'Entertainment';
  }
  // Science & Tech
  if (/spacex|nasa|ai |artificial intelligence|openai|google|apple|microsoft|tesla|launch|rocket/i.test(q)) {
    return 'Science & Tech';
  }
  // Finance
  if (/stock|s&p|nasdaq|fed|interest rate|inflation|gdp|recession|market|economy/i.test(q)) {
    return 'Finance';
  }
  // Weather
  if (/hurricane|earthquake|weather|temperature|climate|storm/i.test(q)) {
    return 'Weather';
  }
  // World Affairs
  if (/ukraine|russia|china|war|military|nato|un |united nations/i.test(q)) {
    return 'World Affairs';
  }

  return null;
}

async function backfill() {
  console.log('Fetching markets with NULL category...');

  const result = await pool.query(`
    SELECT id, question
    FROM markets
    WHERE category IS NULL AND question IS NOT NULL
  `);

  console.log(`Found ${result.rows.length} markets to categorize`);

  const categoryUpdates = {};
  let updated = 0;
  let skipped = 0;

  for (const row of result.rows) {
    const category = inferCategoryFromQuestion(row.question);
    if (category) {
      if (!categoryUpdates[category]) {
        categoryUpdates[category] = [];
      }
      categoryUpdates[category].push(row.id);
      updated++;
    } else {
      skipped++;
    }
  }

  console.log('\nCategory distribution:');
  for (const [cat, ids] of Object.entries(categoryUpdates)) {
    console.log(`  ${cat}: ${ids.length} markets`);
  }
  console.log(`  (no match): ${skipped} markets`);

  // Batch update by category
  console.log('\nUpdating database...');
  for (const [category, ids] of Object.entries(categoryUpdates)) {
    // Update in batches of 1000 to avoid query size limits
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      await pool.query(
        `UPDATE markets SET category = $1 WHERE id = ANY($2)`,
        [category, batch]
      );
    }
    console.log(`  Updated ${ids.length} markets to "${category}"`);
  }

  console.log(`\nDone! Updated ${updated} markets, skipped ${skipped}`);
  await pool.end();
}

backfill().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

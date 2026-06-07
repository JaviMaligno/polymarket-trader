import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await getPool().query(sql);
  // eslint-disable-next-line no-console
  console.log('mm-recorder schema applied');
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

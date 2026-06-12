import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, closePool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

export type UniverseRow = {
  market_id: string;     // markets.id (numeric) — book-event enrichment
  condition_id: string;  // CLOB 0x hash — Gamma queries (rewards)
  token_id: string;
  end_date: Date | null; // market expiry — used by QuoteEngine near-resolution guard
};

export async function selectUniverse(n: number): Promise<UniverseRow[]> {
  const sql = readFileSync(join(here, 'selectUniverse.sql'), 'utf8');
  return query<UniverseRow>(sql, [n]);
}

async function main() {
  const n = parseInt(process.env.MM_UNIVERSE_N || '15', 10);
  const rows = await selectUniverse(n);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rows.map((r) => r.token_id)));
  await closePool();
}

// Run as a script only when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('selectUniverse.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

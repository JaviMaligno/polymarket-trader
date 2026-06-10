import { pino } from 'pino';
import { getPool, closePool, query } from './db.js';
import { selectUniverse } from './selectUniverse.js';
import { BookState } from './bookState.js';
import { BatchSink } from './sink.js';
import { runRecorder } from './wsClient.js';
import { snapshotRewards } from './rewards.js';

const logger = pino({ name: 'mm-recorder' });

async function recordGap(start: Date, end: Date, reason: string): Promise<void> {
  await query('INSERT INTO mm_capture_gaps(token_id,gap_start,gap_end,reason) VALUES (NULL,$1,$2,$3)', [start, end, reason]);
}

async function main() {
  const n = parseInt(process.env.MM_UNIVERSE_N || '15', 10);
  const universe = await selectUniverse(n);
  const assetIds = universe.map((r) => r.token_id);
  if (assetIds.length === 0) throw new Error('empty universe — check selector / DB');

  const marketByToken = new Map(universe.map((r) => [r.token_id, r.market_id]));
  const state = new BookState();
  const exec = (sql: string, params: unknown[]) => getPool().query(sql, params as never[]);
  const sink = new BatchSink(exec, parseInt(process.env.MM_BATCH || '200', 10));

  // periodic flush so low-traffic windows still persist
  const flushTimer = setInterval(() => sink.flush().catch(() => undefined), 2000);

  // marketId enrichment: the feed gives market hash; prefer our market_id from the map
  const stateProxy = {
    apply: (e: Parameters<BookState['apply']>[0]) => {
      const row = state.apply(e);
      if (row) row.marketId = marketByToken.get(row.tokenId) ?? row.marketId;
      return row;
    },
    midOf: (t: string) => state.midOf(t),
  } as BookState;

  const handle = runRecorder({ assetIds, state: stateProxy, sink, recordGap });
  logger.info({ markets: n, tokens: assetIds.length }, 'recorder started');

  // H-MM-2: daily snapshot of each market's liquidity-rewards program (Gamma).
  // Gamma matches on the CLOB condition_id (0x hash), NOT markets.id.
  const conditionIds = [...new Set(universe.map((r) => r.condition_id).filter(Boolean))];
  const snap = () => snapshotRewards((sql, params) => query(sql, params), conditionIds)
    .catch((e) => logger.warn({ e }, 'rewards snapshot failed'));
  void snap();
  const rewardsTimer = setInterval(snap, 24 * 60 * 60 * 1000);

  const shutdown = async () => {
    handle.stop();
    clearInterval(flushTimer);
    clearInterval(rewardsTimer);
    await sink.flush().catch(() => undefined);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { logger.error({ e }, 'fatal'); process.exit(1); });

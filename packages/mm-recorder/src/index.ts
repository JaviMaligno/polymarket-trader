import { pino } from 'pino';
import { getPool, closePool, query } from './db.js';
import { selectUniverse } from './selectUniverse.js';
import { BookState } from './bookState.js';
import { BatchSink } from './sink.js';
import { runRecorder } from './wsClient.js';
import { snapshotRewards } from './rewards.js';
import { loadConfig } from './quoter/config.js';
import { QuoteEngine } from './quoter/engine.js';
import { QuoterPersistence } from './quoter/persistence.js';
import type { BookInput, TradeEvent } from './types.js';
import type { RewardsParams } from './quoter/types.js';

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

  // --- MM Quoter (shadow + live phases) ---
  const quoterCfg = loadConfig(process.env as Record<string, string | undefined>);

  let engine: QuoteEngine | null = null;
  let quoterFlushTimer: ReturnType<typeof setInterval> | null = null;
  let rewardsRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // live phase (real orders) — only armed when MM_QUOTER_MODE=live
  let liveEngine: import('./quoter/live/liveEngine.js').LiveEngine | null = null;
  let liveTickTimer: ReturnType<typeof setInterval> | null = null;
  let liveGateway: import('./quoter/live/orderGateway.js').OrderGateway | null = null;

  if (quoterCfg.mode === 'shadow') {
    const persistence = new QuoterPersistence(
      (sql: string, params?: unknown[]) => query(sql, params ?? []),
    );
    await persistence.ensureSchema();

    const rewardsByMarket = new Map<string, RewardsParams>();
    // mm_reward_snapshots.market_id stores the CLOB condition_id (fix d739823).
    // Build condition_id → market_id translation from universe.
    const marketByCondition = new Map(
      universe.filter((r) => r.condition_id).map((r) => [r.condition_id, r.market_id]),
    );

    const loadRewards = async () => {
      const rows = await query<{ market_id: string; min_size: unknown; max_spread: unknown; daily_rate: unknown }>(
        `SELECT DISTINCT ON (market_id) market_id, min_size, max_spread, daily_rate
         FROM mm_reward_snapshots ORDER BY market_id, time DESC`,
        [],
      );
      for (const row of rows) {
        const mkt = marketByCondition.get(row.market_id);
        if (!mkt) continue;
        rewardsByMarket.set(mkt, {
          minSize: row.min_size === null ? null : Number(row.min_size),
          maxSpreadCents: row.max_spread === null ? null : Number(row.max_spread),
          dailyRate: row.daily_rate === null ? null : Number(row.daily_rate),
        });
      }
    };
    await loadRewards().catch((e) => logger.warn({ e }, 'rewards load failed'));
    rewardsRefreshTimer = setInterval(
      () => loadRewards().catch(() => undefined),
      24 * 60 * 60 * 1000,
    );

    engine = new QuoteEngine({
      cfg: quoterCfg,
      state,
      persistence,
      marketByToken,
      endDateByMarket: new Map(
        universe.filter((r) => r.end_date).map((r) => [r.market_id, new Date(r.end_date!)]),
      ),
      rewardsByMarket,
    });

    quoterFlushTimer = setInterval(
      () => engine!.flushHourly(new Date()).catch((e) => logger.warn({ e }, 'quoter flush failed')),
      5 * 60_000,
    );
    logger.info('shadow quoter started');
  }

  if (quoterCfg.mode === 'live') {
    const { loadPrivateKey } = await import('./quoter/live/secret.js');
    const { OrderGateway } = await import('./quoter/live/orderGateway.js');
    const { LivePersistence } = await import('./quoter/live/livePersistence.js');
    const { buildLiveEngine } = await import('./quoter/live/wiring.js');
    // @ts-ignore — optional prod-only dep, installed during live activation (Task 13)
    const { ClobClient } = await import('@polymarket/clob-client');
    // @ts-ignore — optional prod-only dep
    const { Wallet } = await import('ethers');

    // mm_quoter_state lives in the shadow schema; in live mode the shadow branch
    // didn't run, so ensure it (and the rest, harmless IF NOT EXISTS) exists for persistState.
    await new QuoterPersistence((sql: string, params?: unknown[]) => query(sql, params ?? [])).ensureSchema();

    const pk = await loadPrivateKey(quoterCfg.walletSecretName, process.env);
    const signer = new Wallet(pk);
    const host = process.env.CLOB_API_URL ?? 'https://clob.polymarket.com';
    const client = new ClobClient(host, 137, signer);
    liveGateway = new OrderGateway(client, { ttlMs: quoterCfg.orderTtlMs });

    const livePersistence = new LivePersistence((sql: string, params?: unknown[]) => query(sql, params ?? []));

    // rewards: same condition_id→market_id translation as the shadow branch.
    const rewardsByMarket = new Map<string, RewardsParams>();
    const marketByConditionLive = new Map(
      universe.filter((r) => r.condition_id).map((r) => [r.condition_id, r.market_id]),
    );
    const loadRewardsLive = async () => {
      const rows = await query<{ market_id: string; min_size: unknown; max_spread: unknown; daily_rate: unknown }>(
        `SELECT DISTINCT ON (market_id) market_id, min_size, max_spread, daily_rate
         FROM mm_reward_snapshots ORDER BY market_id, time DESC`,
        [],
      );
      for (const row of rows) {
        const mkt = marketByConditionLive.get(row.market_id);
        if (!mkt) continue;
        rewardsByMarket.set(mkt, {
          minSize: row.min_size === null ? null : Number(row.min_size),
          maxSpreadCents: row.max_spread === null ? null : Number(row.max_spread),
          dailyRate: row.daily_rate === null ? null : Number(row.daily_rate),
        });
      }
    };
    await loadRewardsLive().catch((e) => logger.warn({ e }, 'live rewards load failed'));

    const built = await buildLiveEngine({
      cfg: quoterCfg,
      gateway: liveGateway,
      persistence: livePersistence,
      marketByToken,
      endDateByMarket: new Map(
        universe.filter((r) => r.end_date).map((r) => [r.market_id, new Date(r.end_date!)]),
      ),
      rewardsByMarket,
      onKill: async () => { await liveGateway!.cancelAll().catch(() => undefined); },
      persistState: (s) => query(
        `INSERT INTO mm_quoter_state(key,value,updated_at) VALUES ('live',$1,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [JSON.stringify(s)],
      ).then(() => undefined),
      notify: async (type, payload) => { logger.error({ type, payload }, 'MM live notify'); },
    });
    liveEngine = built.engine;
    liveTickTimer = setInterval(
      () => liveEngine!.tick(new Date()).catch((e) => logger.warn({ e }, 'live tick failed')),
      quoterCfg.fillPollMs,
    );
    logger.info({ subset: quoterCfg.liveSubset }, 'LIVE quoter started');
  }

  const handle = runRecorder({
    assetIds,
    state: stateProxy,
    sink,
    recordGap,
    onEvent: (engine || liveEngine)
      ? (kind, event, row) => {
          if (kind === 'book') {
            const bookRow = row as Parameters<QuoteEngine['onBook']>[1];
            if (engine) engine.onBook(event as BookInput, bookRow);
            // live: fills come from pollFills (tick), not the trade feed — only book drives quotes.
            if (liveEngine) void liveEngine.onBook(event as BookInput, bookRow).catch((e) => logger.warn({ e }, 'live onBook failed'));
          } else if (engine) {
            void engine.onTrade(event as TradeEvent).catch((e) => logger.warn({ e }, 'quoter onTrade failed'));
          }
        }
      : undefined,
    onGap: engine ? () => engine!.onGap() : undefined,
  });
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
    if (quoterFlushTimer) clearInterval(quoterFlushTimer);
    if (rewardsRefreshTimer) clearInterval(rewardsRefreshTimer);
    if (liveTickTimer) clearInterval(liveTickTimer);
    // graceful cancel-all in live mode (GTD would expire anyway — double safety net).
    if (liveGateway) await liveGateway.cancelAll().catch(() => undefined);
    await sink.flush().catch(() => undefined);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { logger.error({ e }, 'fatal'); process.exit(1); });

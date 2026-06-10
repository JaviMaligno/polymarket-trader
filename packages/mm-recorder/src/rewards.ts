import { pino } from 'pino';

const logger = pino({ name: 'mm-rewards' });
const GAMMA_URL = 'https://gamma-api.polymarket.com/markets';
const CHUNK = 20;

// H-MM-2 needs a history of the liquidity-rewards program per market:
// quoting eligibility (rewardsMinSize / rewardsMaxSpread) plus the daily
// payout rate of any program active on the snapshot date. Gamma exposes all
// of it; nothing in our DB stores it, so the recorder snapshots it daily.
// Separate statements: pg's extended protocol (used whenever params are
// passed, even []) rejects multi-statement strings.
const ENSURE_SQL = [
  `CREATE TABLE IF NOT EXISTS mm_reward_snapshots (
  time            TIMESTAMPTZ NOT NULL,
  market_id       VARCHAR(128) NOT NULL,
  min_size        DECIMAL(20,6),
  max_spread      DECIMAL(10,6),
  daily_rate      DECIMAL(20,6)
)`,
  'CREATE INDEX IF NOT EXISTS idx_mm_rewards_market_time ON mm_reward_snapshots (market_id, time)',
];

export interface RewardRow {
  marketId: string;
  minSize: number | null;
  maxSpread: number | null;
  dailyRate: number | null;
}

type Exec = (sql: string, params: unknown[]) => Promise<unknown>;
type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function parseRewards(m: Record<string, unknown>, today: string): RewardRow | null {
  const marketId = m['conditionId'];
  if (typeof marketId !== 'string' || !marketId) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // A program is active when today falls inside [startDate, endDate]; several
  // can overlap (e.g. base + boosted), so active rates add up.
  let dailyRate: number | null = null;
  const programs = Array.isArray(m['clobRewards']) ? (m['clobRewards'] as Record<string, unknown>[]) : [];
  for (const p of programs) {
    const rate = num(p['rewardsDailyRate']);
    const start = typeof p['startDate'] === 'string' ? p['startDate'] : null;
    const end = typeof p['endDate'] === 'string' ? p['endDate'] : null;
    if (rate === null || (start && today < start) || (end && today > end)) continue;
    dailyRate = (dailyRate ?? 0) + rate;
  }
  return {
    marketId,
    minSize: num(m['rewardsMinSize']),
    maxSpread: num(m['rewardsMaxSpread']),
    dailyRate,
  };
}

export async function fetchGammaMarkets(
  conditionIds: string[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const ids of chunk(conditionIds, CHUNK)) {
    const qs = ids.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
    try {
      const res = await fetchImpl(`${GAMMA_URL}?${qs}`);
      if (!res.ok) {
        logger.warn({ status: (res as { status?: number }).status, n: ids.length }, 'gamma chunk not ok, skipping');
        continue;
      }
      const body = await res.json();
      if (Array.isArray(body)) out.push(...(body as Record<string, unknown>[]));
      else logger.warn({ n: ids.length }, 'gamma chunk returned non-array, skipping');
    } catch (e) {
      logger.warn({ e, n: ids.length }, 'gamma chunk failed, skipping');
    }
  }
  return out;
}

export async function snapshotRewards(
  exec: Exec,
  conditionIds: string[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<number> {
  for (const stmt of ENSURE_SQL) await exec(stmt, []);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const markets = await fetchGammaMarkets(conditionIds, fetchImpl);
  let n = 0;
  for (const m of markets) {
    const row = parseRewards(m, today);
    if (!row) continue;
    await exec(
      'INSERT INTO mm_reward_snapshots(time,market_id,min_size,max_spread,daily_rate) VALUES ($1,$2,$3,$4,$5)',
      [now, row.marketId, row.minSize, row.maxSpread, row.dailyRate],
    );
    n += 1;
  }
  logger.info({ requested: conditionIds.length, inserted: n }, 'rewards snapshot');
  return n;
}

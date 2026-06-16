// packages/mm-recorder/src/quoter/persistence.ts
import type { ShadowFill } from './types.js';
import type { EligibilityRow } from './eligibility.js';

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface PnlRow {
  hour: Date; marketId: string; bound: string;
  spreadPnl: number; inventoryPnl: number; estRewards: number | null;
  fills: number; replaces: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_shadow_fills (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  market_id text NOT NULL,
  side smallint NOT NULL,
  bound text NOT NULL,
  price numeric NOT NULL,
  size numeric NOT NULL,
  queue_initial numeric,
  spread_at_placement numeric,
  vol_at_placement numeric,
  flags text NOT NULL DEFAULT '',
  mid_at_fill numeric
);
CREATE INDEX IF NOT EXISTS mm_shadow_fills_tok_time ON mm_shadow_fills(token_id, time);
CREATE TABLE IF NOT EXISTS mm_quoter_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mm_quote_eligibility (
  hour timestamptz NOT NULL,
  market_id text NOT NULL,
  eligible_minutes int NOT NULL,
  quoted_minutes int NOT NULL,
  est_reward numeric,
  PRIMARY KEY (hour, market_id)
);
CREATE TABLE IF NOT EXISTS mm_shadow_pnl (
  hour timestamptz NOT NULL,
  market_id text NOT NULL,
  bound text NOT NULL,
  spread_pnl numeric NOT NULL,
  inventory_pnl numeric NOT NULL,
  est_rewards numeric,
  fills int NOT NULL,
  replaces int NOT NULL,
  PRIMARY KEY (hour, market_id, bound)
);
`;

export class QuoterPersistence {
  constructor(private exec: Exec) {}

  async ensureSchema(): Promise<void> { await this.exec(SCHEMA) }

  async insertFill(f: ShadowFill): Promise<void> {
    await this.exec(
      `INSERT INTO mm_shadow_fills(time,token_id,market_id,side,bound,price,size,queue_initial,spread_at_placement,vol_at_placement,flags,mid_at_fill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [f.time, f.tokenId, f.marketId, f.side, f.bound, f.price, f.size,
       f.queueInitial, f.spreadAtPlacement, f.volAtPlacement, f.flags, f.midAtFill]);
  }

  async upsertState(key: string, value: object): Promise<void> {
    await this.exec(
      `INSERT INTO mm_quoter_state(key,value,updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]);
  }

  async insertEligibility(r: EligibilityRow, estReward: number | null): Promise<void> {
    await this.exec(
      `INSERT INTO mm_quote_eligibility(hour,market_id,eligible_minutes,quoted_minutes,est_reward)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (hour,market_id) DO UPDATE
       SET eligible_minutes = EXCLUDED.eligible_minutes, quoted_minutes = EXCLUDED.quoted_minutes, est_reward = EXCLUDED.est_reward`,
      [r.hour, r.marketId, r.eligibleMinutes, r.quotedMinutes, estReward]);
  }

  async insertPnl(r: PnlRow): Promise<void> {
    // flushHourly runs sub-hourly (every 5 min) and persists per-flush DELTAS, so several
    // rows hit the same (hour,market_id,bound) key within one hour. The additive columns
    // MUST accumulate (add EXCLUDED) so the hour holds the full sum; an overwrite would keep
    // only the last ~5-min slice (~12x undercount) and break the telescoping invariant
    // SUM(spread_pnl)+SUM(inventory_pnl)=Δequity. est_rewards is an absolute estimate, not a
    // delta → it overwrites.
    await this.exec(
      `INSERT INTO mm_shadow_pnl(hour,market_id,bound,spread_pnl,inventory_pnl,est_rewards,fills,replaces)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (hour,market_id,bound) DO UPDATE
       SET spread_pnl = mm_shadow_pnl.spread_pnl + EXCLUDED.spread_pnl,
           inventory_pnl = mm_shadow_pnl.inventory_pnl + EXCLUDED.inventory_pnl,
           est_rewards = EXCLUDED.est_rewards,
           fills = mm_shadow_pnl.fills + EXCLUDED.fills,
           replaces = mm_shadow_pnl.replaces + EXCLUDED.replaces`,
      [r.hour, r.marketId, r.bound, r.spreadPnl, r.inventoryPnl, r.estRewards, r.fills, r.replaces]);
  }
}

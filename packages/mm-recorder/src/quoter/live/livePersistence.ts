import type { Side } from '../types.js';

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface LiveOrderRow {
  time: Date; tokenId: string; orderId: string; side: Side; price: number; size: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired'; ttlExpiresAt: Date;
  reason: string; rewardsConstrained: boolean; exitImprove: boolean;
}

export interface LiveFillRow {
  time: Date; tokenId: string; orderId: string; side: Side;
  fillPrice: number; fillSize: number; queueInitial: number;
  spreadAtPlacement: number | null; midBefore: number | null; flags: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_live_orders (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  order_id text NOT NULL,
  side smallint NOT NULL,
  price numeric NOT NULL,
  size numeric NOT NULL,
  status text NOT NULL,
  ttl_expires_at timestamptz,
  reason text NOT NULL DEFAULT '',
  rewards_constrained boolean NOT NULL DEFAULT false,
  exit_improve boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mm_live_orders_oid ON mm_live_orders(order_id, time);
CREATE TABLE IF NOT EXISTS mm_live_fills (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  order_id text NOT NULL,
  side smallint NOT NULL,
  fill_price numeric NOT NULL,
  fill_size numeric NOT NULL,
  queue_initial numeric,
  spread_at_placement numeric,
  mid_before numeric,
  flags text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mm_live_fills_tok_time ON mm_live_fills(token_id, time);
`;

export class LivePersistence {
  constructor(private exec: Exec) {}

  async ensureSchema(): Promise<void> { await this.exec(SCHEMA); }

  async insertOrder(r: LiveOrderRow): Promise<void> {
    await this.exec(
      `INSERT INTO mm_live_orders(time,token_id,order_id,side,price,size,status,ttl_expires_at,reason,rewards_constrained,exit_improve)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.time, r.tokenId, r.orderId, r.side, r.price, r.size, r.status, r.ttlExpiresAt, r.reason, r.rewardsConstrained, r.exitImprove]);
  }

  async insertFill(r: LiveFillRow): Promise<void> {
    await this.exec(
      `INSERT INTO mm_live_fills(time,token_id,order_id,side,fill_price,fill_size,queue_initial,spread_at_placement,mid_before,flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.time, r.tokenId, r.orderId, r.side, r.fillPrice, r.fillSize, r.queueInitial, r.spreadAtPlacement, r.midBefore, r.flags]);
  }
}

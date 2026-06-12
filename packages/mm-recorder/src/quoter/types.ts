export type Side = -1 | 1; // -1 bid (maker buys), +1 ask (maker sells) — H-MM-3 maker_sign

export interface RewardsParams {
  minSize: number | null;
  maxSpreadCents: number | null; // Gamma reports cents (3.5–4.5)
  dailyRate: number | null;
}

export interface PolicyInput {
  bestBid: number | null;
  bestAsk: number | null;
  recentVol: number;             // max |Δmid| in window (VolTracker)
  msToResolution: number | null; // null = unknown end_date (does not block)
  rewards: RewardsParams | null;
  inventoryShares: number;       // signed, this market
  inventoryNotional: number;     // abs $, this market
  totalNotional: number;         // abs $, all markets
}

export interface DesiredQuote { price: number; size: number; flags: string[] }
export interface DesiredQuotes { bid: DesiredQuote | null; ask: DesiredQuote | null }

export type DrainBound = 'trades' | 'cancels';

export interface ShadowFill {
  time: Date;
  tokenId: string;
  marketId: string;
  side: Side;
  bound: DrainBound;
  price: number;             // placement price (anchored)
  size: number;
  queueInitial: number;
  spreadAtPlacement: number | null;
  volAtPlacement: number;
  flags: string;             // csv: rewards_constrained, exit_improve
  midAtFill: number | null;
}

import type { FLBConfig } from './FLBConfig.js';
import { computeEntryCostPct, computeExecutedNoPrice, computeStake, isoWeekKey } from './flbMath.js';

/** A tail-band market under evaluation; book* fields set only when a fresh NO snapshot was walked. */
export interface FLBCandidate {
  marketId: string;
  marketType: string;
  yesPrice: number;
  spread: number | null;
  ttrHours: number;
  noTokenId: string | null;
  endDate: string;                       // ISO timestamp
  bookExecuted?: boolean;                // set only when a fresh NO snapshot was walked
  bookExecutedNoPrice?: number | null;   // avg price from the book walk
  bookFee?: number;                      // fee from the book walk
  bookSlippagePct?: number;
}

/** Live account/portfolio state for the gate batch; sameWeekOpenCounts keyed by isoWeekKey(endDate). */
export interface FLBContext {
  now: Date;
  initialCapital: number;
  lockedCapital: number;
  openMarketIds: Set<string>;
  sameWeekOpenCounts: Map<string, number>; // isoWeekKey(endDate) -> open count
}

/** Gate verdict; pricing/sizing fields populated only on accept. */
export interface FLBDecision {
  accept: boolean;
  reason?: string;
  executedNoPrice?: number;
  entryCostPct?: number;
  noStake?: number;
  noSize?: number;
  feePaid?: number;
  slippagePct?: number;
  fillSource?: 'spread' | 'orderbook';
  isoWeekKey?: string;
}

export function evaluateSignal(c: FLBCandidate, ctx: FLBContext, cfg: FLBConfig): FLBDecision {
  // flb_0a — eligible market type (active/unresolved is enforced by the scanner query)
  if (!cfg.eligibleTypes.includes(c.marketType)) {
    return { accept: false, reason: 'market_type_not_eligible' };
  }
  // flb_0b — TTR floor
  if (c.ttrHours < cfg.minTtrHours) {
    return { accept: false, reason: 'ttr_below_min' };
  }
  // flb_0c — longshot band
  if (c.yesPrice < cfg.longshotLo || c.yesPrice > cfg.longshotHi) {
    return { accept: false, reason: 'out_of_band' };
  }

  // flb_0d — entry cost: order-book path when a snapshot was walked, else spread path
  let executedNoPrice: number;
  let entryCostPct: number;
  let feePaid = 0;
  let slippagePct = 0;
  let fillSource: 'spread' | 'orderbook';
  const noMid = 1 - c.yesPrice;

  if (c.bookExecuted !== undefined) {   // a book-walk was attempted for this candidate
    if (!c.bookExecuted || c.bookExecutedNoPrice == null) {
      return { accept: false, reason: 'book_unfillable' };
    }
    executedNoPrice = c.bookExecutedNoPrice;
    entryCostPct = ((executedNoPrice - noMid) / noMid) * 100;
    feePaid = c.bookFee ?? 0;
    slippagePct = c.bookSlippagePct ?? 0;
    fillSource = 'orderbook';
  } else {
    if (c.spread == null || c.spread <= 0) {
      return { accept: false, reason: 'no_spread' };
    }
    entryCostPct = computeEntryCostPct(c.spread, c.yesPrice);
    executedNoPrice = computeExecutedNoPrice(c.yesPrice, c.spread);
    fillSource = 'spread';
  }
  if (entryCostPct > cfg.maxEntryCostPct) {
    return { accept: false, reason: 'entry_cost_too_high' };
  }

  // sizing
  const noStake = computeStake(ctx.initialCapital, cfg.maxPositionPct);
  const noSize = noStake / executedNoPrice;
  const weekKey = isoWeekKey(new Date(c.endDate));

  // flb_0e — ISO-week concentration cap
  if ((ctx.sameWeekOpenCounts.get(weekKey) ?? 0) >= cfg.maxSameWeekPositions) {
    return { accept: false, reason: 'same_week_cap' };
  }
  // flb_0f — total locked-capital cap
  const lockedCap = (cfg.maxLockedCapitalPct / 100) * ctx.initialCapital;
  if (ctx.lockedCapital + noStake + feePaid > lockedCap) {
    return { accept: false, reason: 'locked_capital_cap' };
  }
  // flb_0g — no duplicate open position on this market
  if (ctx.openMarketIds.has(c.marketId)) {
    return { accept: false, reason: 'duplicate_market' };
  }

  return {
    accept: true,
    executedNoPrice, entryCostPct, noStake, noSize, feePaid, slippagePct,
    fillSource, isoWeekKey: weekKey,
  };
}

export { isoWeekKey } from './flbMath.js';

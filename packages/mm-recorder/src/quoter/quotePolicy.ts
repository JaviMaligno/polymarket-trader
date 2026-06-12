import type { QuoterConfig } from './config.js';
import type { DesiredQuote, DesiredQuotes, PolicyInput } from './types.js';

const NONE: DesiredQuotes = { bid: null, ask: null };
const round = (p: number, tick: number) => Math.round(p / tick) * tick;

/** Política pura de quoting. Orden de guards: one-sided -> near-resolution ->
 *  vol pause -> spread floor. Después: precio (join-touch / rewards band),
 *  tamaño, e inventario (hard caps suprimen el lado que aumenta; soft cap
 *  permite exit_improve de 1 tick en el lado reductor, nunca cruzando). */
export function desiredQuotes(inp: PolicyInput, cfg: QuoterConfig): DesiredQuotes {
  const { bestBid, bestAsk } = inp;
  if (bestBid === null || bestAsk === null) return NONE;
  if (inp.msToResolution !== null && inp.msToResolution < cfg.nearResolutionMs) return NONE;
  if (inp.recentVol > cfg.volPause) return NONE;
  const spread = bestAsk - bestBid;
  if (spread < cfg.minSpread) return NONE;

  const mid = (bestBid + bestAsk) / 2;
  const size = Math.max(cfg.quoteSize, inp.rewards?.minSize ?? 0);

  const mk = (side: -1 | 1): DesiredQuote => {
    const flags: string[] = [];
    let price = side === -1 ? bestBid : bestAsk;
    const band = inp.rewards?.maxSpreadCents != null ? inp.rewards.maxSpreadCents / 100 : null;
    if (band !== null && Math.abs(mid - price) > band) {
      price = round(side === -1 ? mid - band : mid + band, cfg.tick);
      flags.push('rewards_constrained');
    }
    return { price, size, flags };
  };

  let bid: DesiredQuote | null = mk(-1);
  let ask: DesiredQuote | null = mk(1);

  // Inventario: bid aumenta long; ask reduce long (y viceversa con short).
  const long = inp.inventoryShares > 0;
  const short = inp.inventoryShares < 0;
  const hard = inp.inventoryNotional >= cfg.maxInvPerMarket || inp.totalNotional >= cfg.maxInvTotal;
  if (hard) {
    if (!short) bid = null;  // long o flat: bid aumenta
    if (!long) ask = null;   // short o flat: ask aumenta
  }

  // exit_improve: sobre el soft cap, el lado reductor mejora 1 tick si no cruza.
  if (inp.inventoryNotional >= cfg.softInvPerMarket) {
    if (long && ask) {
      const better = round(ask.price - cfg.tick, cfg.tick);
      if (better > bestBid) { ask = { ...ask, price: better, flags: [...ask.flags, 'exit_improve'] }; }
    }
    if (short && bid) {
      const better = round(bid.price + cfg.tick, cfg.tick);
      if (better < bestAsk) { bid = { ...bid, price: better, flags: [...bid.flags, 'exit_improve'] }; }
    }
  }

  return { bid, ask };
}

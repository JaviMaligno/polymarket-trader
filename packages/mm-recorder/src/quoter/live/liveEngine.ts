import type { BookEvent, BookInput } from '../../types.js';
import type { QuoterConfig } from '../config.js';
import type { RewardsParams, Side } from '../types.js';
import { desiredQuotes } from '../quotePolicy.js';
import { VolTracker } from '../volTracker.js';
import type { OrderGateway } from './orderGateway.js';
import type { LiveLedger } from './liveLedger.js';
import type { RiskGuard } from './riskGuard.js';

export interface LiveEngineDeps {
  cfg: QuoterConfig;
  gateway: OrderGateway;
  ledger: LiveLedger;
  risk: RiskGuard;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
}

export class LiveEngine {
  private vol: VolTracker;
  private mids = new Map<string, number>();
  private subset: Set<string>;

  constructor(private deps: LiveEngineDeps) {
    this.vol = new VolTracker(deps.cfg.volWindowMs);
    this.subset = new Set(deps.cfg.liveSubset);
  }

  async onBook(input: BookInput, row: BookEvent | null): Promise<void> {
    if (this.deps.risk.state() === 'killed') return;
    if (!row || row.mid === null) return;
    const marketId = this.deps.marketByToken.get(input.tokenId) ?? row.marketId;
    if (!this.subset.has(marketId)) return;

    this.vol.add(input.tokenId, row.time, row.mid);
    this.mids.set(marketId, row.mid);
    const endDate = this.deps.endDateByMarket.get(marketId);
    const book = this.deps.ledger.book();
    const desired = desiredQuotes({
      bestBid: row.bestBid, bestAsk: row.bestAsk,
      recentVol: this.vol.recentVol(input.tokenId, input.time),
      msToResolution: endDate ? endDate.getTime() - input.time.getTime() : null,
      rewards: this.deps.rewardsByMarket.get(marketId) ?? null,
      inventoryShares: book.position(marketId),
      inventoryNotional: this.deps.ledger.notional(marketId),
      totalNotional: this.deps.ledger.totalNotional(),
    }, this.deps.cfg);

    for (const side of [-1, 1] as Side[]) {
      const want = side === -1 ? desired.bid : desired.ask;
      const existing = this.deps.gateway.openOrders().find((o) => o.tokenId === input.tokenId && o.side === side);
      if (!want) { if (existing) await this.deps.gateway.cancel(existing.orderId); continue; }
      if (!existing) {
        await this.deps.gateway.postLimit(input.tokenId, side, want.price, want.size);
      } else if (existing.price !== want.price) {
        await this.deps.gateway.replace(existing.orderId, input.tokenId, side, want.price, want.size);
      }
    }
  }

  /** Timer: reconcilia fills, los aplica al ledger, chequea riesgo y expira GTD. */
  async tick(_now: Date): Promise<void> {
    const fills = await this.deps.gateway.pollFills();
    for (const f of fills) {
      const open = this.deps.gateway.getOpen(f.orderId);
      await this.deps.ledger.applyFill(f, {
        queueInitial: open?.queueInitial ?? 0,
        spreadAtPlacement: null,
        midBefore: this.mids.get(this.deps.marketByToken.get(f.tokenId) ?? '') ?? null,
        flags: '',
      });
    }
    if (fills.length > 0) await this.runRiskCheck();
    await this.deps.gateway.expireDue();
  }

  private async runRiskCheck(): Promise<void> {
    const book = this.deps.ledger.book();
    let maxInv = 0;
    const markets = new Set(this.deps.marketByToken.values());
    for (const m of markets) maxInv = Math.max(maxInv, this.deps.ledger.notional(m));
    const openNotional = this.deps.gateway.openOrders().reduce((t, o) => t + o.price * o.size, 0);
    const cumPnl = this.deps.ledger.totalRealized() + this.unrealized(book, markets);
    await this.deps.risk.check({
      totalNotional: this.deps.ledger.totalNotional(),
      maxInvNotional: maxInv,
      totalInvNotional: this.deps.ledger.totalNotional(),
      openNotional, cumPnl, balanceLow: false,
    });
  }

  private unrealized(book: { position(m: string): number; avgPrice(m: string): number }, markets: Set<string>): number {
    let u = 0;
    for (const m of markets) {
      const mid = this.mids.get(m) ?? book.avgPrice(m);
      u += book.position(m) * (mid - book.avgPrice(m));
    }
    return u;
  }
}

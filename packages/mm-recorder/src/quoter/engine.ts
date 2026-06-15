import type { BookEvent, BookInput, TradeEvent } from '../types.js';
import type { BookState } from '../bookState.js';
import type { QuoterConfig } from './config.js';
import type { RewardsParams, Side } from './types.js';
import { desiredQuotes } from './quotePolicy.js';
import { InventoryBook } from './inventoryBook.js';
import { ShadowLedger, type Placement } from './shadowLedger.js';
import { VolTracker } from './volTracker.js';
import { EligibilityTracker } from './eligibility.js';
import type { QuoterPersistence } from './persistence.js';

export interface EngineDeps {
  cfg: QuoterConfig;
  state: BookState;
  persistence: QuoterPersistence;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
}

export class QuoteEngine {
  private ledger: ShadowLedger;
  private vol: VolTracker;
  private eligibility = new EligibilityTracker();
  private inv = { trades: new InventoryBook(), cancels: new InventoryBook() };
  private lastRequote = new Map<string, number>(); // `${tokenId}:${side}` -> ms
  private replaces = 0;
  private droppedFills = 0;
  private mids = new Map<string, number>();
  /**
   * Last known non-null book row per token.
   * Reused when BookState.apply() returns null (top-of-book unchanged) so that
   * TTL expiry and hysteresis re-quotes still fire on silent book events.
   */
  private lastRow = new Map<string, BookEvent>();
  /** Per-(market:bound) fill count since last flush — reset on each flushHourly. */
  private fillsSinceFlush = new Map<string, number>();
  /** Per-(market:bound) realized snapshot as of the last flush — for delta computation. */
  private prevRealized = new Map<string, number>();
  /** Per-(market:bound) unrealized-M2M snapshot as of the last flush — for delta computation. */
  private prevUnrealized = new Map<string, number>();

  constructor(private deps: EngineDeps) {
    // MANDATORY: pass tick to ShadowLedger so price comparisons are grid-aligned.
    this.ledger = new ShadowLedger(deps.cfg.tick);
    this.vol = new VolTracker(deps.cfg.volWindowMs);
  }

  activeQuote(tokenId: string, side: Side) { return this.ledger.active(tokenId, side) }
  inventory(bound: 'trades' | 'cancels'): InventoryBook { return this.inv[bound] }
  /** Current mark-to-market equity (cash + open M2M) for a bound, at last-known mids. */
  equity(bound: 'trades' | 'cancels'): number { return this.inv[bound].equity(this.mids) }

  onBook(input: BookInput, row: BookEvent | null): void {
    const tokenId = input.tokenId;

    // When the top-of-book is unchanged BookState returns null.
    // We still need to handle TTL expiry and hysteresis — use the cached row.
    const effectiveRow: BookEvent | null = row ?? this.lastRow.get(tokenId) ?? null;
    if (!effectiveRow || effectiveRow.mid === null) return;

    // Keep the cache fresh (row.mid may be null for one-sided books — skip vol/mid update then).
    if (row !== null) {
      this.lastRow.set(tokenId, row);
      if (row.mid !== null) {
        this.vol.add(tokenId, row.time, row.mid);
        this.mids.set(row.marketId, row.mid);
      }
    }

    // For TTL/hysteresis checks we always use the current event time from input.
    const eventTime = input.time;
    const marketId = this.deps.marketByToken.get(tokenId) ?? effectiveRow.marketId;
    const endDate = this.deps.endDateByMarket.get(marketId);
    const invBook = this.inv.trades; // policy uses the conservative (trades) bound

    // Build policy input using effectiveRow prices (authoritative last-known top).
    const desired = desiredQuotes({
      bestBid: effectiveRow.bestBid, bestAsk: effectiveRow.bestAsk,
      recentVol: this.vol.recentVol(tokenId, eventTime),
      msToResolution: endDate ? endDate.getTime() - eventTime.getTime() : null,
      rewards: this.deps.rewardsByMarket.get(marketId) ?? null,
      inventoryShares: invBook.position(marketId),
      inventoryNotional: invBook.notional(marketId),
      totalNotional: invBook.totalNotional(),
    }, this.deps.cfg);

    // Eligibility is sampled once per book event (per-book-event sampling undercounts
    // quiet minutes — intentionally conservative (downward bias) for the rewards estimate).
    this.evaluate(tokenId, effectiveRow, eventTime, desired.bid, desired.ask);
  }

  /**
   * Core per-side quote placement / replacement logic.
   * Called from onBook (with desired computed from policy) AND from onTrade (post-fill requote,
   * Fix 3) using the cached lastRow and re-running policy at the trade's event time.
   */
  private evaluate(
    tokenId: string,
    effectiveRow: BookEvent,
    eventTime: Date,
    desiredBid: { price: number; size: number; flags: string[] } | null,
    desiredAsk: { price: number; size: number; flags: string[] } | null,
  ): void {
    const { cfg } = this.deps;
    const marketId = this.deps.marketByToken.get(tokenId) ?? effectiveRow.marketId;

    for (const side of [-1, 1] as Side[]) {
      const want = side === -1 ? desiredBid : desiredAsk;
      const have = this.ledger.active(tokenId, side);
      const nowMs = eventTime.getTime();
      const key = `${tokenId}:${side}`;

      // TTL expiry: force re-place regardless of price change.
      if (have && nowMs - have.time.getTime() >= cfg.orderTtlMs) {
        this.replace(tokenId, side, want, effectiveRow, eventTime, 'ttl');
        continue;
      }

      if (!want) {
        if (have) { this.ledger.cancel(tokenId, side); this.replaces += 1; }
        continue;
      }

      if (!have) {
        this.placeNew(tokenId, marketId, side, want.price, want.size, want.flags, effectiveRow, eventTime);
        continue;
      }

      // Price-out: only re-quote after the hysteresis (requoteMinMs) interval.
      if (have.price !== want.price) {
        const last = this.lastRequote.get(key) ?? -Infinity;
        if (nowMs - last >= cfg.requoteMinMs) {
          this.replace(tokenId, side, want, effectiveRow, eventTime, 'priceout');
        }
        // else: too soon — keep existing quote (hysteresis guard)
      }
      // price unchanged: keep existing quote; queue/priority preserved
    }

    // Eligibility sampling for rewards (both sides must be quoted within band).
    const rw = this.deps.rewardsByMarket.get(marketId);
    if (rw?.dailyRate) {
      const bid = this.ledger.active(tokenId, -1);
      const ask = this.ledger.active(tokenId, 1);
      const band = rw.maxSpreadCents != null ? rw.maxSpreadCents / 100 : Infinity;
      const minSz = rw.minSize ?? 0;
      const mid = effectiveRow.mid!;
      const ok = !!bid && !!ask &&
        Math.abs(mid - bid.price) <= band && Math.abs(ask.price - mid) <= band &&
        bid.size >= minSz && ask.size >= minSz;
      this.eligibility.sample(marketId, eventTime, ok);
    }
  }

  private placeNew(
    tokenId: string, marketId: string, side: Side,
    price: number, size: number, flags: string[],
    bookRow: BookEvent, eventTime: Date,
  ): void {
    const queue = this.deps.state.levelSize(tokenId, side, price) ?? 0;
    const spread = bookRow.bestBid !== null && bookRow.bestAsk !== null
      ? bookRow.bestAsk - bookRow.bestBid : null;
    const p: Placement = {
      tokenId, marketId, side, price, size, queueInitial: queue,
      time: eventTime, spread, vol: this.vol.recentVol(tokenId, eventTime), flags,
    };
    this.ledger.place(p);
    this.lastRequote.set(`${tokenId}:${side}`, eventTime.getTime());
  }

  private replace(
    tokenId: string, side: Side,
    want: { price: number; size: number; flags: string[] } | null,
    bookRow: BookEvent, eventTime: Date, _why: string,
  ): void {
    this.ledger.cancel(tokenId, side);
    this.replaces += 1;
    if (want) {
      const marketId = this.deps.marketByToken.get(tokenId) ?? bookRow.marketId;
      this.placeNew(tokenId, marketId, side, want.price, want.size, want.flags, bookRow, eventTime);
    }
  }

  async onTrade(tr: TradeEvent): Promise<void> {
    if (tr.size === null) return;

    // Fix 1: single call — ShadowLedger.onTrade iterates both sides internally.
    // The per-side level lookup is passed as a closure so each side uses its own quote price.
    const fills = this.ledger.onTrade(
      { tokenId: tr.tokenId, time: tr.time, price: tr.price, size: tr.size },
      (s) => {
        const q = this.ledger.active(tr.tokenId, s);
        return q ? this.deps.state.levelSize(tr.tokenId, s, q.price) : null;
      },
    );

    for (const f of fills) {
      // midAtFill may be null for one-sided books — inventory is marked at cost until a
      // two-sided top appears, so inventoryPnl reads 0 until then.
      f.midAtFill = this.mids.get(f.marketId) ?? null;
      this.inv[f.bound].applyFill(f.marketId, f.side, f.price, f.size);
      // Increment per-(market:bound) fill counter for flushHourly delta.
      const mbKey = `${f.marketId}:${f.bound}`;
      this.fillsSinceFlush.set(mbKey, (this.fillsSinceFlush.get(mbKey) ?? 0) + 1);
      // Fix 2: error containment — a DB failure must not stall the fill pipeline.
      try {
        await this.deps.persistence.insertFill(f);
      } catch {
        this.droppedFills += 1;
      }
    }

    // Fix 3: post-fill requote — if fills occurred and we have a cached row, re-evaluate
    // quotes for this token so consumed sides are re-placed without waiting for the next
    // book event.
    if (fills.length > 0) {
      const row = this.lastRow.get(tr.tokenId);
      if (row) {
        const marketId = this.deps.marketByToken.get(tr.tokenId) ?? row.marketId;
        const endDate = this.deps.endDateByMarket.get(marketId);
        const invBook = this.inv.trades;
        const desired = desiredQuotes({
          bestBid: row.bestBid, bestAsk: row.bestAsk,
          recentVol: this.vol.recentVol(tr.tokenId, tr.time),
          msToResolution: endDate ? endDate.getTime() - tr.time.getTime() : null,
          rewards: this.deps.rewardsByMarket.get(marketId) ?? null,
          inventoryShares: invBook.position(marketId),
          inventoryNotional: invBook.notional(marketId),
          totalNotional: invBook.totalNotional(),
        }, this.deps.cfg);
        this.evaluate(tr.tokenId, row, tr.time, desired.bid, desired.ask);
      }
    }
  }

  onGap(): void { this.ledger.clearAll() }

  /** Hourly flush: eligibility + PnL + state snapshot. Call on a timer. */
  async flushHourly(now: Date): Promise<void> {
    for (const row of this.eligibility.flushHour(now)) {
      const rw = this.deps.rewardsByMarket.get(row.marketId);
      const est = rw?.dailyRate ? (rw.dailyRate * row.eligibleMinutes) / (24 * 60) : null;
      await this.deps.persistence.insertEligibility(row, est);
    }

    // Snapshot replaces delta for this flush (global counter — same value on every row
    // in this flush, not per-market; consumers should SUM one row per flush period).
    const replacesDelta = this.replaces;
    this.replaces = 0;

    const prevHour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 3_600_000);
    for (const bound of ['trades', 'cancels'] as const) {
      const book = this.inv[bound];
      for (const marketId of this.deps.marketByToken.values()) {
        const realizedNow = book.realized(marketId);
        const mbKey = `${marketId}:${bound}`;
        const prev = this.prevRealized.get(mbKey) ?? 0;
        const spreadPnlDelta = realizedNow - prev;
        // inventoryPnl is the DELTA of unrealized open-position M2M since the last flush
        // (NOT an instantaneous snapshot). This makes the column summable: with the
        // accounting identity equity = realized + unrealized, SUM(spreadPnl)+SUM(inventoryPnl)
        // over any window telescopes to the equity change in that window. A snapshot would
        // double-count open M2M across flushes (the SUM(inventory_pnl) trap).
        const mid = this.mids.get(marketId);
        const unrealizedNow = book.position(marketId) *
          ((mid ?? book.avgPrice(marketId)) - book.avgPrice(marketId));
        const prevUnrealized = this.prevUnrealized.get(mbKey) ?? 0;
        const inventoryPnl = unrealizedNow - prevUnrealized;
        const fillsDelta = this.fillsSinceFlush.get(mbKey) ?? 0;

        if (book.position(marketId) === 0 && realizedNow === 0 && fillsDelta === 0) continue;

        await this.deps.persistence.insertPnl({
          hour: prevHour,
          marketId, bound,
          spreadPnl: spreadPnlDelta,
          inventoryPnl,
          estRewards: null,
          fills: fillsDelta,
          replaces: replacesDelta,
        });

        // Advance snapshots so the next flush emits deltas, not cumulative totals.
        this.prevRealized.set(mbKey, realizedNow);
        this.prevUnrealized.set(mbKey, unrealizedNow);
      }
    }
    // Reset per-flush fill counters after writing.
    this.fillsSinceFlush.clear();

    await this.deps.persistence.upsertState('engine', {
      mode: this.deps.cfg.mode, replaces: replacesDelta,
      droppedFills: this.droppedFills,
      equityTrades: this.inv.trades.equity(this.mids),
      equityCancels: this.inv.cancels.equity(this.mids),
    });
  }
}

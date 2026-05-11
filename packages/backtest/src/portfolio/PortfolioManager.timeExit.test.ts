/**
 * Tests for PortfolioManager.closeAgedPositions — time-exit parity with live.
 *
 * Live (StopLossService) closes any position older than MAX_HOLD_TIME_HOURS
 * (default 4h) at the current price. Backtest previously had no such gate,
 * so positions stayed open until market resolution and captured full
 * resolution-price PnL the live system cannot realise.
 *
 * Empirical evidence motivating the fix (2026-05-11):
 * - shadow_trades event_long LONG: 100% WR @ avg +$96 (theoretical)
 * - generator_predictions p2 t-stat event_long LONG @ 4h: -3.16 (anti-edge)
 * - Optuna previously weighted mean_reversion event_long = 1.32 (HIGH)
 *   while the actual 4h-horizon edge was negative.
 */

import { describe, it, expect } from 'vitest';
import { PortfolioManager } from './PortfolioManager.js';
import type { OrderEvent } from '../types/index.js';

function makePM(): PortfolioManager {
  return new PortfolioManager({
    initialCapital: 10_000,
    feeRate: 0.001,
    snapshotIntervalMinutes: 60,
  });
}

function openLongOrder(
  marketId: string,
  tokenId: string,
  price: number,
  size: number,
  filledAt: Date,
): OrderEvent {
  return {
    type: 'ORDER_FILLED',
    timestamp: filledAt,
    data: {
      id: `o_${marketId}_${tokenId}`,
      marketId,
      tokenId,
      side: 'BUY',
      requestedSize: size,
      filledSize: size,
      requestedPrice: price,
      avgFillPrice: price,
      status: 'FILLED',
      type: 'MARKET',
      createdAt: filledAt,
      updatedAt: filledAt,
      fills: [{ size, price, fee: 0, timestamp: filledAt }],
    },
  } as unknown as OrderEvent;
}

describe('PortfolioManager.closeAgedPositions — time-exit at maxHoldHours', () => {
  it('closes a position older than maxHoldMs at the supplied current price', () => {
    const pm = makePM();
    const t0 = new Date('2026-05-08T00:00:00Z');
    pm.handleOrderFilled(openLongOrder('m1', 'tok_yes', 0.30, 100, t0));

    // 5h later — past the 4h horizon
    const t1 = new Date('2026-05-08T05:00:00Z');
    const maxHoldMs = 4 * 60 * 60 * 1000;
    const getPrice = (mid: string, tid: string) =>
      mid === 'm1' && tid === 'tok_yes' ? 0.31 : null;

    const result = pm.closeAgedPositions(t1, maxHoldMs, getPrice);

    expect(result.closedCount).toBe(1);
    expect(result.totalPnl).toBeCloseTo((0.31 - 0.30) * 100, 6);

    const state = pm.getState();
    expect(state.positions.size).toBe(0);

    const trades = pm.getTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].exitPrice).toBe(0.31);
    expect(trades[0].exitTime).toEqual(t1);
    expect(trades[0].holdingPeriodMs).toBe(5 * 60 * 60 * 1000);
  });

  it('does not close positions younger than maxHoldMs', () => {
    const pm = makePM();
    const t0 = new Date('2026-05-08T00:00:00Z');
    pm.handleOrderFilled(openLongOrder('m1', 'tok_yes', 0.30, 100, t0));

    // 2h later — within the 4h horizon
    const t1 = new Date('2026-05-08T02:00:00Z');
    const result = pm.closeAgedPositions(
      t1,
      4 * 60 * 60 * 1000,
      () => 0.31,
    );

    expect(result.closedCount).toBe(0);
    expect(result.totalPnl).toBe(0);
    expect(pm.getState().positions.size).toBe(1);
  });

  it('skips aged positions when no price is available (no fabricated exits)', () => {
    const pm = makePM();
    const t0 = new Date('2026-05-08T00:00:00Z');
    pm.handleOrderFilled(openLongOrder('m1', 'tok_yes', 0.30, 100, t0));

    const t1 = new Date('2026-05-08T10:00:00Z'); // way past horizon
    const result = pm.closeAgedPositions(
      t1,
      4 * 60 * 60 * 1000,
      () => null, // no price available
    );

    expect(result.closedCount).toBe(0);
    expect(pm.getState().positions.size).toBe(1);
  });

  it('closes multiple aged positions atomically', () => {
    const pm = makePM();
    pm.handleOrderFilled(openLongOrder('m1', 'tok1', 0.25, 100, new Date('2026-05-08T00:00:00Z')));
    pm.handleOrderFilled(openLongOrder('m2', 'tok2', 0.40, 100, new Date('2026-05-08T01:00:00Z')));
    pm.handleOrderFilled(openLongOrder('m3', 'tok3', 0.50, 100, new Date('2026-05-08T04:30:00Z')));

    const t1 = new Date('2026-05-08T05:00:00Z');
    const getPrice = (mid: string) => ({ m1: 0.26, m2: 0.42, m3: 0.51 }[mid] ?? null);

    const result = pm.closeAgedPositions(t1, 4 * 60 * 60 * 1000, getPrice);

    // m1 (5h old) and m2 (4h old) close; m3 (30min old) stays
    expect(result.closedCount).toBe(2);
    expect(pm.getState().positions.size).toBe(1);
    expect(pm.getState().positions.has('m3:tok3')).toBe(true);
  });

  it('returns zero work when maxHoldMs <= 0 (feature disabled)', () => {
    const pm = makePM();
    pm.handleOrderFilled(openLongOrder('m1', 'tok_yes', 0.30, 100, new Date('2026-05-08T00:00:00Z')));

    const result = pm.closeAgedPositions(
      new Date('2026-05-15T00:00:00Z'),
      0,
      () => 0.31,
    );

    expect(result.closedCount).toBe(0);
    expect(pm.getState().positions.size).toBe(1);
  });
});

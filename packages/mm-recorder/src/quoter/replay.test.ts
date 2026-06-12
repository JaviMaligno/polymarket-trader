/**
 * Task 13: Replay fixture regression test.
 *
 * Feeds the deterministic synthetic sequence in fixtures/replay-day.json through
 * the QuoteEngine and compares the resulting fill stream against the committed
 * snapshot in fixtures/replay-expected.json.
 *
 * Engine configuration (must match the fixture assumptions in gen-replay.mjs):
 *   MM_QUOTER_MODE=shadow
 *   MM_ORDER_TTL_MS=60000   (60 s — keeps TTL events within the fixture's time span)
 *   M1 rewards: { minSize: 20, maxSpreadCents: 3.5, dailyRate: 50 }
 *   M2: no rewards
 *
 * Running this test twice must produce identical fill sequences (determinism).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { QuoteEngine } from './engine.js';
import { loadConfig } from './config.js';
import { BookState } from '../bookState.js';
import type { BookInput, TradeEvent } from '../types.js';
import type { ShadowFill } from './types.js';

interface FixtureEvent {
  kind: 'book' | 'trade' | 'gap';
  event?: Record<string, unknown>;
}

async function runReplay(): Promise<ShadowFill[]> {
  const events: FixtureEvent[] = JSON.parse(
    readFileSync(new URL('./fixtures/replay-day.json', import.meta.url), 'utf-8'),
  );

  const fills: ShadowFill[] = [];

  const persistence = {
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    insertFill: vi.fn((f: ShadowFill) => { fills.push(f); return Promise.resolve(); }),
    upsertState: vi.fn().mockResolvedValue(undefined),
    insertEligibility: vi.fn().mockResolvedValue(undefined),
    insertPnl: vi.fn().mockResolvedValue(undefined),
  };

  const state = new BookState();
  const engine = new QuoteEngine({
    cfg: loadConfig({
      MM_QUOTER_MODE: 'shadow',
      MM_ORDER_TTL_MS: '60000',  // 60 s so TTL fires within fixture time span
    }),
    state,
    persistence: persistence as never,
    marketByToken: new Map([['T1', 'M1'], ['T2', 'M2']]),
    endDateByMarket: new Map([
      ['M1', new Date('2026-12-31T00:00:00Z')],
      ['M2', new Date('2026-12-31T00:00:00Z')],
    ]),
    rewardsByMarket: new Map([
      ['M1', { minSize: 20, maxSpreadCents: 3.5, dailyRate: 50 }],
    ]),
  });

  for (const e of events) {
    if (e.kind === 'gap') {
      engine.onGap();
    } else if (e.kind === 'book') {
      const raw = e.event as Record<string, unknown>;
      const input: BookInput = { ...raw, time: new Date(raw.time as string) } as BookInput;
      const row = state.apply(input);
      engine.onBook(input, row);
    } else if (e.kind === 'trade') {
      const raw = e.event as Record<string, unknown>;
      const tr: TradeEvent = { ...raw, time: new Date(raw.time as string) } as TradeEvent;
      await engine.onTrade(tr);
    }
  }

  return fills;
}

describe('replay fixture', () => {
  it('replay fixture produces the committed fill sequence (regression)', async () => {
    const fills = await runReplay();
    const expected: ShadowFill[] = JSON.parse(
      readFileSync(new URL('./fixtures/replay-expected.json', import.meta.url), 'utf-8'),
    );
    expect(JSON.parse(JSON.stringify(fills))).toEqual(expected);
  });

  it('replay is deterministic (second run matches first)', async () => {
    const fills1 = await runReplay();
    const fills2 = await runReplay();
    expect(JSON.parse(JSON.stringify(fills1))).toEqual(JSON.parse(JSON.stringify(fills2)));
  });
});

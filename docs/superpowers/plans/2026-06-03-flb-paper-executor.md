# FLB Paper Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a paper-trading executor for the favorite-longshot-bias (FLB) hold-to-resolution strategy: a daily scan opens paper SHORT-longshot (buy-NO) positions with realistic spread-based entry cost, an independent capital sub-ledger, and a reconciler that settles each position on market resolution. Gated `FLB_EXECUTOR_ENABLED=false` by default.

**Architecture:** A new `FLBService` runs two `setInterval` ticks in the dashboard process (scan + reconcile), mirroring the existing `PositionCleanupService`/`StopLossService` pattern. The decision core (config parsing, entry pricing, PnL, gate chain) is pure and unit-tested; thin DB I/O classes (`FLBScanner`, `FLBExecutor`, `FLBReconciler`) wrap it. Positions live in a new `flb_positions` table; capital is tracked in two new `paper_account` columns, fully orthogonal to the 4h trader's `current_capital`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, node-postgres via the shared `query` helper, TimescaleDB. Reuses `OrderBookExecutionSimulator` opportunistically.

**Spec:** `docs/superpowers/specs/2026-06-03-flb-paper-executor-design.md` (read it first).

**Key spec facts the plan depends on (verified 2026-06-03 against the VM DB):**
- `markets.clob_token_id_no` exists (indexed) — NO token id is a direct column.
- `markets.spread` covers 100% of the tail-band universe; `orderbook_snapshots` covers ~2.5%. **Cost engine is `markets.spread`**; the book walk is opportunistic only.
- All `*_PCT` params are in **percentage points** (`5.0` = 5%); formulas divide by 100.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/data-collector/src/database/init/036_flb_positions.sql` | Migration: `flb_positions` table + indexes + `paper_account` columns (fresh-volume only). |
| `packages/dashboard/src/services/FLBConfig.ts` | Pure env-param parsing → `FLBConfig`. |
| `packages/dashboard/src/services/flbMath.ts` | Pure entry-pricing, sizing, PnL, ISO-week helpers. |
| `packages/dashboard/src/services/flbGates.ts` | Pure `evaluateSignal()` gate chain (flb_0a..0g). |
| `packages/dashboard/src/services/FLBScanner.ts` | DB read: select tail-band candidates. |
| `packages/dashboard/src/services/FLBExecutor.ts` | Per-candidate: optional book walk, evaluate, insert position, lock capital. Includes `ensureFLBSchema()`. |
| `packages/dashboard/src/services/FLBReconciler.ts` | Settle resolved positions, release capital, alert on overdue. |
| `packages/dashboard/src/services/FLBService.ts` | Orchestrator: `setInterval` scan+reconcile ticks, singleton, gated. |
| `packages/dashboard/src/server.ts` | Wire `initializeFLBService` into startup. |
| `*.test.ts` (5 files) | TDD coverage per spec §8. |

---

## Task 1: FLBConfig — env parameter parsing

**Files:**
- Create: `packages/dashboard/src/services/FLBConfig.ts`
- Test: `packages/dashboard/src/services/FLBConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getFLBConfig } from './FLBConfig.js';

const FLB_ENV = [
  'FLB_EXECUTOR_ENABLED','FLB_DRY_RUN','FLB_SCAN_INTERVAL_MS','FLB_RECONCILE_INTERVAL_MS',
  'FLB_LONGSHOT_LO','FLB_LONGSHOT_HI','FLB_MIN_TTR_HOURS','FLB_MAX_ENTRY_COST_PCT',
  'FLB_MAX_POSITION_PCT','FLB_MAX_LOCKED_CAPITAL_PCT','FLB_MAX_SAME_WEEK_POSITIONS','FLB_ELIGIBLE_TYPES',
];

describe('getFLBConfig', () => {
  beforeEach(() => { for (const k of FLB_ENV) delete process.env[k]; });

  it('returns documented defaults when env unset', () => {
    const c = getFLBConfig();
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(false);
    expect(c.scanIntervalMs).toBe(21_600_000);
    expect(c.reconcileIntervalMs).toBe(21_600_000);
    expect(c.longshotLo).toBe(0.02);
    expect(c.longshotHi).toBe(0.10);
    expect(c.minTtrHours).toBe(48);
    expect(c.maxEntryCostPct).toBe(1.0);
    expect(c.maxPositionPct).toBe(0.21);
    expect(c.maxLockedCapitalPct).toBe(5.0);
    expect(c.maxSameWeekPositions).toBe(50);
    expect(c.eligibleTypes).toEqual(['crypto_daily','event_financial','event_short','event_long']);
  });

  it('honours FLB_EXECUTOR_ENABLED=true', () => {
    process.env.FLB_EXECUTOR_ENABLED = 'true';
    expect(getFLBConfig().enabled).toBe(true);
  });

  it('parses numeric overrides', () => {
    process.env.FLB_MAX_POSITION_PCT = '0.5';
    process.env.FLB_MAX_SAME_WEEK_POSITIONS = '30';
    const c = getFLBConfig();
    expect(c.maxPositionPct).toBe(0.5);
    expect(c.maxSameWeekPositions).toBe(30);
  });

  it('falls back to default on non-numeric override', () => {
    process.env.FLB_MAX_ENTRY_COST_PCT = 'abc';
    expect(getFLBConfig().maxEntryCostPct).toBe(1.0);
  });

  it('parses eligible types CSV, trimming blanks', () => {
    process.env.FLB_ELIGIBLE_TYPES = 'crypto_daily, event_short ,';
    expect(getFLBConfig().eligibleTypes).toEqual(['crypto_daily','event_short']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/FLBConfig.test.ts`
Expected: FAIL — `getFLBConfig` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/FLBConfig.ts

export interface FLBConfig {
  enabled: boolean;
  dryRun: boolean;
  scanIntervalMs: number;
  reconcileIntervalMs: number;
  longshotLo: number;
  longshotHi: number;
  minTtrHours: number;
  maxEntryCostPct: number;      // percentage points
  maxPositionPct: number;       // percentage points
  maxLockedCapitalPct: number;  // percentage points
  maxSameWeekPositions: number;
  eligibleTypes: string[];
}

function num(envVal: string | undefined, fallback: number): number {
  if (envVal === undefined) return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? n : fallback;
}

export function getFLBConfig(): FLBConfig {
  const typesRaw = process.env.FLB_ELIGIBLE_TYPES;
  const eligibleTypes = typesRaw === undefined
    ? ['crypto_daily', 'event_financial', 'event_short', 'event_long']
    : typesRaw.split(',').map(s => s.trim()).filter(s => s.length > 0);

  return {
    enabled: process.env.FLB_EXECUTOR_ENABLED === 'true',
    dryRun: process.env.FLB_DRY_RUN === 'true',
    scanIntervalMs: num(process.env.FLB_SCAN_INTERVAL_MS, 21_600_000),
    reconcileIntervalMs: num(process.env.FLB_RECONCILE_INTERVAL_MS, 21_600_000),
    longshotLo: num(process.env.FLB_LONGSHOT_LO, 0.02),
    longshotHi: num(process.env.FLB_LONGSHOT_HI, 0.10),
    minTtrHours: num(process.env.FLB_MIN_TTR_HOURS, 48),
    maxEntryCostPct: num(process.env.FLB_MAX_ENTRY_COST_PCT, 1.0),
    maxPositionPct: num(process.env.FLB_MAX_POSITION_PCT, 0.21),
    maxLockedCapitalPct: num(process.env.FLB_MAX_LOCKED_CAPITAL_PCT, 5.0),
    maxSameWeekPositions: num(process.env.FLB_MAX_SAME_WEEK_POSITIONS, 50),
    eligibleTypes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/FLBConfig.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/FLBConfig.ts packages/dashboard/src/services/FLBConfig.test.ts
git commit -m "feat(flb): FLBConfig env parameter parsing"
```

---

## Task 2: flbMath — entry pricing, sizing, PnL, ISO-week

**Files:**
- Create: `packages/dashboard/src/services/flbMath.ts`
- Test: `packages/dashboard/src/services/flbMath.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeEntryCostPct, computeExecutedNoPrice, computeStake, settle, isoWeekKey,
} from './flbMath.js';

describe('flbMath entry pricing', () => {
  it('entry cost pct = (spread/2)/no_mid * 100', () => {
    // yes=0.05 -> no_mid=0.95; spread=0.01 -> half=0.005; 0.005/0.95 = 0.5263%
    expect(computeEntryCostPct(0.01, 0.05)).toBeCloseTo(0.5263, 3);
  });
  it('executed no price = no_mid + spread/2', () => {
    expect(computeExecutedNoPrice(0.05, 0.01)).toBeCloseTo(0.955, 6);
  });
  it('stake = (maxPositionPct/100) * initial', () => {
    expect(computeStake(10000, 0.21)).toBeCloseTo(21, 6);
  });
});

describe('flbMath settle', () => {
  it('NO resolution: gross = no_size - stake, net subtracts fee', () => {
    // stake 21 at executed_no_price 0.955 -> no_size = 21/0.955 = 21.9895
    const noSize = 21 / 0.955;
    const r = settle(21, noSize, 0, 'no');
    expect(r.grossPnl).toBeCloseTo(noSize - 21, 6);
    expect(r.netPnl).toBeCloseTo(noSize - 21, 6);
  });
  it('YES resolution: full wipeout minus fee', () => {
    const r = settle(21, 21.99, 0.1, 'yes');
    expect(r.grossPnl).toBeCloseTo(-21, 6);
    expect(r.netPnl).toBeCloseTo(-21.1, 6);
  });
});

describe('flbMath isoWeekKey', () => {
  it('returns YYYY-Www for a known date (2026-06-03 is ISO week 23)', () => {
    expect(isoWeekKey(new Date('2026-06-03T00:00:00Z'))).toBe('2026-W23');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/flbMath.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/flbMath.ts

/** Half-spread crossing cost as a percentage of NO stake. */
export function computeEntryCostPct(spread: number, yesPrice: number): number {
  const noMid = 1 - yesPrice;
  return ((spread / 2) / noMid) * 100;
}

/** Price actually paid for NO on the spread path = NO mid + half-spread. */
export function computeExecutedNoPrice(yesPrice: number, spread: number): number {
  return (1 - yesPrice) + spread / 2;
}

/** Per-position stake in dollars. maxPositionPct is in percentage points. */
export function computeStake(initialCapital: number, maxPositionPct: number): number {
  return (maxPositionPct / 100) * initialCapital;
}

/** Settle a held NO position at resolution (par). */
export function settle(
  noStake: number, noSize: number, feePaid: number, outcome: 'yes' | 'no',
): { grossPnl: number; netPnl: number } {
  if (outcome === 'no') {
    const payout = noSize * 1.0;
    const grossPnl = payout - noStake;
    return { grossPnl, netPnl: grossPnl - feePaid };
  }
  return { grossPnl: -noStake, netPnl: -noStake - feePaid };
}

/** ISO-8601 week key, e.g. "2026-W23", computed in UTC. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;             // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);       // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date.getTime() - firstThursday.getTime()) / 86_400_000
      - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/flbMath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/flbMath.ts packages/dashboard/src/services/flbMath.test.ts
git commit -m "feat(flb): flbMath entry pricing, sizing, PnL, ISO-week"
```

---

## Task 3: Shadow-parity tie-out test (guards the PnL derivation)

**Files:**
- Test: `packages/dashboard/src/services/flb.shadow-parity.test.ts`

This task adds NO new code — it pins the executor's dollar math to the validated shadow-recorder fractional math (spec §4 "Sanity tie-out").

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { computeExecutedNoPrice, settle } from './flbMath.js';

// Shadow recorder (flb-shadow-snapshot.js) net per unit, zero entry cost:
//   NO  -> entry_yes / (1 - entry_yes)
//   YES -> -1
function shadowNetPerDollar(yes: number, outcome: 'yes' | 'no'): number {
  return outcome === 'no' ? yes / (1 - yes) : -1;
}

describe('FLB executor ties out to the shadow recorder at zero spread', () => {
  for (const yes of [0.02, 0.05, 0.08, 0.10]) {
    it(`NO resolution matches shadow at yes=${yes}`, () => {
      const executedNoPrice = computeExecutedNoPrice(yes, 0); // spread 0
      const stake = 100;
      const noSize = stake / executedNoPrice;
      const { netPnl } = settle(stake, noSize, 0, 'no');
      const perDollar = netPnl / stake;
      expect(perDollar).toBeCloseTo(shadowNetPerDollar(yes, 'no'), 6);
    });
    it(`YES wipeout matches shadow at yes=${yes}`, () => {
      const executedNoPrice = computeExecutedNoPrice(yes, 0);
      const stake = 100;
      const noSize = stake / executedNoPrice;
      const { netPnl } = settle(stake, noSize, 0, 'yes');
      expect(netPnl / stake).toBeCloseTo(shadowNetPerDollar(yes, 'yes'), 6);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/flb.shadow-parity.test.ts`
Expected: PASS (8 assertions). If it fails, the pricing/PnL derivation in Task 2 is wrong — fix Task 2, not the expectation.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/flb.shadow-parity.test.ts
git commit -m "test(flb): shadow-parity tie-out for entry pricing/PnL"
```

---

## Task 4: flbGates — the gate chain (flb_0a..0g)

**Files:**
- Create: `packages/dashboard/src/services/flbGates.ts`
- Test: `packages/dashboard/src/services/flbGates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateSignal, type FLBCandidate, type FLBContext } from './flbGates.js';
import { getFLBConfig } from './FLBConfig.js';
import { isoWeekKey } from './flbMath.js';

const cfg = () => getFLBConfig(); // defaults: band [0.02,0.10], ttr 48, cost 1.0, pos 0.21, locked 5.0, sameWeek 50

function ctx(over: Partial<FLBContext> = {}): FLBContext {
  return {
    now: new Date('2026-06-03T00:00:00Z'),
    initialCapital: 10000,
    lockedCapital: 0,
    openMarketIds: new Set<string>(),
    sameWeekOpenCounts: new Map<string, number>(),
    ...over,
  };
}

function cand(over: Partial<FLBCandidate> = {}): FLBCandidate {
  return {
    marketId: 'm1', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
    ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('evaluateSignal gate chain', () => {
  it('accepts a qualifying spread-path candidate', () => {
    const d = evaluateSignal(cand(), ctx(), cfg());
    expect(d.accept).toBe(true);
    expect(d.fillSource).toBe('spread');
    expect(d.noStake).toBeCloseTo(21, 6);          // 0.21% of 10000
    expect(d.executedNoPrice).toBeCloseTo(0.955, 6);
    expect(d.noSize).toBeCloseTo(21 / 0.955, 6);
    expect(d.entryCostPct).toBeCloseTo(0.5263, 3);
  });

  it('rejects ineligible market type (flb_0a)', () => {
    const d = evaluateSignal(cand({ marketType: 'crypto_intraday' }), ctx(), cfg());
    expect(d.accept).toBe(false);
    expect(d.reason).toBe('market_type_not_eligible');
  });

  it('rejects TTR below min (flb_0b)', () => {
    const d = evaluateSignal(cand({ ttrHours: 24 }), ctx(), cfg());
    expect(d.reason).toBe('ttr_below_min');
  });

  it('rejects out-of-band low (flb_0c)', () => {
    expect(evaluateSignal(cand({ yesPrice: 0.01 }), ctx(), cfg()).reason).toBe('out_of_band');
  });

  it('rejects out-of-band high (flb_0c)', () => {
    expect(evaluateSignal(cand({ yesPrice: 0.15 }), ctx(), cfg()).reason).toBe('out_of_band');
  });

  it('rejects wide spread over cost ceiling (flb_0d)', () => {
    // yes=0.05, spread=0.04 -> cost = 0.02/0.95 = 2.1% > 1.0%
    expect(evaluateSignal(cand({ spread: 0.04 }), ctx(), cfg()).reason).toBe('entry_cost_too_high');
  });

  it('rejects null/zero spread on the spread path (flb_0d)', () => {
    expect(evaluateSignal(cand({ spread: null }), ctx(), cfg()).reason).toBe('no_spread');
    expect(evaluateSignal(cand({ spread: 0 }), ctx(), cfg()).reason).toBe('no_spread');
  });

  it('uses the book-walk price when provided (flb_0d orderbook path)', () => {
    const d = evaluateSignal(
      cand({ bookExecuted: true, bookExecutedNoPrice: 0.953 }), ctx(), cfg());
    expect(d.accept).toBe(true);
    expect(d.fillSource).toBe('orderbook');
    expect(d.executedNoPrice).toBeCloseTo(0.953, 6);
  });

  it('rejects when the book walk is unfillable (flb_0d)', () => {
    const d = evaluateSignal(cand({ bookExecuted: false }), ctx(), cfg());
    expect(d.reason).toBe('book_unfillable');
  });

  it('rejects when ISO-week cap reached (flb_0e)', () => {
    const endDate = '2026-09-01T00:00:00Z';
    const counts = new Map<string, number>([[isoWeekKey(new Date(endDate)), 50]]);
    const d = evaluateSignal(cand({ endDate }), ctx({ sameWeekOpenCounts: counts }), cfg());
    expect(d.reason).toBe('same_week_cap');
  });

  it('rejects when locked-capital cap would be exceeded (flb_0f)', () => {
    // cap = 5% of 10000 = 500; locked 490 + stake 21 = 511 > 500
    const d = evaluateSignal(cand(), ctx({ lockedCapital: 490 }), cfg());
    expect(d.reason).toBe('locked_capital_cap');
  });

  it('rejects a duplicate open market (flb_0g)', () => {
    const d = evaluateSignal(cand({ marketId: 'dup' }),
      ctx({ openMarketIds: new Set(['dup']) }), cfg());
    expect(d.reason).toBe('duplicate_market');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/flbGates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/flbGates.ts
import type { FLBConfig } from './FLBConfig.js';
import { computeEntryCostPct, computeExecutedNoPrice, computeStake, isoWeekKey } from './flbMath.js';

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

export interface FLBContext {
  now: Date;
  initialCapital: number;
  lockedCapital: number;
  openMarketIds: Set<string>;
  sameWeekOpenCounts: Map<string, number>; // isoWeekKey(endDate) -> open count
}

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

  if (c.bookExecuted !== undefined || c.bookExecutedNoPrice != null) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/flbGates.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/flbGates.ts packages/dashboard/src/services/flbGates.test.ts
git commit -m "feat(flb): gate chain flb_0a..0g (pure evaluateSignal)"
```

---

## Task 5: Migration 036 — `flb_positions` + `paper_account` columns

**Files:**
- Create: `packages/data-collector/src/database/init/036_flb_positions.sql`

> `flb_positions` is a low-volume position store, NOT a time-series hypertable — plain table, no `create_hypertable`. Init SQL runs on fresh volumes only; the runtime `ensureFLBSchema()` (Task 6) handles existing volumes, and the VM deploy step (Task 9) runs it manually.

- [ ] **Step 1: Write the migration**

```sql
-- packages/data-collector/src/database/init/036_flb_positions.sql
-- FLB paper-executor position store + capital sub-ledger columns.
-- See docs/superpowers/specs/2026-06-03-flb-paper-executor-design.md
-- Plain table (low volume), NOT a hypertable.

CREATE TABLE IF NOT EXISTS flb_positions (
  id                 BIGSERIAL PRIMARY KEY,
  market_id          TEXT NOT NULL UNIQUE,       -- enforces flb_0g (one position per market)
  market_type        TEXT NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_yes_price    NUMERIC(10,6) NOT NULL,
  entry_no_price     NUMERIC(10,6) NOT NULL,     -- mid NO = 1 - entry_yes_price
  executed_no_price  NUMERIC(10,6) NOT NULL,     -- price actually paid (mid + half-spread or book avg)
  no_size            NUMERIC(18,6) NOT NULL,     -- NO shares = no_stake / executed_no_price
  no_stake           NUMERIC(18,6) NOT NULL,     -- dollars committed (the locked capital)
  fee_paid           NUMERIC(18,6) NOT NULL DEFAULT 0,
  slippage_pct       NUMERIC(10,4),
  fill_source        TEXT,                       -- 'spread' | 'orderbook'
  entry_cost_pct     NUMERIC(10,4),              -- (spread/2)/no_mid, percent; checked by flb_0d
  ttr_hours_at_entry NUMERIC(10,2),
  end_date           TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'open',-- open | resolved | voided
  resolved_at        TIMESTAMPTZ,
  resolution_outcome TEXT,
  gross_pnl          NUMERIC(18,6),
  net_pnl            NUMERIC(18,6),
  hold_days          NUMERIC(10,3)
);

CREATE INDEX IF NOT EXISTS idx_flb_positions_status   ON flb_positions (status);
CREATE INDEX IF NOT EXISTS idx_flb_positions_end_date ON flb_positions (end_date);

ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_locked_capital NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_realized_pnl   NUMERIC(18,6) NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Verify SQL parses (syntax check via a throwaway local psql or eyeball)**

This file is not unit-tested; it is exercised by the lifecycle test's in-memory mock (Task 8) and the VM deploy (Task 9). Confirm it matches the spec §4 DDL exactly.

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/036_flb_positions.sql
git commit -m "feat(flb): migration 036 — flb_positions + paper_account sub-ledger columns"
```

---

## Task 6: FLBExecutor — schema bootstrap + scan-result execution

**Files:**
- Create: `packages/dashboard/src/services/FLBExecutor.ts`
- Test: `packages/dashboard/src/services/FLBExecutor.test.ts`

`FLBExecutor` loads the live context from the DB, optionally augments a candidate with a book walk, calls `evaluateSignal`, and on accept inserts the position and bumps locked capital atomically. `ensureFLBSchema()` runs the migration DDL at runtime (existing volumes).

The tests mock `../database/index.js` so no real DB is needed.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  isDatabaseConfigured: () => true,
}));

import { FLBExecutor } from './FLBExecutor.js';
import { getFLBConfig } from './FLBConfig.js';

beforeEach(() => { queryMock.mockReset(); });

// Helper: route SELECTs by SQL fragment.
function routeReads(opts: { initialCapital?: number; locked?: number; open?: any[]; weeks?: any[] }) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM paper_account')) {
      return { rows: [{ initial_capital: String(opts.initialCapital ?? 10000),
                         flb_locked_capital: String(opts.locked ?? 0) }] };
    }
    if (sql.includes("status = 'open'") && sql.includes('market_id')) {
      return { rows: opts.open ?? [] };
    }
    if (sql.includes('GROUP BY') && sql.includes('end_date')) {
      return { rows: opts.weeks ?? [] };
    }
    if (sql.startsWith('INSERT INTO flb_positions')) return { rowCount: 1, rows: [] };
    if (sql.startsWith('UPDATE paper_account')) return { rowCount: 1, rows: [] };
    return { rows: [] };
  });
}

describe('FLBExecutor.executeCandidates', () => {
  it('inserts a position and locks capital for a qualifying candidate', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm1', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());

    expect(result.opened).toBe(1);
    const insert = queryMock.mock.calls.find(c => String(c[0]).startsWith('INSERT INTO flb_positions'));
    expect(insert).toBeTruthy();
    const lock = queryMock.mock.calls.find(c =>
      String(c[0]).startsWith('UPDATE paper_account') && String(c[0]).includes('flb_locked_capital'));
    expect(lock).toBeTruthy();
    expect(Number((lock as any[])[1][0])).toBeCloseTo(21, 6); // stake added to locked
  });

  it('skips and does not lock capital when a gate rejects', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm2', marketType: 'event_short', yesPrice: 0.50, spread: 0.01, // out of band
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());

    expect(result.opened).toBe(0);
    expect(result.rejected).toBe(1);
    expect(queryMock.mock.calls.some(c => String(c[0]).startsWith('INSERT INTO flb_positions'))).toBe(false);
  });

  it('does not insert in dry-run mode', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    process.env.FLB_DRY_RUN = 'true';
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm3', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());
    delete process.env.FLB_DRY_RUN;

    expect(result.opened).toBe(0);
    expect(result.dryRunIntents).toBe(1);
    expect(queryMock.mock.calls.some(c => String(c[0]).startsWith('INSERT INTO flb_positions'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/FLBExecutor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/FLBExecutor.ts
import { query } from '../database/index.js';
import type { FLBConfig } from './FLBConfig.js';
import { evaluateSignal, isoWeekKey, type FLBCandidate, type FLBContext } from './flbGates.js';

export interface ExecuteResult {
  opened: number;
  rejected: number;
  dryRunIntents: number;
}

export class FLBExecutor {
  /** Runtime DDL for existing volumes (init SQL only runs on fresh volumes). */
  async ensureFLBSchema(): Promise<void> {
    await query(`
      CREATE TABLE IF NOT EXISTS flb_positions (
        id BIGSERIAL PRIMARY KEY,
        market_id TEXT NOT NULL UNIQUE,
        market_type TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        entry_yes_price NUMERIC(10,6) NOT NULL,
        entry_no_price NUMERIC(10,6) NOT NULL,
        executed_no_price NUMERIC(10,6) NOT NULL,
        no_size NUMERIC(18,6) NOT NULL,
        no_stake NUMERIC(18,6) NOT NULL,
        fee_paid NUMERIC(18,6) NOT NULL DEFAULT 0,
        slippage_pct NUMERIC(10,4),
        fill_source TEXT,
        entry_cost_pct NUMERIC(10,4),
        ttr_hours_at_entry NUMERIC(10,2),
        end_date TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at TIMESTAMPTZ,
        resolution_outcome TEXT,
        gross_pnl NUMERIC(18,6),
        net_pnl NUMERIC(18,6),
        hold_days NUMERIC(10,3)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flb_positions_status ON flb_positions (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flb_positions_end_date ON flb_positions (end_date)`);
    await query(`ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_locked_capital NUMERIC(18,6) NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_realized_pnl NUMERIC(18,6) NOT NULL DEFAULT 0`);
  }

  private async loadContext(): Promise<FLBContext> {
    const acct = await query<{ initial_capital: string; flb_locked_capital: string }>(
      'SELECT initial_capital, flb_locked_capital FROM paper_account LIMIT 1');
    const open = await query<{ market_id: string }>(
      "SELECT market_id FROM flb_positions WHERE status = 'open'");
    const weeks = await query<{ week_key: string; n: string }>(`
      SELECT to_char(end_date, 'IYYY"-W"IW') AS week_key, COUNT(*) AS n
      FROM flb_positions WHERE status = 'open' AND end_date IS NOT NULL
      GROUP BY 1`);

    const sameWeekOpenCounts = new Map<string, number>();
    for (const r of weeks.rows) sameWeekOpenCounts.set(r.week_key, Number(r.n));

    return {
      now: new Date(),
      initialCapital: parseFloat(acct.rows[0]?.initial_capital ?? '10000'),
      lockedCapital: parseFloat(acct.rows[0]?.flb_locked_capital ?? '0'),
      openMarketIds: new Set(open.rows.map(r => r.market_id)),
      sameWeekOpenCounts,
    };
  }

  async executeCandidates(candidates: FLBCandidate[], cfg: FLBConfig): Promise<ExecuteResult> {
    const ctx = await this.loadContext();
    let opened = 0, rejected = 0, dryRunIntents = 0;

    for (const c of candidates) {
      const decision = evaluateSignal(c, ctx, cfg);
      if (!decision.accept) {
        rejected++;
        console.log(`[FLB] REJECTED market=${c.marketId} reason=${decision.reason}`);
        continue;
      }
      if (cfg.dryRun) {
        dryRunIntents++;
        console.log(`[FLB] DRY-RUN intent market=${c.marketId} stake=${decision.noStake?.toFixed(2)} cost=${decision.entryCostPct?.toFixed(3)}%`);
        continue;
      }

      const ins = await query(
        `INSERT INTO flb_positions
           (market_id, market_type, entry_yes_price, entry_no_price, executed_no_price,
            no_size, no_stake, fee_paid, slippage_pct, fill_source, entry_cost_pct,
            ttr_hours_at_entry, end_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
         ON CONFLICT (market_id) DO NOTHING`,
        [c.marketId, c.marketType, c.yesPrice, 1 - c.yesPrice, decision.executedNoPrice,
         decision.noSize, decision.noStake, decision.feePaid, decision.slippagePct,
         decision.fillSource, decision.entryCostPct, c.ttrHours, c.endDate]);

      if ((ins.rowCount ?? 0) === 0) { rejected++; continue; } // lost a race / duplicate

      await query(
        'UPDATE paper_account SET flb_locked_capital = flb_locked_capital + $1 WHERE id = 1',
        [(decision.noStake ?? 0) + (decision.feePaid ?? 0)]);

      // keep in-memory ctx consistent across the batch
      ctx.lockedCapital += (decision.noStake ?? 0) + (decision.feePaid ?? 0);
      ctx.openMarketIds.add(c.marketId);
      const wk = decision.isoWeekKey ?? isoWeekKey(new Date(c.endDate));
      ctx.sameWeekOpenCounts.set(wk, (ctx.sameWeekOpenCounts.get(wk) ?? 0) + 1);
      opened++;
      console.log(`[FLB] OPENED market=${c.marketId} type=${c.marketType} stake=${decision.noStake?.toFixed(2)} fill=${decision.fillSource}`);
    }

    return { opened, rejected, dryRunIntents };
  }
}
```

> Note: `isoWeekKey` is re-exported from `flbGates.ts`. Add `export { isoWeekKey } from './flbMath.js';` to the bottom of `flbGates.ts` so the import in this file resolves. (Add that line now.)

- [ ] **Step 4: Add the re-export to `flbGates.ts`**

Append to `packages/dashboard/src/services/flbGates.ts`:
```typescript
export { isoWeekKey } from './flbMath.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/FLBExecutor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/FLBExecutor.ts packages/dashboard/src/services/FLBExecutor.test.ts packages/dashboard/src/services/flbGates.ts
git commit -m "feat(flb): FLBExecutor — context load, gate eval, insert + capital lock, dry-run"
```

---

## Task 7: FLBScanner — select tail-band candidates

**Files:**
- Create: `packages/dashboard/src/services/FLBScanner.ts`
- Test: `packages/dashboard/src/services/FLBScanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  isDatabaseConfigured: () => true,
}));

import { FLBScanner } from './FLBScanner.js';
import { getFLBConfig } from './FLBConfig.js';

beforeEach(() => { queryMock.mockReset(); });

describe('FLBScanner.scan', () => {
  it('maps DB rows to candidates and passes band/ttr/types as params', async () => {
    queryMock.mockResolvedValue({ rows: [{
      id: 'm1', market_type: 'event_short', current_price_yes: '0.05',
      spread: '0.01', clob_token_id_no: 'noTok', end_date: '2026-09-01T00:00:00Z',
      ttr_hours: '96.5',
    }] });

    const scanner = new FLBScanner();
    const cands = await scanner.scan(getFLBConfig());

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      marketId: 'm1', marketType: 'event_short', yesPrice: 0.05,
      spread: 0.01, noTokenId: 'noTok', ttrHours: 96.5,
    });
    const [, params] = queryMock.mock.calls[0];
    expect(params[0]).toBe(0.02);  // lo
    expect(params[1]).toBe(0.10);  // hi
    expect(params[2]).toBe(48);    // minTtrHours
    expect(params[3]).toEqual(['crypto_daily','event_financial','event_short','event_long']);
  });

  it('returns [] when no markets qualify', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await new FLBScanner().scan(getFLBConfig())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/FLBScanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/FLBScanner.ts
import { query } from '../database/index.js';
import type { FLBConfig } from './FLBConfig.js';
import type { FLBCandidate } from './flbGates.js';

interface MarketRow {
  id: string;
  market_type: string;
  current_price_yes: string;
  spread: string | null;
  clob_token_id_no: string | null;
  end_date: string;
  ttr_hours: string;
}

export class FLBScanner {
  async scan(cfg: FLBConfig): Promise<FLBCandidate[]> {
    const res = await query<MarketRow>(
      `SELECT id, market_type, current_price_yes, spread, clob_token_id_no, end_date,
              EXTRACT(EPOCH FROM (end_date - NOW())) / 3600 AS ttr_hours
         FROM markets
        WHERE is_active = true
          AND COALESCE(is_resolved, false) = false
          AND current_price_yes BETWEEN $1 AND $2
          AND end_date > NOW() + ($3 || ' hours')::interval
          AND market_type = ANY($4)`,
      [cfg.longshotLo, cfg.longshotHi, cfg.minTtrHours, cfg.eligibleTypes]);

    return res.rows.map(r => ({
      marketId: r.id,
      marketType: r.market_type,
      yesPrice: parseFloat(r.current_price_yes),
      spread: r.spread == null ? null : parseFloat(r.spread),
      ttrHours: parseFloat(r.ttr_hours),
      noTokenId: r.clob_token_id_no,
      endDate: r.end_date,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/FLBScanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/FLBScanner.ts packages/dashboard/src/services/FLBScanner.test.ts
git commit -m "feat(flb): FLBScanner — tail-band candidate selection"
```

---

## Task 8: FLBReconciler — settle resolved, release capital, alert overdue

**Files:**
- Create: `packages/dashboard/src/services/FLBReconciler.ts`
- Test: `packages/dashboard/src/services/FLBReconciler.test.ts` (also the lifecycle/invariant coverage from spec §8)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  isDatabaseConfigured: () => true,
}));

import { FLBReconciler } from './FLBReconciler.js';

beforeEach(() => { queryMock.mockReset(); });

// Build an open-position row joined with its market.
function openRow(over: Record<string, unknown> = {}) {
  return {
    id: 1, market_id: 'm1', no_size: '105.0', no_stake: '100.0', fee_paid: '0',
    opened_at: '2026-06-01T00:00:00Z', end_date: '2026-09-01T00:00:00Z',
    is_resolved: false, outcome: null, resolved_at: null, ...over,
  };
}

describe('FLBReconciler.run', () => {
  it('settles a NO resolution: status resolved, positive net, capital released', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'no', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });

    const r = await new FLBReconciler().run();
    expect(r.settled).toBe(1);

    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    expect(posUpd!.params).toContain('resolved');
    // net_pnl = no_size - no_stake - fee = 105 - 100 - 0 = 5
    expect(posUpd!.params.some(p => Number(p) === 5)).toBe(true);

    const acctUpd = writes.find(w => w.sql.startsWith('UPDATE paper_account'));
    // releases stake+fee = 100, adds realized 5
    expect(acctUpd!.params.map(Number)).toEqual(expect.arrayContaining([100, 5]));
  });

  it('settles a YES resolution as a full wipeout', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'yes', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });

    await new FLBReconciler().run();
    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    // net_pnl = -100
    expect(posUpd!.params.some(p => Number(p) === -100)).toBe(true);
  });

  it('voids a market resolved to neither yes nor no, refunding the stake', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'invalid', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });

    const r = await new FLBReconciler().run();
    expect(r.voided).toBe(1);
    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    expect(posUpd!.params).toContain('voided');
  });

  it('alerts (does not settle) an overdue-unresolved position', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: false, end_date: '2026-01-01T00:00:00Z' })] }; // long past + 24h
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });

    const r = await new FLBReconciler().run();
    expect(r.alerts).toBe(1);
    expect(r.settled).toBe(0);
    expect(writes.some(w => w.sql.startsWith('UPDATE flb_positions'))).toBe(false);
    warn.mockRestore();
  });

  it('leaves an unresolved, not-yet-overdue position untouched', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow()] }; // unresolved, future end_date
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    const r = await new FLBReconciler().run();
    expect(r.settled + r.voided + r.alerts).toBe(0);
    expect(writes.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/FLBReconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/FLBReconciler.ts
import { query } from '../database/index.js';
import { settle } from './flbMath.js';

export interface ReconcileResult {
  settled: number;
  voided: number;
  alerts: number;
}

interface OpenJoinRow {
  id: number;
  market_id: string;
  no_size: string;
  no_stake: string;
  fee_paid: string;
  opened_at: string;
  end_date: string | null;
  is_resolved: boolean;
  outcome: string | null;
  resolved_at: string | null;
}

export class FLBReconciler {
  async run(): Promise<ReconcileResult> {
    const res = await query<OpenJoinRow>(`
      SELECT f.id, f.market_id, f.no_size, f.no_stake, f.fee_paid, f.opened_at, f.end_date,
             m.is_resolved, lower(m.resolution_outcome) AS outcome, m.resolved_at
        FROM flb_positions f
        JOIN markets m ON m.id = f.market_id
       WHERE f.status = 'open'`);

    let settled = 0, voided = 0, alerts = 0;
    const now = Date.now();

    for (const r of res.rows) {
      const noStake = parseFloat(r.no_stake);
      const feePaid = parseFloat(r.fee_paid);
      const release = noStake + feePaid;

      if (r.is_resolved && (r.outcome === 'yes' || r.outcome === 'no')) {
        const noSize = parseFloat(r.no_size);
        const { grossPnl, netPnl } = settle(noStake, noSize, feePaid, r.outcome);
        const holdDays = r.resolved_at
          ? (new Date(r.resolved_at).getTime() - new Date(r.opened_at).getTime()) / 86_400_000
          : null;

        await query(
          `UPDATE flb_positions
              SET status = $1, resolved_at = $2, resolution_outcome = $3,
                  gross_pnl = $4, net_pnl = $5, hold_days = $6
            WHERE id = $7`,
          ['resolved', r.resolved_at, r.outcome, grossPnl, netPnl, holdDays, r.id]);
        await query(
          `UPDATE paper_account
              SET flb_locked_capital = flb_locked_capital - $1,
                  flb_realized_pnl   = flb_realized_pnl + $2
            WHERE id = 1`,
          [release, netPnl]);
        settled++;
        continue;
      }

      if (r.is_resolved) {
        // resolved to neither yes nor no -> void, refund stake, no PnL
        await query(
          `UPDATE flb_positions
              SET status = $1, resolved_at = $2, gross_pnl = 0, net_pnl = 0
            WHERE id = $3`,
          ['voided', r.resolved_at, r.id]);
        await query(
          `UPDATE paper_account SET flb_locked_capital = flb_locked_capital - $1 WHERE id = 1`,
          [release]);
        voided++;
        continue;
      }

      // unresolved: alert if overdue past end_date + 24h
      if (r.end_date && now > new Date(r.end_date).getTime() + 24 * 3600 * 1000) {
        console.warn(`[FLB] OVERDUE unresolved position market=${r.market_id} end_date=${r.end_date}`);
        alerts++;
      }
    }

    return { settled, voided, alerts };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/FLBReconciler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/FLBReconciler.ts packages/dashboard/src/services/FLBReconciler.test.ts
git commit -m "feat(flb): FLBReconciler — settle/void/alert + capital release"
```

---

## Task 9: FLBService — orchestrator with gated setInterval ticks

**Files:**
- Create: `packages/dashboard/src/services/FLBService.ts`
- Test: `packages/dashboard/src/services/FLBService.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scanMock = vi.fn();
const execMock = vi.fn();
const reconcileMock = vi.fn();
const ensureSchemaMock = vi.fn();

vi.mock('./FLBScanner.js', () => ({ FLBScanner: class { scan = scanMock; } }));
vi.mock('./FLBExecutor.js', () => ({
  FLBExecutor: class { ensureFLBSchema = ensureSchemaMock; executeCandidates = execMock; },
}));
vi.mock('./FLBReconciler.js', () => ({ FLBReconciler: class { run = reconcileMock; } }));
vi.mock('../database/index.js', () => ({ isDatabaseConfigured: () => true, query: vi.fn() }));

import { FLBService } from './FLBService.js';

beforeEach(() => {
  scanMock.mockReset(); execMock.mockReset(); reconcileMock.mockReset(); ensureSchemaMock.mockReset();
  scanMock.mockResolvedValue([]); execMock.mockResolvedValue({ opened: 0, rejected: 0, dryRunIntents: 0 });
  reconcileMock.mockResolvedValue({ settled: 0, voided: 0, alerts: 0 });
  for (const k of ['FLB_EXECUTOR_ENABLED']) delete process.env[k];
});
afterEach(() => vi.useRealTimers());

describe('FLBService', () => {
  it('does nothing when disabled', async () => {
    const svc = new FLBService();
    await svc.start();
    expect(ensureSchemaMock).not.toHaveBeenCalled();
    expect(scanMock).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('ensures schema and runs an initial scan + reconcile when enabled', async () => {
    process.env.FLB_EXECUTOR_ENABLED = 'true';
    const svc = new FLBService();
    await svc.start();
    expect(ensureSchemaMock).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    await svc.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/FLBService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/FLBService.ts
import { isDatabaseConfigured } from '../database/index.js';
import { getFLBConfig } from './FLBConfig.js';
import { FLBScanner } from './FLBScanner.js';
import { FLBExecutor } from './FLBExecutor.js';
import { FLBReconciler } from './FLBReconciler.js';

export class FLBService {
  private scanner = new FLBScanner();
  private executor = new FLBExecutor();
  private reconciler = new FLBReconciler();
  private scanTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;

  async start(): Promise<void> {
    const cfg = getFLBConfig();
    if (!cfg.enabled) {
      console.log('[FLB] disabled (FLB_EXECUTOR_ENABLED=false) — not starting');
      return;
    }
    if (!isDatabaseConfigured()) {
      console.warn('[FLB] database not configured — cannot start');
      return;
    }
    if (this.running) return;
    this.running = true;

    await this.executor.ensureFLBSchema();
    console.log(`[FLB] started (scan ${cfg.scanIntervalMs / 3_600_000}h, reconcile ${cfg.reconcileIntervalMs / 3_600_000}h, dryRun=${cfg.dryRun})`);

    await this.runScan();
    await this.runReconcile();

    this.scanTimer = setInterval(() => { this.runScan().catch(e => console.error('[FLB] scan failed:', e)); }, cfg.scanIntervalMs);
    this.reconcileTimer = setInterval(() => { this.runReconcile().catch(e => console.error('[FLB] reconcile failed:', e)); }, cfg.reconcileIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.scanTimer = this.reconcileTimer = null;
    this.running = false;
  }

  private async runScan(): Promise<void> {
    const cfg = getFLBConfig();
    const candidates = await this.scanner.scan(cfg);
    const r = await this.executor.executeCandidates(candidates, cfg);
    console.log(`[FLB] scan: candidates=${candidates.length} opened=${r.opened} rejected=${r.rejected} dryRun=${r.dryRunIntents}`);
  }

  private async runReconcile(): Promise<void> {
    const r = await this.reconciler.run();
    if (r.settled || r.voided || r.alerts) {
      console.log(`[FLB] reconcile: settled=${r.settled} voided=${r.voided} alerts=${r.alerts}`);
    }
  }
}

let instance: FLBService | null = null;
export function getFLBService(): FLBService {
  if (!instance) instance = new FLBService();
  return instance;
}
export function initializeFLBService(): FLBService {
  return getFLBService();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/FLBService.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/FLBService.ts packages/dashboard/src/services/FLBService.test.ts
git commit -m "feat(flb): FLBService orchestrator (gated scan + reconcile ticks)"
```

---

## Task 10: Wire FLBService into server startup

**Files:**
- Modify: `packages/dashboard/src/server.ts` (after the CircuitBreakerService start block, ~line 1005)

- [ ] **Step 1: Add the import**

Near the other service imports (e.g. next to `getTradingAutomation` import, ~line 23):
```typescript
import { initializeFLBService } from './services/FLBService.js';
```

- [ ] **Step 2: Add the start block**

Immediately after the `circuitBreakerService.start()` block and its `console.log('CircuitBreakerService started');`:
```typescript
      // Start FLBService (favorite-longshot paper executor). Gated: no-op unless
      // FLB_EXECUTOR_ENABLED=true. See docs/superpowers/specs/2026-06-03-flb-paper-executor-design.md
      const flbService = initializeFLBService();
      await flbService.start();
      console.log('FLBService started');
```

- [ ] **Step 3: Type-check the whole package**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full FLB test suite**

Run: `cd packages/dashboard && npx vitest run src/services/FLB src/services/flb`
Expected: all FLB tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(flb): wire FLBService into dashboard startup (gated)"
```

---

## Task 11: Daily-review FLB paper PnL section

**Files:**
- Modify: `scripts/format-review.js` (add an FLB section) and `scripts/daily-review-prompt.md` (document it)

> Verify exact integration points first: read `scripts/format-review.js` to find where sections are appended and how it queries the DB, and `scripts/daily-review.sh` for how data is gathered. Match the existing style.

- [ ] **Step 1: Add an FLB query + formatted section**

Add a query that reports the cohort-segmented FLB paper track (never the pooled row as a verdict), mirroring the spec §11 cohort split:
```sql
SELECT
  CASE WHEN market_type = 'event_long' THEN 'event_long (shadow-only)'
       ELSE 'TRADEABLE (cd/ef/es)' END AS cohort,
  COUNT(*) FILTER (WHERE status = 'open')     AS open_now,
  COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
  ROUND(SUM(net_pnl) FILTER (WHERE status = 'resolved')::numeric, 2) AS realized_net,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'resolved' AND net_pnl > 0)
        / NULLIF(COUNT(*) FILTER (WHERE status = 'resolved'), 0), 1) AS win_rate_pct
FROM flb_positions
GROUP BY 1 ORDER BY 1;
```
Plus a capital line:
```sql
SELECT flb_locked_capital, flb_realized_pnl FROM paper_account LIMIT 1;
```

Render an "FLB Paper Executor" section showing locked capital, realized net, and the
cohort-segmented open/resolved/win-rate. Follow the formatting helpers already in
`format-review.js`.

- [ ] **Step 2: Document the section in the prompt**

In `scripts/daily-review-prompt.md`, add a short note under the metrics description: the FLB
paper track is cost-aware (spread-based) and must be read cohort-segmented — the tradeable
cohort is the verdict-relevant one; never read the pooled or event_long number as the live
verdict.

- [ ] **Step 3: Smoke-test the script locally if a DATABASE_URL is available**

Run (only if you have DB creds): `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/format-review.js`
Expected: the script runs without error and prints the FLB section (empty until the executor is enabled).

- [ ] **Step 4: Commit**

```bash
git add scripts/format-review.js scripts/daily-review-prompt.md
git commit -m "feat(flb): daily-review FLB paper PnL section (cohort-segmented)"
```

---

## Task 12: Final verification + PR

- [ ] **Step 1: Full dashboard test + type-check**

Run: `cd packages/dashboard && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 2: Push and open PR (switch GitHub account first)**

```bash
gh auth switch --user JaviMaligno
git push -u origin feat/flb-paper-executor
gh pr create --title "feat(flb): paper-trading executor (gated off)" \
  --body "Implements docs/superpowers/specs/2026-06-03-flb-paper-executor-design.md. Spread-based realistic cost, independent capital sub-ledger, cohort tradeable+event_long in paper mode. FLB_EXECUTOR_ENABLED=false by default — live promotion stays gated on the tradeable-cohort verdict (n>=100, ~Dec 2026; currently n=5)."
```

- [ ] **Step 3: Deploy schema + image to VM (after merge — do NOT enable yet)**

```bash
# create flb_positions + paper_account columns on the existing volume
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -f - < packages/data-collector/src/database/init/036_flb_positions.sql"
# pull the new dashboard image
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull dashboard-api && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```
> Leave `FLB_EXECUTOR_ENABLED` unset/false. Enabling the paper track (a one-line compose change via PR) is a separate, explicit decision — not part of this build.

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 scope → Tasks 5-10. §3 architecture (in-process setInterval, separate table, gate bypass) → Tasks 6/9. §3 Data Reality (spread cost, clob_token_id_no) → Tasks 4/7. §4 data model → Tasks 5/6. §4 PnL/pricing → Tasks 2/3. §5 gate chain → Task 4. §6 sizing → Tasks 1/2/4. §7 params → Task 1. §8 testing (all named test files: FLBExecutor, FLBScanner, lifecycle/reconciler, shadow-parity) → Tasks 3/4/6/7/8/9. §9 phasing/rollout → Tasks 10/12. §11 verdict/daily-review → Task 11.

**Placeholder scan:** no TBD/TODO; every code step has complete code; the only "verify exact integration points" is Task 11 (format-review.js), which is genuinely codebase-dependent and bounded with explicit queries to add.

**Type consistency:** `FLBCandidate`/`FLBContext`/`FLBDecision`/`FLBConfig` defined once and imported; `evaluateSignal`, `computeStake`, `computeEntryCostPct`, `computeExecutedNoPrice`, `settle`, `isoWeekKey`, `executeCandidates`, `scan`, `run`, `ensureFLBSchema` consistent across tasks. `isoWeekKey` re-exported from `flbGates.ts` (Task 6 step 4) so `FLBExecutor` resolves it. `fill_source` values `'spread'|'orderbook'` consistent. All `*_PCT` divided by 100 in `flbMath`/`flbGates`.

# Concentration Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block same-direction re-entries on the same `market_id` when conviction has not grown by `k × σ_market_type` since the previous close. Empirically saves 63% of post-reset drawdown.

**Architecture:** New `SignalSigmaCache` singleton computes σ per market_type from `signal_predictions` (refreshed every 6 h). New pure helper `shouldBlockReopen` evaluates the rule. `AutoSignalExecutor.processSignal` calls both before opening new positions. `k` is tunable via `OPTIMIZER_CONCENTRATION_K_SIGMA` env var (default 1.0), mirroring the per-type minTrades pattern.

**Tech Stack:** TypeScript + Vitest, pnpm monorepo, PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-04-29-concentration-gate-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/dashboard/src/services/SignalSigmaCache.ts` | Create | Singleton cache of σ per market_type. `start()` schedules refresh; `getSigma(marketType)` returns cached value or 0.3 fallback. |
| `packages/dashboard/src/services/SignalSigmaCache.test.ts` | Create | Tests refresh logic, fallback, lifecycle. |
| `packages/dashboard/src/services/concentrationGate.ts` | Create | Pure helpers `shouldBlockReopen()` and `getKSigma()`. No I/O, no DB. |
| `packages/dashboard/src/services/concentrationGate.test.ts` | Create | Tests rule logic, env var parsing. |
| `packages/dashboard/src/services/AutoSignalExecutor.ts` | Modify (`processSignal`, around line 622, inside the `if (!isClosingExisting)` block) | Insert gate call after the consecutive-loss check; reject with formatted reason. |
| `packages/dashboard/src/services/AutoSignalExecutor.test.ts` | Modify | Integration tests: gate fires/doesn't based on prevCloseSignal. |
| `packages/dashboard/src/server.ts` | Modify (around line 432, alongside other interval setups) | Call `getSignalSigmaCache().start()` at bootstrap. |

No DB migrations, no env vars in docker-compose, no frontend changes.

---

### Task 1: `SignalSigmaCache` — refresh + getSigma + fallback

**Files:**
- Create: `packages/dashboard/src/services/SignalSigmaCache.ts`
- Create: `packages/dashboard/src/services/SignalSigmaCache.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/src/services/SignalSigmaCache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query } from '../database/index.js';
import { SignalSigmaCache } from './SignalSigmaCache.js';

describe('SignalSigmaCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0.3 fallback for any marketType before refresh', () => {
    const cache = new SignalSigmaCache();
    expect(cache.getSigma('event_financial')).toBe(0.3);
    expect(cache.getSigma('crypto_intraday')).toBe(0.3);
    expect(cache.getSigma('totally_unknown')).toBe(0.3);
  });

  it('populates per-type sigma after refresh', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'event_financial', sigma: '0.353' },
        { market_type: 'crypto_intraday', sigma: '0.308' },
      ],
    });

    const cache = new SignalSigmaCache();
    await cache.refresh();

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
    expect(cache.getSigma('crypto_intraday')).toBeCloseTo(0.308);
    expect(cache.getSigma('event_long')).toBe(0.3); // not in result → fallback
  });

  it('keeps prior values if refresh throws', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ market_type: 'event_financial', sigma: '0.353' }],
    });
    const cache = new SignalSigmaCache();
    await cache.refresh();

    (query as any).mockRejectedValueOnce(new Error('db down'));
    await cache.refresh(); // does not throw

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
  });

  it('ignores rows where sigma is null or non-positive', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'event_financial', sigma: '0.353' },
        { market_type: 'sparse_type', sigma: null },
        { market_type: 'zero_type', sigma: '0' },
      ],
    });
    const cache = new SignalSigmaCache();
    await cache.refresh();

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
    expect(cache.getSigma('sparse_type')).toBe(0.3); // null → fallback
    expect(cache.getSigma('zero_type')).toBe(0.3);   // 0 → fallback
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm exec vitest run packages/dashboard/src/services/SignalSigmaCache.test.ts`
Expected: FAIL with "Cannot find module './SignalSigmaCache.js'" or similar.

- [ ] **Step 3: Implement minimal `SignalSigmaCache`**

Create `packages/dashboard/src/services/SignalSigmaCache.ts`:

```typescript
import { query, isDatabaseConfigured } from '../database/index.js';

const FALLBACK_SIGMA = 0.3;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

const REFRESH_QUERY = `
  SELECT m.market_type,
         STDDEV(sp.strength * sp.confidence) AS sigma
  FROM signal_predictions sp
  JOIN markets m ON sp.market_id = m.id
  WHERE sp.time > NOW() - INTERVAL '14 days'
  GROUP BY m.market_type
`;

/**
 * Caches σ(strength × confidence) per market_type, refreshed every 6 h.
 * Used by the concentration gate to decide whether a re-entry signal's conviction
 * has grown by ≥ k × σ vs the previous close-trigger.
 *
 * Fallback: 0.3 for unknown / sparse market_types or before first refresh.
 */
export class SignalSigmaCache {
  private sigmas = new Map<string, number>();
  private interval: NodeJS.Timeout | null = null;

  getSigma(marketType: string): number {
    return this.sigmas.get(marketType) ?? FALLBACK_SIGMA;
  }

  async refresh(): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      const result = await query<{ market_type: string; sigma: string | null }>(REFRESH_QUERY);
      const next = new Map<string, number>();
      for (const row of result.rows) {
        if (row.sigma === null) continue;
        const value = parseFloat(row.sigma);
        if (!Number.isFinite(value) || value <= 0) continue;
        next.set(row.market_type, value);
      }
      this.sigmas = next;
    } catch (err) {
      console.error('[SignalSigmaCache] refresh failed (keeping prior values):', err);
    }
  }

  /** Initialise: refresh once, then schedule periodic refresh. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      this.refresh().catch(err =>
        console.error('[SignalSigmaCache] scheduled refresh threw:', err),
      );
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

let instance: SignalSigmaCache | null = null;
export function getSignalSigmaCache(): SignalSigmaCache {
  if (!instance) instance = new SignalSigmaCache();
  return instance;
}

/** Reset the singleton — used by tests. Not for production code. */
export function __resetSignalSigmaCacheForTests(): void {
  if (instance) instance.stop();
  instance = null;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run packages/dashboard/src/services/SignalSigmaCache.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/SignalSigmaCache.ts packages/dashboard/src/services/SignalSigmaCache.test.ts
git commit -m "feat(sigma-cache): per-type signal sigma cache with periodic refresh"
```

---

### Task 2: Initialise `SignalSigmaCache` at server bootstrap

**Files:**
- Modify: `packages/dashboard/src/server.ts` (find the existing setInterval area near line 432, where other periodic tasks are scheduled)

- [ ] **Step 1: Locate the bootstrap region**

Open `packages/dashboard/src/server.ts` and search for the block where periodic intervals are set up. The comment `// Check for blocking autovacuum every 15 minutes` is the anchor; insert the cache start adjacent.

- [ ] **Step 2: Add the import**

At the top of `packages/dashboard/src/server.ts`, alongside the other service imports, add:

```typescript
import { getSignalSigmaCache } from './services/SignalSigmaCache.js';
```

- [ ] **Step 3: Initialise the cache before the autovacuum block**

Insert immediately before the `setInterval(async () => { ... cancel_blocking_autovacuum ...` block:

```typescript
      // Concentration gate prerequisite: cache σ(strength × confidence) per market_type
      // and refresh every 6 h. See docs/plans/2026-04-29-concentration-gate-design.md.
      try {
        await getSignalSigmaCache().start();
        console.log('[server] SignalSigmaCache started (refresh every 6 h)');
      } catch (err) {
        console.error('[server] SignalSigmaCache start failed (gate will use fallback σ):', err);
      }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(server): initialise SignalSigmaCache at bootstrap"
```

---

### Task 3: `getKSigma()` env-var helper

**Files:**
- Create: `packages/dashboard/src/services/concentrationGate.ts`
- Create: `packages/dashboard/src/services/concentrationGate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/src/services/concentrationGate.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getKSigma } from './concentrationGate.js';

describe('getKSigma', () => {
  beforeEach(() => {
    delete process.env.OPTIMIZER_CONCENTRATION_K_SIGMA;
  });

  it('defaults to 1.0 when env var unset', () => {
    expect(getKSigma()).toBe(1.0);
  });

  it('honours valid env var override', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '1.5';
    expect(getKSigma()).toBe(1.5);
  });

  it('parses 0.5 correctly', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '0.5';
    expect(getKSigma()).toBe(0.5);
  });

  it('falls back to 1.0 on non-numeric env value', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = 'abc';
    expect(getKSigma()).toBe(1.0);
  });

  it('falls back to 1.0 on zero or negative env value', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '0';
    expect(getKSigma()).toBe(1.0);
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '-1';
    expect(getKSigma()).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm exec vitest run packages/dashboard/src/services/concentrationGate.test.ts`
Expected: FAIL with "Cannot find module './concentrationGate.js'".

- [ ] **Step 3: Implement `getKSigma`**

Create `packages/dashboard/src/services/concentrationGate.ts`:

```typescript
const DEFAULT_K = 1.0;

/**
 * Resolves the σ multiplier for the concentration gate.
 * Default 1.0 (empirically the knee of the diminishing-returns curve).
 * Overridable via OPTIMIZER_CONCENTRATION_K_SIGMA.
 * Invalid values (non-numeric, ≤ 0) fall back to 1.0.
 */
export function getKSigma(): number {
  const raw = process.env.OPTIMIZER_CONCENTRATION_K_SIGMA;
  if (raw === undefined) return DEFAULT_K;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_K;
  return parsed;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run packages/dashboard/src/services/concentrationGate.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/concentrationGate.ts packages/dashboard/src/services/concentrationGate.test.ts
git commit -m "feat(concentration): getKSigma env-var helper with fallback"
```

---

### Task 4: `shouldBlockReopen` pure helper

**Files:**
- Modify: `packages/dashboard/src/services/concentrationGate.ts` (extend with new function + types)
- Modify: `packages/dashboard/src/services/concentrationGate.test.ts` (extend with rule tests)

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/src/services/concentrationGate.test.ts`:

```typescript
import { shouldBlockReopen, type PrevCloseSignal, type IncomingSignal } from './concentrationGate.js';

describe('shouldBlockReopen', () => {
  const baseSigma = 0.353; // event_financial empirical
  const baseK = 1.0;

  it('allows when prevClose is null (first action on this market)', () => {
    const sig: IncomingSignal = { direction: 'long', strength: 0.5, confidence: 0.7 };
    expect(shouldBlockReopen(sig, null, baseSigma, baseK)).toBe(false);
  });

  it('allows when direction differs from prev close (legitimate flip)', () => {
    const sig: IncomingSignal = { direction: 'long', strength: 0.5, confidence: 0.7 };
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 };
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(false);
  });

  it('blocks when same direction and conviction equal to prev', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.5, confidence: 0.8 };  // s×c = 0.40
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('blocks when same direction but conviction weaker', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.4, confidence: 0.6 };  // s×c = 0.24
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('blocks when same direction stronger but not by 1σ', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.6, confidence: 0.9 };  // s×c = 0.54
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // delta = 0.14, threshold = 0.40 + 0.353 = 0.753 → 0.54 < 0.753 → block
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('allows when same direction stronger by ≥ 1σ', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.95, confidence: 0.9 }; // s×c = 0.855
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // 0.855 ≥ 0.40 + 0.353 = 0.753 → allow
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(false);
  });

  it('uses absolute values (signed strength does not affect logic)', () => {
    const sig: IncomingSignal = { direction: 'short', strength: -0.5, confidence: 0.8 }; // |s|×c = 0.40
    const prev: PrevCloseSignal = { direction: 'short', strength: -0.5, confidence: 0.8 };
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('honours custom k value', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.6, confidence: 0.9 };  // s×c = 0.54
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // With k=0.5, threshold = 0.40 + 0.5*0.353 = 0.5765 → 0.54 < 0.5765 → still block
    expect(shouldBlockReopen(sig, prev, baseSigma, 0.5)).toBe(true);
    // With k=0.0, threshold = 0.40 → 0.54 > 0.40 → allow
    expect(shouldBlockReopen(sig, prev, baseSigma, 0.0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm exec vitest run packages/dashboard/src/services/concentrationGate.test.ts -t shouldBlockReopen`
Expected: FAIL — `shouldBlockReopen is not a function` or similar.

- [ ] **Step 3: Implement the rule**

Append to `packages/dashboard/src/services/concentrationGate.ts`:

```typescript
export interface IncomingSignal {
  direction: 'long' | 'short';
  strength: number;   // signed; magnitude is what counts
  confidence: number; // 0..1
}

export interface PrevCloseSignal {
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
}

/**
 * Concentration gate: returns true (block) when a same-direction re-entry has
 * conviction not materially stronger than the prior close-trigger on the same market.
 *
 * Rule: block iff prevClose exists AND direction matches AND
 *       |new s×c| < |prev s×c| + (k × sigma).
 *
 * Backtest on 362 closed paper_positions since reset shows k=1.0 catches 126 trades
 * (10% win rate among blocked) with net save ≈ $774 / 21 days = 63% of drawdown.
 */
export function shouldBlockReopen(
  signal: IncomingSignal,
  prevClose: PrevCloseSignal | null,
  sigma: number,
  k: number,
): boolean {
  if (prevClose === null) return false;
  if (signal.direction !== prevClose.direction) return false;

  const newSxC = Math.abs(signal.strength * signal.confidence);
  const prevSxC = Math.abs(prevClose.strength * prevClose.confidence);
  const threshold = prevSxC + k * sigma;

  return newSxC < threshold;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run packages/dashboard/src/services/concentrationGate.test.ts`
Expected: PASS — 13 tests total (5 from Task 3 + 8 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/concentrationGate.ts packages/dashboard/src/services/concentrationGate.test.ts
git commit -m "feat(concentration): shouldBlockReopen pure rule + tests"
```

---

### Task 5: Wire gate into `AutoSignalExecutor.processSignal`

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts` (around line 622, inside the `if (!isClosingExisting)` block, after the consecutive-loss check)
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.test.ts` (add gate scenarios)

- [ ] **Step 1: Write the failing integration tests**

Append to `packages/dashboard/src/services/AutoSignalExecutor.test.ts`:

```typescript
import { getSignalSigmaCache, __resetSignalSigmaCacheForTests } from './SignalSigmaCache.js';

describe('Concentration gate', () => {
  beforeEach(() => {
    __resetSignalSigmaCacheForTests();
    // Pre-populate cache via direct getter mutation (test-only)
    const cache = getSignalSigmaCache();
    (cache as any).sigmas = new Map([
      ['event_financial', 0.353],
    ]);
  });

  it('blocks same-direction re-entry with weaker conviction than prev close', async () => {
    // Mock markets query (first call) + signal_predictions query (second call)
    (query as any)
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
      .mockResolvedValueOnce({ rows: [] }) // consecutive-loss check returns empty
      .mockResolvedValueOnce({
        rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev close: |s×c| = 0.40
      });

    const signal = makeSignal({ direction: 'short', strength: -0.4, confidence: 0.6 }); // |s×c| = 0.24
    const result = await executor.processSignal(signal);

    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/Same-direction re-entry conviction/i);
    expect(result.reason).toMatch(/0\.240/); // newSxC in reason
    expect(result.reason).toMatch(/event_financial/);
  });

  it('allows same-direction re-entry when conviction is ≥ 1σ stronger', async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev: 0.40
      });

    const signal = makeSignal({ direction: 'short', strength: -0.95, confidence: 0.9 }); // 0.855 > 0.40+0.353
    const result = await executor.processSignal(signal);

    // Should pass the gate — actual execution depends on later checks but reason should not be the gate
    if (!result.executed) {
      expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
    }
  });

  it('allows direction flip regardless of conviction', async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ direction: 'short', strength: '-0.8', confidence: '0.9' }], // prev: 0.72 (very strong)
      });

    const signal = makeSignal({ direction: 'long', strength: 0.3, confidence: 0.5 }); // weak but flipped
    const result = await executor.processSignal(signal);

    if (!result.executed) {
      expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
    }
  });

  it('allows when no prior close on this market exists', async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // no prev close

    const signal = makeSignal({ direction: 'long', strength: 0.3, confidence: 0.5 });
    const result = await executor.processSignal(signal);

    if (!result.executed) {
      expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
    }
  });

  it('uses 0.3 fallback σ for unknown market_type', async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_long' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev: 0.40
      });

    // With σ = 0.3 (fallback), threshold = 0.40 + 0.3 = 0.70
    // signal s×c = 0.65 → block
    const signal = makeSignal({ direction: 'short', strength: -0.65, confidence: 1.0 });
    const result = await executor.processSignal(signal);

    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/Same-direction re-entry conviction/i);
    expect(result.reason).toMatch(/event_long/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm exec vitest run packages/dashboard/src/services/AutoSignalExecutor.test.ts -t 'Concentration gate'`
Expected: FAIL — most likely the `Same-direction re-entry conviction` text is not found because the gate is not yet wired in.

- [ ] **Step 3: Add imports to `AutoSignalExecutor.ts`**

At the top of `packages/dashboard/src/services/AutoSignalExecutor.ts`, alongside the other service imports:

```typescript
import { getSignalSigmaCache } from './SignalSigmaCache.js';
import { shouldBlockReopen, getKSigma, type PrevCloseSignal } from './concentrationGate.js';
```

- [ ] **Step 4: Insert the gate after the consecutive-loss block**

Find the existing block in `processSignal`:

```typescript
      // 4b. Per-market consecutive-loss block (new opens only)
      ...
      try {
        const lossResult = await query<{ realized_pnl: string }>(...);
        ...
      } catch {
        // Non-fatal: proceed without the check
      }
```

Immediately after the closing `} catch { ... }` of that block (still inside `if (!isClosingExisting)`), insert:

```typescript
      // 4c. Concentration gate: block same-direction re-entry unless conviction
      // grew by ≥ k × σ since prior close on this market_id.
      // Spec: docs/plans/2026-04-29-concentration-gate-design.md.
      try {
        const prevCloseResult = await query<{ direction: string; strength: string; confidence: string }>(
          `SELECT direction, strength, confidence FROM signal_predictions
           WHERE market_id = $1
             AND metadata->>'action' = 'close'
           ORDER BY time DESC
           LIMIT 1`,
          [signal.marketId],
        );
        const prevClose: PrevCloseSignal | null = prevCloseResult.rows[0]
          ? {
              direction: prevCloseResult.rows[0].direction as 'long' | 'short',
              strength: parseFloat(prevCloseResult.rows[0].strength),
              confidence: parseFloat(prevCloseResult.rows[0].confidence),
            }
          : null;

        const marketType = (signal as any).marketType
          ?? (await query<{ market_type: string }>(
            `SELECT market_type FROM markets WHERE id = $1`,
            [signal.marketId],
          )).rows[0]?.market_type
          ?? 'unknown';

        const sigma = getSignalSigmaCache().getSigma(marketType);
        const k = getKSigma();

        if (shouldBlockReopen(
          { direction: signal.direction, strength: signal.strength, confidence: signal.confidence },
          prevClose,
          sigma,
          k,
        )) {
          const newSxC = Math.abs(signal.strength * signal.confidence);
          const prevSxC = prevClose ? Math.abs(prevClose.strength * prevClose.confidence) : 0;
          const threshold = prevSxC + k * sigma;
          const reason = `Same-direction re-entry conviction not materially stronger (s×c ${newSxC.toFixed(3)} < ${threshold.toFixed(3)} = prev ${prevSxC.toFixed(3)} + ${k.toFixed(2)}σ ${sigma.toFixed(3)}, ${marketType})`;
          return { executed: false, reason };
        }
      } catch (err) {
        console.error('[AutoExecutor] Concentration gate query failed (allowing open):', err);
        // Non-fatal: proceed without the gate rather than blocking on DB error
      }
```

- [ ] **Step 5: Run gate tests to verify pass**

Run: `pnpm exec vitest run packages/dashboard/src/services/AutoSignalExecutor.test.ts -t 'Concentration gate'`
Expected: PASS — 5 new tests.

- [ ] **Step 6: Run all `AutoSignalExecutor` tests to confirm no regression**

Run: `pnpm exec vitest run packages/dashboard/src/services/AutoSignalExecutor.test.ts`
Expected: PASS — preexisting tests + 5 new = all green. Some preexisting tests may break if their `query` mock setup did not anticipate the additional gate query; in that case, extend the `mockResolvedValueOnce` chain in those tests to include an empty result for the gate's `signal_predictions` SELECT (`{ rows: [] }`). Document any such adjustments in the commit message.

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts
git commit -m "feat(executor): wire concentration gate into processSignal"
```

---

### Task 6: Full test suite + cross-package regression check

**Files:** None modified.

- [ ] **Step 1: Run dashboard package full suite**

Run: `pnpm exec vitest run packages/dashboard/src 2>&1 | tail -10`
Expected: all pass. New test count: previous baseline + 4 (SignalSigmaCache) + 13 (concentrationGate: 5 + 8) + 5 (executor gate) = baseline + 22.

- [ ] **Step 2: Run signals package suite (no changes here, defensive check)**

Run: `pnpm exec vitest run packages/signals/src 2>&1 | tail -5`
Expected: same baseline as before this PR.

- [ ] **Step 3: Cross-package typecheck**

Run: `pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: No commit needed** — verification only.

---

### Task 7: Post-deploy verification (after merge + CI deploy)

**Files:** None modified. This task documents the post-deploy check.

- [ ] **Step 1: Verify deploy reached the VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -3"
```

Expected: top commit is the merged PR's squashed commit.

- [ ] **Step 2: Verify `SignalSigmaCache started` log**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 10m dashboard-api 2>&1 | grep 'SignalSigmaCache started'"
```

Expected: a log line `[server] SignalSigmaCache started (refresh every 6 h)`.

- [ ] **Step 3: After 24 h post-deploy, count gate rejections**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 24h dashboard-api 2>&1 | grep -c 'Same-direction re-entry conviction'"
```

Expected: a count > 0. Backtest projection ≈ 6 / day average.

- [ ] **Step 4: After 7 days post-deploy, validate acceptance criterion**

Compare actual blocked count and saved PnL (estimable by tagging blocked-signal market_ids and looking at the next allowed open's PnL on that market) against the projection of ~$258 / week. Acceptance: actual within 50–150 % of projection.

If actual saved PnL is < 50 % of projection, the rule may be too lax in production — investigate signal-predictions match window or σ refresh stability.

If > 150 %, validate by sampling some blocks and confirming they were genuinely repeats and not legitimate re-entries miscategorised — the gate may be too strict in some regime, but high catch rate is itself fine.

---

## Self-Review Notes

The plan was self-reviewed against the spec on completion:

- **Spec coverage**: every section of the design doc has a corresponding task (cache → Task 1, init → Task 2, k env var → Task 3, rule → Task 4, gate wiring → Task 5, regression → Task 6, post-deploy → Task 7).
- **No placeholders**: every step has either explicit code, an exact command with expected output, or a test definition. No "implement X here" without code.
- **Type consistency**: `IncomingSignal` and `PrevCloseSignal` are defined in Task 4 and consumed in Task 5. `getSignalSigmaCache()` is defined in Task 1 and consumed in Tasks 2 + 5. `getKSigma()` defined in Task 3 and consumed in Task 5. `shouldBlockReopen` defined in Task 4 and consumed in Task 5.
- **Mocking compatibility note**: existing tests in `AutoSignalExecutor.test.ts` may need extra `mockResolvedValueOnce({ rows: [] })` calls to satisfy the new gate query; Task 5 Step 6 calls this out.

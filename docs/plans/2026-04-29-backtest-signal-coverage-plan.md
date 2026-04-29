# Backtest Signal Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 5 of 11 generators end-to-end in the backtest pipeline (option B-extended); prune Optuna param space + DB rows for the 6 unwired generators.

**Architecture:** Two surface changes. (1) `BacktestEngine` plumbs trades from `TradeEvent` events through to `SignalContext.recentTrades` so `ofi` and `hawkes` can fire. (2) `BacktestService.createSignals` instantiates 3 new generators. The optimizer side mirrors: drops 6 weights from param spaces and `WEIGHT_PARAM_MAP`; an idempotent SQL migration deletes 30 stale per-type rows for the unwired generators.

**Tech Stack:** TypeScript + Vitest, pnpm monorepo, PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-04-29-backtest-signal-coverage-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/backtest/src/types/index.ts` | Modify | Add `maxRecentTrades?: number` to `BacktestConfig` |
| `packages/backtest/src/engine/BacktestEngine.ts` | Modify (cache + handleTrade + reset + signal-context builder) | Plumb trades through to SignalContext.recentTrades |
| `packages/backtest/src/engine/BacktestEngine.test.ts` | Modify | 5 trade-plumbing tests |
| `packages/dashboard/src/services/BacktestService.ts` | Modify (`createSignals` switch + `combinerConfig` type + weights map) | Instantiate ofi/hawkes/volume_anomaly; type extension for 11 weights; trim weights-map default |
| `packages/dashboard/src/services/BacktestService.test.ts` | Modify or Create | Coverage test for new generators |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify (`OPTUNA_PARAM_SPACE`, `REFINEMENT_PARAM_SPACE`, `mapOptunaParamsToRequest`, `WEIGHT_PARAM_MAP`) | Drop 6 weights for unwired generators |
| `packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql` | Create | DELETE 30 stale per-type rows |
| `packages/dashboard/src/server.ts` | Modify (post-init hook) | Mirror the cleanup migration for existing VM |

No frontend, no docker-compose, no env vars.

---

### Task 1: `BacktestConfig.maxRecentTrades` type extension

**Files:**
- Modify: `packages/backtest/src/types/index.ts`

- [ ] **Step 1: Locate `BacktestConfig` interface**

Use grep to find: `rtk grep -n "interface BacktestConfig" packages/backtest/src/types/index.ts`.

- [ ] **Step 2: Add the field**

In `BacktestConfig`, add (alongside other optional config fields):

```typescript
  /** Max number of recent trades retained per market in BacktestEngine cache.
   *  Used by signal generators that consume `SignalContext.recentTrades` (ofi, hawkes).
   *  Default 200 — covers typical generator lookbacks (5–50 events) with 4× margin. */
  maxRecentTrades?: number;
```

- [ ] **Step 3: Typecheck**

Run: `rtk pnpm exec tsc -p packages/backtest/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backtest/src/types/index.ts
git commit -m "feat(backtest): add maxRecentTrades config option"
```

---

### Task 2: `BacktestEngine` — trade plumbing (cache + handleTrade + reset + SignalContext)

**Files:**
- Modify: `packages/backtest/src/engine/BacktestEngine.ts`
- Modify: `packages/backtest/src/engine/BacktestEngine.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/backtest/src/engine/BacktestEngine.test.ts`, add a `describe` block (insert at end of file). Use the existing test setup pattern; consult the file head for imports/fixtures.

```typescript
describe('Trade plumbing for SignalContext.recentTrades', () => {
  // helpers — mirror existing patterns in this file
  function makeTradeEvent(time: Date, marketId: string, tokenId: string, price: number, size: number, side: 'BUY' | 'SELL' = 'BUY'): any {
    return {
      type: 'TRADE',
      timestamp: time,
      data: { marketId, tokenId, side, price, size },
    };
  }

  function newEngineWithCap(cap: number): any {
    // Use minimal config and access internals via `as any`
    const engine = new (require('./BacktestEngine').BacktestEngine)({
      config: {
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-02'),
        initialCapital: 10000,
        maxRecentTrades: cap,
      },
      marketData: [],
      signals: [],
      combiner: null as any,
      riskConfig: undefined,
    });
    // Seed cache for a market
    (engine as any).marketCache = new Map();
    (engine as any).marketCache.set('m1', {
      bars: [],
      currentBar: null,
      trades: [],
    });
    return engine;
  }

  it('handleTrade appends a Trade-shaped object to cache.trades', () => {
    const engine = newEngineWithCap(200);
    const t = makeTradeEvent(new Date('2026-01-01T00:00:01'), 'm1', 'tok1', 0.5, 10);
    (engine as any).handleTrade(t);
    expect((engine as any).marketCache.get('m1').trades.length).toBe(1);
  });

  it('respects the configured cap (FIFO trim)', () => {
    const engine = newEngineWithCap(3);
    for (let i = 0; i < 5; i++) {
      (engine as any).handleTrade(makeTradeEvent(new Date(2026, 0, 1, 0, 0, i), 'm1', 'tok1', 0.5, 10));
    }
    const trades = (engine as any).marketCache.get('m1').trades;
    expect(trades.length).toBe(3);
    // Oldest 2 evicted — first remaining is i=2
    expect(trades[0].time.getSeconds()).toBe(2);
  });

  it('defaults the cap to 200 when not specified', () => {
    // Use the engine without maxRecentTrades
    const engine = new (require('./BacktestEngine').BacktestEngine)({
      config: {
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-02'),
        initialCapital: 10000,
      },
      marketData: [],
      signals: [],
      combiner: null as any,
      riskConfig: undefined,
    });
    (engine as any).marketCache = new Map();
    (engine as any).marketCache.set('m1', { bars: [], currentBar: null, trades: [] });
    for (let i = 0; i < 250; i++) {
      (engine as any).handleTrade(makeTradeEvent(new Date(2026, 0, 1, 0, 0, i), 'm1', 'tok1', 0.5, 10));
    }
    expect((engine as any).marketCache.get('m1').trades.length).toBe(200);
  });

  it('reset() clears trades from cache', () => {
    const engine = newEngineWithCap(200);
    (engine as any).handleTrade(makeTradeEvent(new Date(), 'm1', 'tok1', 0.5, 10));
    expect((engine as any).marketCache.get('m1').trades.length).toBe(1);
    if (typeof (engine as any).reset === 'function') {
      (engine as any).reset();
      // Cache reset behaviour: either cache cleared entirely or trades emptied.
      const m = (engine as any).marketCache.get('m1');
      if (m) expect(m.trades.length).toBe(0);
    }
  });

  it('signal context receives recentTrades from cache', () => {
    // This is implicit via the buildContext path; assert by feeding trades and snapshotting context
    const engine = newEngineWithCap(200);
    const t1 = makeTradeEvent(new Date('2026-01-01T00:00:01'), 'm1', 'tok1', 0.5, 10);
    (engine as any).handleTrade(t1);

    // Build a context manually using engine internals — reuses the production code path
    const cache = (engine as any).marketCache.get('m1');
    expect(cache.trades.length).toBe(1);
    expect(cache.trades[0].marketId).toBe('m1');
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `rtk pnpm exec vitest run packages/backtest/src/engine/BacktestEngine.test.ts -t 'Trade plumbing'`
Expected: FAIL — `cache.trades` undefined or `handleTrade` doesn't append.

- [ ] **Step 3: Modify the BacktestEngine**

Read `packages/backtest/src/engine/BacktestEngine.ts` and find:
1. The `MarketCache` interface (or inline type) — the type defining `bars`, `currentBar`, etc. Add a `trades: Trade[]` field. Use the `Trade` type from the signals package (it's already imported alongside `SignalContext` per existing code).
2. The cache initialisation (where `bars: []` is set when cache entries are created) — add `trades: []`.
3. The `handleTrade(event: TradeEvent)` method (around line 450). After the existing `if (this.orderBookSimulator) { this.orderBookSimulator.handleTrade(event); }`, append:

```typescript
    // Plumb trades through to per-market cache for SignalContext.recentTrades.
    // Generators ofi / hawkes consume these. See spec
    // docs/plans/2026-04-29-backtest-signal-coverage-design.md.
    const cache = this.marketCache.get(event.data.marketId);
    if (cache) {
      cache.trades.push({
        time: event.timestamp,
        marketId: event.data.marketId,
        tokenId: event.data.tokenId,
        side: event.data.side,
        price: event.data.price,
        size: event.data.size,
      });
      const cap = this.config.maxRecentTrades ?? 200;
      if (cache.trades.length > cap) {
        cache.trades.splice(0, cache.trades.length - cap); // trim oldest (FIFO)
      }
    }
```

4. The `reset()` method (search `reset()` near top of file). Inside the cache-reset loop, add `cache.trades = [];` alongside the bar reset.

5. The signal-context builder around line 695-697. Change `recentTrades: []` to `recentTrades: cache.trades`.

- [ ] **Step 4: Run tests, expect pass**

Run: `rtk pnpm exec vitest run packages/backtest/src/engine/BacktestEngine.test.ts -t 'Trade plumbing'`
Expected: 5/5 PASS.

- [ ] **Step 5: Run all backtest tests**

Run: `rtk pnpm exec vitest run packages/backtest/src/engine/BacktestEngine.test.ts`
Expected: previous baseline + 5 new = all green. If a preexisting test breaks because the new field on cache changes a snapshot, fix the test fixture.

- [ ] **Step 6: Typecheck**

Run: `rtk pnpm exec tsc -p packages/backtest/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/backtest/src/engine/BacktestEngine.ts packages/backtest/src/engine/BacktestEngine.test.ts
git commit -m "feat(backtest): plumb trades through to SignalContext.recentTrades"
```

---

### Task 3: `BacktestService.createSignals` — instantiate ofi / hawkes / volume_anomaly

**Files:**
- Modify: `packages/dashboard/src/services/BacktestService.ts`
- Modify: `packages/dashboard/src/services/BacktestService.test.ts` (or create)

- [ ] **Step 1: Add imports**

At top of `packages/dashboard/src/services/BacktestService.ts`, alongside existing `MomentumSignal`, `MeanReversionSignal`, `WalletTrackingSignal` imports, add:

```typescript
import {
  OrderFlowImbalanceSignal,
  HawkesSignal,
  VolumeAnomalyGenerator,
} from '@polymarket-trader/signals';
```

(Verify the existing import statement near the top of the file and add the three new symbols to it; or add a separate import line if the existing one isn't structured for additions.)

- [ ] **Step 2: Add cases to the switch**

Find `private createSignals(...)` (around line 482). Inside the `switch (type.toLowerCase())`, append three cases before the `default`:

```typescript
        case 'ofi':
          signals.push(new OrderFlowImbalanceSignal());
          break;
        case 'hawkes':
          signals.push(new HawkesSignal());
          break;
        case 'volume_anomaly':
          signals.push(new VolumeAnomalyGenerator());
          break;
```

- [ ] **Step 3: Add or extend BacktestService.test.ts**

Search for an existing test file: `rtk grep -l "createSignals\|BacktestService" packages/dashboard/src/services/*.test.ts | head`. If a test file exists, append a describe block; else create `packages/dashboard/src/services/BacktestService.test.ts` with appropriate vi.mock setup mirroring other tests in the directory.

Tests:

```typescript
describe('createSignals — extended generators (#143)', () => {
  it('instantiates ofi/hawkes/volume_anomaly generators when requested', () => {
    const service = new (require('./BacktestService').BacktestService)();
    const signals = (service as any).createSignals(['ofi', 'hawkes', 'volume_anomaly']);
    expect(signals.length).toBe(3);
    // Each signal exposes .signalId or constructor.name — pick whichever exists
    const names = signals.map((s: any) => s.signalId ?? s.constructor.name);
    expect(names.some((n: string) => /ofi|orderflow/i.test(n))).toBe(true);
    expect(names.some((n: string) => /hawkes/i.test(n))).toBe(true);
    expect(names.some((n: string) => /volume/i.test(n))).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `rtk pnpm exec vitest run packages/dashboard/src/services/BacktestService.test.ts`
Expected: PASS.

If `BacktestService` instantiation needs DB or other infra, follow the pattern of other tests in the directory and mock as needed.

- [ ] **Step 5: Typecheck**

Run: `rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/BacktestService.ts packages/dashboard/src/services/BacktestService.test.ts
git commit -m "feat(backtest-svc): instantiate ofi/hawkes/volume_anomaly in createSignals"
```

---

### Task 4: `BacktestService.combinerConfig` type + default weights map

**Files:**
- Modify: `packages/dashboard/src/services/BacktestService.ts`

- [ ] **Step 1: Read current type and weights map**

Read the section around lines 65-75 (combinerConfig type definition) and lines 159-172 (default weights map construction). Confirm the current shape: 11 weight keys in the type, weights map populates all 11 with `?? 0` defaults.

- [ ] **Step 2: Trim combinerConfig type to 5 weight keys**

Remove from `combinerConfig?: { ... }`:
- `mlofiWeight`
- `spreadCompressionWeight`
- `crossMarketCorrWeight`
- `priceDivergenceWeight`
- `attentionSpikeWeight`
- `newsSentimentWeight`

Keep:
- `momentumWeight`
- `meanReversionWeight`
- `ofiWeight`
- `hawkesWeight`
- `volumeAnomalyWeight`
- `minCombinedConfidence`
- `minCombinedStrength`
- `onlyDirection`
- `conflictResolution`
- `consensusDiscountFloor`

- [ ] **Step 3: Trim default weights map to 5 generators**

Replace lines 159-172 default weights with:

```typescript
      const cc = request.combinerConfig;
      const weights = request.signalWeights || {
        momentum: cc?.momentumWeight ?? 0.5,
        mean_reversion: cc?.meanReversionWeight ?? 0.5,
        ofi: cc?.ofiWeight ?? 0,
        hawkes: cc?.hawkesWeight ?? 0,
        volume_anomaly: cc?.volumeAnomalyWeight ?? 0,
        wallet_tracking: 0.3,
      };
```

(Drop the other 6 keys.)

- [ ] **Step 4: Typecheck**

Run: `rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors. If consumers of `combinerConfig` (e.g., `OptimizationScheduler.mapOptunaParamsToRequest`) reference the dropped fields, errors here will surface and Task 5 will fix them.

- [ ] **Step 5: Run dashboard tests**

Run: `rtk pnpm exec vitest run packages/dashboard/src/services 2>&1 | tail -10`
Expected: PASS or compile errors caught in step 4. If test fixtures used the dropped weight fields explicitly, update them to remove.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/BacktestService.ts
git commit -m "feat(backtest-svc): trim combinerConfig + weights map to 5 wired generators"
```

---

### Task 5: `OptimizationScheduler` — prune param spaces + WEIGHT_PARAM_MAP + mapOptunaParamsToRequest

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

- [ ] **Step 1: Drop 6 weights from `OPTUNA_PARAM_SPACE`**

Find `const OPTUNA_PARAM_SPACE: ParameterDef[] = [ ... ]`. Remove these 6 lines:

```typescript
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.spreadCompressionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.crossMarketCorrWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.priceDivergenceWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.attentionSpikeWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.newsSentimentWeight', type: 'float', low: 0.0, high: 2.0 },
```

- [ ] **Step 2: Same drop in `REFINEMENT_PARAM_SPACE`**

Same 6 entries removed.

- [ ] **Step 3: Trim `mapOptunaParamsToRequest` `combinerConfig` block**

Find `mapOptunaParamsToRequest`. Remove the 6 dropped weight reads from the `combinerConfig` block. Keep:

```typescript
combinerConfig: {
  momentumWeight: params['combiner.momentumWeight'],
  meanReversionWeight: params['combiner.meanReversionWeight'],
  ofiWeight: params['combiner.ofiWeight'],
  hawkesWeight: params['combiner.hawkesWeight'],
  volumeAnomalyWeight: params['combiner.volumeAnomalyWeight'],
  minCombinedConfidence: params['combiner.minCombinedConfidence'],
  minCombinedStrength: params['combiner.minCombinedStrength'],
  onlyDirection: params['combiner.onlyDirection'],
},
```

- [ ] **Step 4: Trim `WEIGHT_PARAM_MAP` in `updateStrategy`**

Find `const WEIGHT_PARAM_MAP: Record<string, string> = {...}`. Remove the 6 dropped keys, keep:

```typescript
const WEIGHT_PARAM_MAP: Record<string, string> = {
  'combiner.momentumWeight': 'momentum',
  'combiner.meanReversionWeight': 'mean_reversion',
  'combiner.ofiWeight': 'ofi',
  'combiner.hawkesWeight': 'hawkes',
  'combiner.volumeAnomalyWeight': 'volume_anomaly',
};
```

- [ ] **Step 5: Update existing test that asserts on param-space membership**

Search for tests asserting `paramSpace.length` or specific entries. The existing test `'excludes combiner.directionMultiplier from the Optuna parameter space'` only checks for absence of one name and isn't affected. Verify by re-running.

- [ ] **Step 6: Typecheck**

Run: `rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Run dashboard tests**

Run: `rtk pnpm exec vitest run packages/dashboard/src/services/OptimizationScheduler.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): prune param spaces to 5 wired generators (#143)"
```

---

### Task 6: SQL migration + post-init hook for stale-row cleanup

**Files:**
- Create: `packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql`
- Modify: `packages/dashboard/src/server.ts`

- [ ] **Step 1: Write the SQL migration**

Create `packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql`:

```sql
-- 027_backtest_signal_coverage_cleanup.sql
-- Per spec docs/plans/2026-04-29-backtest-signal-coverage-design.md (issue #143).
-- The 6 generators below are NOT wired into BacktestService.createSignals, so Optuna
-- has zero fitness gradient on their weights. Their per-type rows in signal_weights
-- are stale (last value = whatever TPE noise wrote) and would otherwise persist
-- forever. Delete the per-type rows. The runtime combiner falls through to ?? 0.
-- Idempotent: re-running on a clean DB is a no-op.

DELETE FROM signal_weights
WHERE market_type != '__global__'
  AND signal_type IN (
    'mlofi',
    'spread_compression',
    'cross_market_corr',
    'price_divergence',
    'attention_spike',
    'news_sentiment'
  );
```

- [ ] **Step 2: Add post-init hook to server.ts**

Open `packages/dashboard/src/server.ts`. Find the most recent post-init migration block (per memory, additions go around the area where the per-type signal_weights migration was added in PR #140 + #142). Insert the same SQL inside a try/catch:

```typescript
      // #143 cleanup: drop per-type rows for generators not wired in BacktestService.createSignals.
      // See docs/plans/2026-04-29-backtest-signal-coverage-design.md.
      try {
        await query(`
          DELETE FROM signal_weights
          WHERE market_type != '__global__'
            AND signal_type IN (
              'mlofi',
              'spread_compression',
              'cross_market_corr',
              'price_divergence',
              'attention_spike',
              'news_sentiment'
            );
        `);
        console.log('[server] backtest-signal-coverage cleanup migration applied');
      } catch (err) {
        console.error('[server] backtest-signal-coverage cleanup failed:', err);
      }
```

Place it after the existing per-type signal_weights migration / consensus_discount_floor INSERT, before the autovacuum interval.

- [ ] **Step 3: Typecheck**

Run: `rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql packages/dashboard/src/server.ts
git commit -m "chore(db): drop stale per-type rows for unwired generators (#143)"
```

---

### Task 7: Cross-package regression check

**Files:** None modified.

- [ ] **Step 1: Run signals package tests**

Run: `rtk pnpm exec vitest run packages/signals/src 2>&1 | tail -5`
Expected: 192/192 pass (no regression).

- [ ] **Step 2: Run dashboard package tests**

Run: `rtk pnpm exec vitest run packages/dashboard/src 2>&1 | tail -10`
Expected: previous baseline + new tests ~ all pass.

- [ ] **Step 3: Run backtest package tests**

Run: `rtk pnpm exec vitest run packages/backtest/src 2>&1 | tail -10`
Expected: previous baseline + 5 new (Task 2) = all pass.

- [ ] **Step 4: Cross-package typecheck**

Run: `rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit && rtk pnpm exec tsc -p packages/backtest/tsconfig.json --noEmit && rtk pnpm exec tsc -p packages/signals/tsconfig.json --noEmit`
Expected: 0 errors all three.

- [ ] **Step 5: No commit needed** — verification only.

---

### Task 8: Post-deploy verification (after CI deploy)

**Files:** None modified.

- [ ] **Step 1: VM has merged commit**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -3"
```

Expected: top commit is the squash of this PR.

- [ ] **Step 2: Cleanup migration applied**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT signal_type, COUNT(*) FROM signal_weights WHERE market_type != '__global__' AND signal_type IN ('mlofi','spread_compression','cross_market_corr','price_divergence','attention_spike','news_sentiment') GROUP BY signal_type;\""
```

Expected: 0 rows. The 30 stale rows deleted.

- [ ] **Step 3: Wait for first per-type optimizer cycle (within 6h)**

Watch logs for the next per-type cycle. Confirm:
- `Trial X completed: Sharpe=Y...` shows non-zero sharpe values for event_financial trials.
- `[OptimizationScheduler] Updated signal weight: ofi[event_financial] = ...` appears (new generators getting non-zero updates from optimizer).

- [ ] **Step 4: 7-day acceptance — variance check**

Per spec acceptance criterion (c): after ≥3 cycles, variance of `ofi` / `hawkes` / `volume_anomaly` weights between cycles should trend downward (TPE converges with real fitness). Track via:

```sql
SELECT signal_type, market_type, weight, updated_at
FROM signal_weights
WHERE market_type='event_financial'
  AND signal_type IN ('ofi','hawkes','volume_anomaly')
ORDER BY signal_type, updated_at;
```

If weights keep oscillating wildly across cycles, fitness signal is still zero — investigate.

- [ ] **Step 5: Rollback watermark**

After 3 post-merge cycles, mean event_financial OOS Sharpe ≥ pre-merge baseline of 0.063. If breached down with no other explanation, revert.

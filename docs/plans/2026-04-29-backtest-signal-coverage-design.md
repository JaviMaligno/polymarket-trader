# Backtest signal coverage — Design (Issue #143, B-extended)

**Status**: **DEFERRED 2026-04-29**. Spec is complete and reviewed but de-prioritized. During brainstorm review against actual trading problems, the user concluded that shadow execution realism (`project_shadow_execution_realism.md`) and other root-cause levers move the trading needle more than this incremental optimizer cleanup. Re-evaluate after those land.

When resumed: this spec is implementation-ready, no further design needed. Skip to writing-plans.
**Closes**: Issue #143 (partial — 5 of 11 generators wired; the remaining 6 documented as out-of-scope follow-ups).
**Branch**: `feat/backtest-signal-coverage`.

## Goal

After PR #140 (per-type optimizer) the Optuna parameter space includes weights for all 11 active signal generators. But `BacktestService.createSignals()` only instantiates `momentum`, `mean_reversion`, `wallet_tracking`. Furthermore, `BacktestEngine` builds the `SignalContext` with `recentTrades: []` and `orderBook: undefined`, so even generators that need *only* trades return `null` on every iteration.

Result: Optuna proposes weights for `ofi`, `mlofi`, `hawkes`, `volume_anomaly`, `spread_compression`, `cross_market_corr`, `price_divergence`, `attention_spike`, `news_sentiment` but **none of them produce signal in the backtest, so their weights have zero fitness gradient**. The TPE sampler writes random values that get persisted as per-type weights and drive runtime trading.

This design wires 5 of those 11 generators end-to-end (option **B-extended** chosen during brainstorming) and documents the precise blocker for the remaining 6.

## Scope (in)

Wire the following **5 generators** into the backtest signal pipeline:

| Generator | Already wired? | Source it consumes |
|---|---|---|
| `momentum` | yes | `priceBars` |
| `mean_reversion` | yes | `priceBars` |
| `volume_anomaly` | no | `priceBars[].volume` (already in `MarketData.bars` from `price_history.volume`) |
| `ofi` (trade-only mode) | no | `recentTrades` (currently empty) |
| `hawkes` | no | `recentTrades` (currently empty) |

To enable `ofi` and `hawkes`, plumb trades through `BacktestEngine` so `SignalContext.recentTrades` is populated.

## Scope (out — documented in `project_backtest_signal_coverage.md`)

These 6 generators stay un-wired. The Optuna parameter space drops their weights so the optimizer no longer proposes values for them, and their existing per-type DB rows are deleted so the runtime combiner falls through to `?? 0` for them.

| Generator | Concrete blocker | Estimated next-step effort |
|---|---|---|
| `mlofi` | `MarketData` has no orderBook snapshots; the table `order_book_snapshots` exists but is not joined in `fetchHistoricalData` | Half-day: extend the SQL join + extend `MarketData` with `orderBook[]`, pass to `SignalContext.orderBook` |
| `spread_compression` | Same — needs orderBook bid/ask | Same half-day; shares plumbing with `mlofi` |
| `cross_market_corr` | `BacktestService` preloads multi-market data but `SignalContext` only carries one market at a time; needs `relatedMarkets[]` populated | Medium bocado: select related markets per category or pre-computed correlation, pass through context |
| `price_divergence` | Needs underlying-asset feeds (e.g., spot CLOB of BTC for crypto markets); no flow into backtest | Multi-session: design feed schema + storage + backfill |
| `attention_spike` | Needs Google Trends / social signals; no flow into backtest | Multi-session + external dependencies |
| `news_sentiment` | Sentiment data exists in production (NewsSentimentGenerator reads from `context.custom`), but the backtest path does not populate it | Medium bocado: pass pre-computed sentiment from DB through `SignalContext.custom` |

## Soft concerns (not blockers, worth empirical check post-deploy)

- **Volume reliability**: `price_history.volume` may come from real bar data (with volume) or from snapshot writes (volume = 0). If most bars in the training window are snapshots, `volume_anomaly`'s z-score guard (`stddev === 0`) silences it. Architecture is fine; data quality is the open question.
- **OFI quality cap**: trade-only mode reduces dataQuality by 30% per `OrderFlowImbalanceSignal.ts:112`. Functional but suboptimal until orderBook plumbing arrives.

## Architecture changes

### 1. `BacktestEngine` — trade plumbing

Add `trades: Trade[]` to the per-market cache (`MarketCache` in `engine/BacktestEngine.ts`).

- In `handleTrade(event: TradeEvent)`: append a `Trade`-shaped object to `cache.trades`, then trim to the configured cap (default 200, configurable via `BacktestConfig.maxRecentTrades`).
- In `reset()`: clear `cache.trades = []`.
- In the signal-context builder (around line 675-697): pass `recentTrades: cache.trades` instead of `[]`.
- Adapt `TradeEvent.data` → `Trade` (the signals package type) inside `handleTrade`. If the shapes already align this is a direct push; if not, a single-line mapper.

The 200-trade cap covers all current generator lookbacks (OFI default 5, Hawkes uses ~20-50 events) with a 4× margin. ~32 bytes × 200 trades × ~50 markets ≈ 320 KB peak — negligible vs the 200 MB dashboard memory budget.

### 2. `BacktestService.createSignals` — instantiate the 3 new generators

Add cases for `ofi`, `hawkes`, `volume_anomaly` to the switch in `createSignals()`. Use default parameters (no per-generator config wired through `BacktestRequest` for now — that's a future scope expansion if needed).

The default `signalTypes` in `BacktestService` (currently `['momentum', 'mean_reversion']` per `defaultSignalTypes`) expands to include the 3 new ones so optimizer trials use all 5 by default.

### 3. `OptimizationScheduler` — prune param space

`OPTUNA_PARAM_SPACE` (line 39) drops 6 entries:
- `combiner.mlofiWeight`
- `combiner.spreadCompressionWeight`
- `combiner.crossMarketCorrWeight`
- `combiner.priceDivergenceWeight`
- `combiner.attentionSpikeWeight`
- `combiner.newsSentimentWeight`

Same 6 dropped from `REFINEMENT_PARAM_SPACE`.

`mapOptunaParamsToRequest` keeps only the 5 wired weights in its `combinerConfig` block.

`WEIGHT_PARAM_MAP` in `updateStrategy` reduces to 5 entries — Optuna no longer writes the 6 dropped ones.

### 4. `BacktestService.runBacktest` — combiner weights map

Lines 159-172 currently construct a default weights map that includes all 11 generator entries with `?? 0` defaults. Trimmed to 5 entries (the wired generators) for clarity. Kept as a defensive default; `signalWeights` from the request still overrides.

### 5. SQL migration — DB cleanup

New init file `packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql`:

```sql
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

Mirror as post-init hook in `packages/dashboard/src/server.ts` (idempotent — re-running on a clean DB is a no-op).

### 6. Memory ledger

New project memory `project_backtest_signal_coverage.md` mirrors the in/out-of-scope tables above and tracks status as future PRs cross those rows. Cross-link from `project_optimizer_followups.md` and update `MEMORY.md` index.

## Tests

### `BacktestEngine.test.ts` — new cases

- **Trade event accumulation**: feed N trade events, assert `cache.trades.length === min(N, cap)`.
- **Cap respected**: feed cap+10 events, assert oldest 10 evicted (FIFO).
- **`SignalContext.recentTrades` populated**: assert `context.recentTrades.length > 0` after one TRADE event.
- **`reset()` clears trades**: feed events, call reset, assert empty.
- **Configurable cap**: pass `maxRecentTrades = 50` in config, assert cap honored.

### `BacktestService.test.ts` — `createSignals` coverage

- Pass `signalTypes = ['ofi', 'hawkes', 'volume_anomaly']` and assert returned `ISignal[]` contains the 3 instances.

### Integration smoke

End-to-end backtest with synthetic `MarketData` containing trades and bars. Assert `result.trades.length > 0` (real signals fire, not all `null`).

## Acceptance criteria

(a) **Per-task**: every TDD cycle red→green; `pnpm vitest run` and `pnpm tsc --noEmit` clean across the affected packages (`packages/backtest`, `packages/dashboard`).

(b) **Immediate post-merge** (within first per-type cycle, ~6h):
- Logs of Optuna trial output show `sharpe ≠ 0` for event_financial trials (signal that the new generators contribute to backtest score).
- SQL `SELECT signal_type, weight FROM signal_weights WHERE market_type='event_financial' AND signal_type IN ('ofi','hawkes','volume_anomaly')` shows values different from the pre-merge bootstrap (TPE explored with real fitness).

(c) **Medium-term** (≥3 post-merge cycles, ~1 week):
- Variance of `ofi`/`hawkes`/`volume_anomaly` weights between cycles trends downward (TPE converges with fitness pressure). If they keep oscillating randomly, the fitness signal is still zero and the wiring is broken.

(d) **No-regression**:
- Backtest cycle wall-clock does not regress more than 2× on the e2-micro VM.
- dashboard-api memory stays under 200 MB.

(e) **Rollback criteria** (provisional, soft watermark):
- After 3 post-merge cycles, mean event_financial OOS Sharpe ≥ pre-merge baseline of 0.063. If breached down with no other explanation (e.g., a market regime shift), revert the PR.
- Other market_types not gated — sample sizes too small to set targets yet.

## Out of scope (revisit in separate brainstorms)

- Order book plumbing for `mlofi` and `spread_compression` (next natural bocado after this PR).
- Cross-market context (`cross_market_corr`).
- External-data feeds (`price_divergence`, `attention_spike`, `news_sentiment`).
- The structural problem in issue #145 (`updateStrategy` redeploys global thresholds 5× per cycle, last-in wins).
- Adaptive OOS thresholds (issue #147 picked the pragmatic per-type floor; principled fix is separate).

## Sub-projects

This is a single self-contained PR — no decomposition.

## Files touched

| Path | Change | Responsibility |
|---|---|---|
| `packages/backtest/src/engine/BacktestEngine.ts` | Modify | Add `cache.trades`, append in `handleTrade`, trim to cap, populate `SignalContext.recentTrades` |
| `packages/backtest/src/engine/BacktestEngine.test.ts` | Modify | New trade-plumbing tests |
| `packages/backtest/src/types/index.ts` | Modify | Add `BacktestConfig.maxRecentTrades?: number` (default 200 in engine) |
| `packages/dashboard/src/services/BacktestService.ts` | Modify | `createSignals` cases for ofi/hawkes/volume_anomaly; weights map trimmed to 5 |
| `packages/dashboard/src/services/BacktestService.test.ts` | Modify | Coverage test for new generators |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify | Prune param spaces; trim mapOptunaParamsToRequest and WEIGHT_PARAM_MAP |
| `packages/data-collector/src/database/init/027_backtest_signal_coverage_cleanup.sql` | Create | Delete the 6 stale per-type rows |
| `packages/dashboard/src/server.ts` | Modify | Post-init mirror of the SQL cleanup |
| `C:\Users\Usuario\.claude\projects\C--Users-Usuario-GitHub-polymarket-trader\memory\project_backtest_signal_coverage.md` | Create | Canonical inventory ledger |
| `C:\Users\Usuario\.claude\projects\C--Users-Usuario-GitHub-polymarket-trader\memory\project_optimizer_followups.md` | Modify | Update #143 status to "partial — 5 of 11 wired"; cross-link new ledger |
| `C:\Users\Usuario\.claude\projects\C--Users-Usuario-GitHub-polymarket-trader\memory\MEMORY.md` | Modify | Index entry for new ledger |

No frontend, no docker-compose, no env vars.

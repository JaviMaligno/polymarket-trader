# Design: Cold Market Filter + Optimizer Reconnection + Parameter Space Expansion

**Date:** 2026-04-08
**Status:** Approved
**Context:** Post-reset #12, capital $8,656 (-13.4%), win rate 11%

## Problem Statement

Three independent issues compound into systematic losses:

1. **Cold markets with stale prices** — Markets with `tracking_status = 'cold'` retain outdated `current_price_yes` (e.g., 0.50 when actual is 0.003). They bypass price filters and generate catastrophic signals. Responsible for $620 of $718 total losses (86%) since last reset.

2. **Optimizer disconnected** — `OPTIMIZER_URL` is not set on the GCP VM. The `OptimizationScheduler` falls back to grid search over 2 trivial parameters (`minEdge`, `minConfidence`). Signal weights and `directionMultiplier` have never been optimized — they are arbitrary values.

3. **Critical parameters missing from Optuna space** — Even when connected, `OPTUNA_PARAM_SPACE` lacks `directionMultiplier`, OFI/MLOFI/Hawkes weights, and constrains `momentumWeight` to positive-only [0.2, 1.5]. The system cannot learn the optimal signal configuration.

### Root Cause of Win Rate

The `directionMultiplier = -1` was validated on extreme-price markets where mean_reversion is systematically wrong. With the current market selection (balanced 30-70% markets, sports events), mean_reversion signals are closer to random. The flip doesn't reliably convert wrong signals to right ones — it converts noisy signals to differently-noisy signals. The optimizer needs to discover the right multiplier for the current market mix, not have it hardcoded.

## Fix 1: Cold Market Filter

### Change

The `ActiveMarket` interface (SignalEngine.ts:76) lacks `trackingStatus`. Three changes needed:

1. **Add field to `ActiveMarket`**: `trackingStatus?: string` in the interface
2. **Populate in `PolymarketService.updateSignalEngineMarkets()`** (line 678): map `trackingStatus: m.trackingStatus` from `PolymarketMarket`
3. **Filter in `SignalEngine.setActiveMarkets()`** (line 290 filter block): add cold market filter alongside existing `isActive`, `isResolved`, and extreme price filters:

```typescript
// Filter: Skip cold markets (stale price data)
if (m.trackingStatus === 'cold') {
  coldCount++;
  return false;
}
```

### Location

- `packages/dashboard/src/services/SignalEngine.ts` — interface + filter
- `packages/dashboard/src/services/PolymarketService.ts` — mapping (line 678)

### Scope

- Blocks NEW signal generation for cold markets only
- Does NOT block position closing — `PositionClosingService` and `StopLossService` operate on existing positions independently
- Does NOT affect `MarketRotator` or `MarketScorer` — they manage tracking lifecycle separately

### Expected Impact

Eliminates ~$620 in losses from stale-price markets (Iran forces, Iran ceasefire Apr 7, Iran ceasefire May 31).

## Fix 2: Reconnect Optimizer via Neon

### Architecture

```
Dashboard (GCP VM) --HTTPS--> Optimizer (Render): suggest/report
Optimizer (Render) --postgres--> Neon (us-east-1): Optuna trial storage
Dashboard (GCP VM) --local--> TimescaleDB: backtest execution
```

The optimizer does NOT access trade data. It only:
1. Receives parameter suggestions requests (HTTP)
2. Returns suggested parameter combinations (HTTP)
3. Receives trial scores (HTTP)
4. Stores trial history in its own DB (Neon)

All backtesting happens locally on the dashboard using its own TimescaleDB.

### Changes

**Neon setup (manual):**
- Create database in existing Neon account, region `aws-us-east-1`
- Obtain connection string

**Render optimizer-server:**
- Set env var `DATABASE_URL` to Neon connection string
- The optimizer already reads this via `get_storage_url()` in `optuna_optimizer.py`

**GCP VM docker-compose.gcp.yml:**
- Add `OPTIMIZER_URL=https://polymarket-optimizer-server.onrender.com` to dashboard-api environment
- This triggers `OptunaClient` initialization in `OptimizationScheduler` (line 159-165)

**GCP firewall:**
- Delete rule `allow-postgres-render` (currently exposes port 5432 to `0.0.0.0/0`)
- The VM's TimescaleDB no longer needs external access

### Cold Start Handling

- Render free tier spins down after inactivity. First call after sleep takes ~30s.
- `OptunaClient` already uses 60s timeout for cold starts (line 152), 15s after warmup. No changes needed.
- Neon cold start is ~1-2s, not a concern after optimizer wakes.

### Result

`OptimizationScheduler.runOptimization()` takes the `if (this.optunaClient)` path, executing `runOptunaOptimization()` instead of `runGridOptimization()`.

## Fix 3: Expand OPTUNA_PARAM_SPACE

### Current State (12 params, line 38-55)

```
combiner: minCombinedConfidence, minCombinedStrength, onlyDirection,
          momentumWeight [0.2, 1.5], meanReversionWeight [0.2, 1.5]
risk:     maxPositionSizePct, maxPositions, stopLossPct, takeProfitPct
signal:   momentum.rsiPeriod, meanReversion.bollingerPeriod, meanReversion.zScoreThreshold
```

Missing: `directionMultiplier`, OFI/MLOFI/Hawkes weights. `momentumWeight` can't go negative.

### Target State (~16 params)

Add from `REFINEMENT_PARAM_SPACE` (which already defines correct ranges):

| Parameter | Range | Why |
|---|---|---|
| `combiner.directionMultiplier` | [-1.5, 1.5] | Most important — lets optimizer discover optimal flip |
| `combiner.ofiWeight` | [0.0, 2.0] | Active generator, not optimizable currently |
| `combiner.mlofiWeight` | [0.0, 2.0] | Active generator, not optimizable currently |
| `combiner.hawkesWeight` | [0.0, 2.0] | Active generator, not optimizable currently |

Fix existing:

| Parameter | Current | Fixed |
|---|---|---|
| `combiner.momentumWeight` | [0.2, 1.5] | [-1.5, 1.5] |

### Apply Optimized directionMultiplier

**Already wired up.** `OptimizationScheduler.updateStrategy()` (line 695-705) reads `combiner.directionMultiplier` from optimized params and writes to `signal_weights` table. All signal weights (OFI, MLOFI, Hawkes, etc.) are also mapped at line 708-737. No code changes needed for the application path.

### OptunaClient Cold Start

**Already handled.** `OptunaClient` (line 152) uses 60s timeout for first request, 15s after warmup. No changes needed.

### Optuna Capacity

16 parameters with TPE sampler is well within Optuna's capability. No architectural concern.

## Fix 4: Merge PR #84 (Large-Loss Cooldown)

### Rationale

Defense in depth. The cold market filter (Fix 1) prevents the root cause, but PR #84 catches any future scenario where a market generates repeated large losses regardless of the reason.

### Change (already implemented in PR #84)

In `AutoSignalExecutor.registerStopLossCooldown()`:
- Listen for `netPnl` in the `position:closed` event (already emitted by `PositionClosingService`)
- Trigger 4h market cooldown when `netPnl <= -$25`, regardless of exit reason
- Constant: `LARGE_LOSS_COOLDOWN_THRESHOLD_USD = 25`

### CI Status

PR #84: all 527 tests pass, CI green.

## Deployment Order

1. **Merge PR #84** — immediate safety net
2. **Deploy cold market filter** — stops the bleeding
3. **Create Neon DB + configure Render + set OPTIMIZER_URL** — infra setup
4. **Deploy param space expansion** — optimizer starts learning
5. **Delete firewall rule `allow-postgres-render`** — close security hole
6. **Verify:** optimizer runs successfully in next 6h cycle

## Out of Scope

- **Auto-review prompt improvement** (tradeabilityScore revert attempts) — separate task
- **Account reset** — evaluate after fixes are deployed and optimizer has run a few cycles
- **Per-market-type direction multipliers** — the infrastructure exists in `WeightedAverageCombiner` but optimizing per-type is a future enhancement; global multiplier optimization is the priority
- **Disk cleanup on VM** — operational task, not code change

## Success Criteria

1. Zero trades on cold markets after Fix 1 deploy
2. Optimizer runs with 16 params (visible in `optimization_runs.parameter_space`)
3. `directionMultiplier` value changes from hardcoded -1 to optimizer-determined value within 24h
4. Firewall rule `allow-postgres-render` deleted
5. Win rate trend improves over next 48h (directional, not a specific target)

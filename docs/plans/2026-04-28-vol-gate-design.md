# Vol-Gate in AutoSignalExecutor — Design

**Date**: 2026-04-28
**Status**: Design (pending implementation plan)
**Related**: Issue #136, `project_post_drought_loss_pattern.md`, `project_optimizer_extreme_weights.md`

## Problem

Live trading post-PR #134 (shadow pool deploy 2026-04-26) has produced 16 event_financial trades with 12.5% win rate, −$49.41 PnL over 36h. Same-market churn observed in 6 of 12 distinct markets (Kerala 1004371 had 5 alternating SHORT/LONG positions in 29h).

Forensic SQL on the lossy markets shows realized_volatility_24h **0.0009–0.0041**, which is **2–20× below** `REALIZED_VOL_REF=0.02` (the env constant the scorer uses to map vol to [0,1]). Of the 30 most recent trades, 28 occurred in markets with rvol < 0.005 — only 2 produced positive PnL ($3.41 and $0.21), neither sufficient to cover the per-trade fees+slippage cost.

Diagnosis (`project_post_drought_loss_pattern.md` updated 2026-04-28): the signal stack is dominated by mean_reversion (weight 1.6034) with active anti-momentum (weight −0.4998), per the last Optuna run. On low-volatility oscillating markets, mean_reversion fires high strength on each micro-flip; the system enters/exits chasing the noise; PnL is consistently negative because the price oscillation magnitude is below the cost of the round-trip.

Why the optimizer landed on these weights, and whether the fitness function captures the cost structure correctly, is documented in `project_optimizer_extreme_weights.md` and deferred to a separate investigation.

## Goal

Validate the empirical hypothesis that low-realized-volatility markets are unprofitable for the current signal stack, by gating new opens at the executor on a minimum realized vol threshold. The gate generates a clean post-shadow-pool dataset of trades that passed the filter, with the raw rvol-at-open recorded — enabling a later (Option C) data-driven derivation of the optimal threshold, and a later (Option B) move of the principle upstream into the Bayesian confidence cap.

This is **not a final fix**. It's the validation experiment. Success/failure of this gate informs the next structural step.

## Architecture

A single guard in `AutoSignalExecutor.processSignal()`, executed only on the *open* path (closes are never gated). The guard reads `markets.realized_volatility_24h` for the signal's market via a single SQL query, compares against `EXECUTOR_MIN_REALIZED_VOL` (default `0.005`, env-overridable), and rejects if rvol is NULL, 0, or below threshold.

No schema changes. No new tables. No changes to `SignalEngine`, `MarketRotator`, `MarketScorer`, `ClobCollector`, `GammaCollector`, `PositionClosingService`, or `PaperTradingService`.

The threshold default `0.005` = `REALIZED_VOL_REF / 4`. Empirically chosen to be strict during the validation window: blocks every market currently producing losing trades (all rvol ≤ 0.0041), while permitting the high-vol cola (event_financial p75 = 0.1343, far above the gate). If the gate produces 0 trades for 48h, the conclusion is "current pool universe is toxic for the signal stack" — itself a useful empirical signal.

## Components

### `packages/dashboard/src/services/AutoSignalExecutor.ts`

Three discrete edits, all in this single file:

**1. New module-level constant** (alongside the existing `ALLOWED_MARKET_TYPES` block at line ~199):

```ts
const EXECUTOR_MIN_REALIZED_VOL: number = (() => {
  const parsed = parseFloat(process.env.EXECUTOR_MIN_REALIZED_VOL || '0.005');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.005;
})();
```

The IIFE-with-validation pattern guards against malformed env values. `parseFloat('xyz') = NaN` would otherwise produce a gate that always passes (any `< NaN` is false), silently disabling the experiment.

**2. New gate block in `processSignal()`**, placed immediately after the market-type gate (current lines 462–481), before any risk checks or cooldowns:

```ts
// Vol-gate: block opens on low-realized-volatility markets.
// Closes are never gated — checked via existing hasOpenPosition logic.
try {
  const openPositions = await paperPositionsRepo.getAll();
  const hasOpenPosition = openPositions.some(p => p.market_id === signal.marketId);
  if (!hasOpenPosition) {
    const rvolRow = await query<{ rvol: number | null }>(
      `SELECT realized_volatility_24h AS rvol FROM markets WHERE id = $1`,
      [signal.marketId]
    );
    const rvolRaw = rvolRow.rows[0]?.rvol;
    const rvol = rvolRaw === null || rvolRaw === undefined ? null : Number(rvolRaw);
    if (rvol === null || !Number.isFinite(rvol) || rvol < EXECUTOR_MIN_REALIZED_VOL) {
      console.log(
        `[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : vol_below_threshold (rvol=${rvol}, min=${EXECUTOR_MIN_REALIZED_VOL})`
      );
      return {
        executed: false,
        reason: `vol_below_threshold: rvol=${rvol} < ${EXECUTOR_MIN_REALIZED_VOL}`,
      };
    }
  }
} catch (err) {
  // Fail-closed: any DB error treats rvol as unknown → block.
  console.log(
    `[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : vol_below_threshold (query failed: ${(err as Error).message})`
  );
  return { executed: false, reason: 'vol_below_threshold: query failed' };
}
```

The `getAll()` call duplicates work the existing market-type gate already does; in the implementation, the two should share a single call and pass `hasOpenPosition` between them. The plan-level concern is the *behavior*, not the micro-optimization — the implementer can deduplicate.

**3. Add `realizedVolatilityRaw` key to `score_dimensions_at_entry` JSONB** (around line ~877–893 where the dimensions object is built before insert):

```ts
realizedVolatility,                                    // existing: mapped [0,1]
realizedVolatilityRaw: m.realized_volatility_24h !== null
  ? Number(m.realized_volatility_24h)
  : null,                                              // new: raw stddev
```

Same precedent as Sub-project B.2's `signalConsensus` extra key — the JSONB column accepts arbitrary keys outside the typed `ScoreDimensions`.

### `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

Six new test cases inside the existing `describe('AutoSignalExecutor', ...)` block:

1. `rvol < threshold + no open position → reject 'vol_below_threshold'`
2. `rvol ≥ threshold + no open position → does not reject by vol-gate (passes to next check)`
3. `rvol IS NULL → reject 'vol_below_threshold'`
4. `rvol = 0 → reject 'vol_below_threshold'` (subcase of <)
5. `rvol < threshold + has open position on same market → bypasses vol-gate (close path)`
6. `successful open: paper_positions row inserted has realizedVolatilityRaw in score_dimensions_at_entry JSONB`

Existing 34+ tests continue to pass — vol-gate is additive.

### `docker-compose.gcp.yml`

Add to the `dashboard-api` service `environment:` block (alongside existing `EXECUTOR_*` vars at line ~150-170):

```yaml
      EXECUTOR_MIN_REALIZED_VOL: "0.005"
```

Permits live tuning of the threshold via env without redeploy of the image. Default-in-code matches default-in-compose for safety: if env is unset, code default fires.

### Files NOT modified

- `packages/dashboard/src/services/SignalEngine.ts`
- `packages/data-collector/src/services/MarketRotator.ts`
- `packages/data-collector/src/services/MarketScorer.ts`
- `packages/data-collector/src/services/Scheduler.ts`
- `packages/data-collector/src/collectors/ClobCollector.ts`
- `packages/data-collector/src/collectors/GammaCollector.ts`
- Database schema (`packages/data-collector/src/database/init/*.sql`)
- `scripts/daily-review.sh` and `scripts/daily-review-prompt.md` (auto-review will see the new `vol_below_threshold` reject reason naturally without prompt changes; the existing pattern parses these)

## Data Flow — Trade Lifecycle Cases

**Case 1 — Open on low-vol market** (the typical case at deploy time):
1. SignalEngine emits combined signal for Kerala 1004371 (rvol = 0.0041).
2. AutoSignalExecutor receives signal, passes market-type gate (`event_financial` ∈ allowed).
3. Vol-gate query returns rvol = 0.0041 < 0.005 → reject `vol_below_threshold`, log line.
4. No paper_positions / paper_trades rows created. Capital unchanged.

**Case 2 — Open on high-vol market** (the case the gate is designed to allow):
1. Pool acquires a market with rvol ≥ 0.005 (e.g. event_financial in p75 territory: rvol = 0.13).
2. Vol-gate passes; signal proceeds to near-resolved gate, OTM gate, risk checks, simulator, paper_positions insert.
3. The persisted row carries `score_dimensions_at_entry.realizedVolatilityRaw = 0.13`.
4. After this position closes (win or loss, real fees/slippage applied), the data point feeds Option C analysis.

**Case 3 — Close on existing position regardless of rvol**:
1. SignalEngine emits exit signal for an open position.
2. `hasOpenPosition === true` → vol-gate skipped.
3. Close proceeds via PositionClosingService unchanged.
4. **Invariant**: no open position is ever stranded by the vol-gate.

**Case 4 — Open signal on a market with NULL rvol** (just promoted, compute job hasn't run):
1. Vol-gate sees `rvol = NULL` → reject.
2. Next signal on the same market arrives ≥15 min later (compute job interval). By then rvol is populated.
3. Cost: up to 15 min latency before a freshly-promoted market becomes tradeable.

**Case 5 — DB query exception during gate**:
1. Postgres timeout, connection error, or unexpected exception during the SELECT.
2. Try/catch fails closed: rejects with `vol_below_threshold: query failed`.
3. Same fail-closed semantic as the existing market-type gate's `position check failed` path.

## Migration / Deploy

No data migration needed — `markets.realized_volatility_24h` already populated by the existing 15-min compute job (Sub-project B.1).

At deploy time:
- 64 active+warming markets (event_short=22, event_long=31 shadow lane, event_financial=14, crypto_intraday=1).
- Most have rvol below 0.005 — the next 24-48h will likely show very few opens.
- The 1 currently-open position (616902 Fed cuts) is unaffected: vol-gate doesn't apply to closes, and its eventual exit goes through PositionClosingService normally.

Rollback: trivial.
- Set `EXECUTOR_MIN_REALIZED_VOL=0` in docker-compose, redeploy. Threshold of 0 cannot be exceeded by any real value, so all opens pass.
- Or revert the merge commit. No schema changes to undo.

## Out of Scope

Explicit non-goals:

- **Optimal threshold**. 0.005 is a deliberate-strict starting point for the validation experiment, not a final value. Option C derives the empirical optimum after ≥48h of post-A trade data.
- **Bayesian-cap-based vol awareness** (Option B). Belongs upstream in the SignalEngine's Beta-Binomial cap so the *signal itself* reflects market predictability, not just gate downstream. Implemented after A validates the principle.
- **Fixing the optimizer's extreme weights** (`project_optimizer_extreme_weights.md`). Independent investigation, deferred until A produces ≥48h of clean data.
- **Shadow execution-realism** (`project_shadow_execution_realism.md`). Independent design issue (shadow_trades assumes 0 fees/slippage). Deferred.
- **Daily auto-review prompt updates**. The auto-review parses `[AutoExecutor] REJECTED ... : <reason>` patterns generically. The new `vol_below_threshold` reason will surface in `trades_by_type` / log analysis without prompt changes.
- **Per-market-type vol thresholds**. A single global threshold for the validation. Type-specific tuning is C territory.

## Error Handling

- **Env unset**: defaults to 0.005 in code. No surprise.
- **Env malformed** (`EXECUTOR_MIN_REALIZED_VOL=xyz` or empty string after trim): IIFE detects NaN and falls back to 0.005. Logged at startup if helpful, but not required.
- **Env negative** (`-0.1`): IIFE detects `< 0` and falls back to 0.005. Negative threshold is meaningless given that rvol = stddev ≥ 0.
- **DB query exception**: fail-closed (reject). Same pattern as existing gates.
- **Signal with missing `marketId`**: existing market-not-found path catches first (line 414); vol-gate never reached.
- **Race condition on rvol value**: rvol is updated atomically by the 15-min compute job. Reading during a write may give stale (≤15 min) value but never corrupt — acceptable for this guard.

## Testing

**Unit (vitest, in `AutoSignalExecutor.test.ts`)**:
- 6 new tests as listed in the Components section.
- All preexisting tests pass without modification (vol-gate is additive — only changes behavior when the gate condition fires).

**Type check**: `pnpm exec tsc --noEmit` in dashboard package — no errors.

**Integration smoke** (post-deploy, on VM):
1. Verify `EXECUTOR_MIN_REALIZED_VOL=0.005` exposed inside dashboard-api container.
2. Verify next signal cycle produces `[AutoExecutor] REJECTED ... vol_below_threshold (rvol=X, min=0.005)` log lines.
3. SQL: `SELECT score_dimensions_at_entry->>'realizedVolatilityRaw' FROM paper_positions WHERE opened_at > '<deploy_ts>'` — for any positions that DO open post-deploy, the raw rvol must be persisted (non-null number, possibly NULL only if the underlying market column was NULL but the gate let it pass — which shouldn't happen).

## Success Criteria — Validation Experiment

Decision rule, applied 48h after deploy:

| Outcome | Conclusion | Next step |
|---|---|---|
| ≥3 opens pass the gate AND win_rate among them > 25% | Hypothesis confirmed: rvol is the right discriminator. | Proceed to Option C: derive empirical threshold from post-A trade data. |
| 0 opens pass the gate | Hypothesis partially confirmed: gate works but pool universe is toxic for current signal stack. | Investigate upstream: is the rotator surfacing the wrong markets? Is the optimizer expecting trades in regimes that don't exist? |
| ≥3 opens pass AND win_rate ≤ 15% | Hypothesis incorrect: rvol is not the discriminator. | Revert (`EXECUTOR_MIN_REALIZED_VOL=0`). Investigate other signal-quality features. Document learning. |

The threshold for "≥3 opens" prevents drawing conclusions from 1-2 noisy samples. The win-rate cuts (25% / 15%) are well below historical event_financial 32.9% baseline but well above current 12.5% — a discriminator that's clearly above current performance is sufficient evidence; we don't need to recover full historical baseline in 48h.

## Open Questions

None at design time. All architectural decisions confirmed during brainstorming session 2026-04-28.

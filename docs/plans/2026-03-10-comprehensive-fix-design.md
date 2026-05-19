# Comprehensive Fix Design — 2026-03-10

## Context

Daily trade review ([Issue #4](https://github.com/JaviMaligno/polymarket-trader/issues/4)) surfaced multiple critical issues. System is headed for real-money trading, so fixes must be robust.

### Issues Identified

1. **Unexplained capital loss (-$2,674.78)** — Historical bug where `paperPositionsRepo.close()` was DELETE. Positions deleted without crediting capital back.
2. **$0 PnL on most closed trades** — Positions churning on event markets with no price movement. Also, StopLossService and PositionCleanupService don't deduct fees from PnL.
3. **Signal generation stopped (0 signals/hour)** — Bayesian confidence cap crushes confidence to ~0% on snapshot data. Thresholds (0.60/0.45) too high.
4. **Optimization decorative** — Optuna server uses in-memory dict, Render restarts kill state → 404. Even when optimization completes, weights never written to `signal_weights` table.
5. **TimescaleDB at 218% CPU** — Causes query timeouts in RiskManager, dashboard marked "unhealthy".
6. **6.38% win rate** — Misleading: 38 of 47 trades recorded as $0 PnL (not classified as W or L).

---

## Design

### 1. Consolidated Position Closing Service

**Problem:** Three services close positions with inconsistent PnL/fee logic:
- `AutoSignalExecutor.closePosition()` — correct (deducts fees)
- `StopLossService.closePosition()` — bug (ignores fees)
- `PositionCleanupService.closePosition()` — bug (sets fee=0)

**Design:** Single `PositionClosingService` with one `close()` method.

```
PositionClosingService.close(position, exitPrice, reason)
  ├─ Compute exit value: exitPrice * shares
  ├─ Compute fee: exitValue * FEE_RATE
  ├─ Compute PnL: exitValue - entryValue - fee
  ├─ BEGIN transaction
  │   ├─ UPDATE paper_positions (closed_at, realized_pnl, size=0)
  │   ├─ UPDATE paper_account (capital += exitValue - fee, pnl += netPnl, fees += fee)
  │   └─ INSERT paper_trades (record with reason: 'signal'|'stop_loss'|'take_profit'|'time_exit'|'cleanup')
  └─ COMMIT
```

**Properties:**
- Single transaction — no partial state if DB fails mid-close (critical for real money)
- Reason tracking via `reason` parameter
- Price validation — rejects close if exit price is null/stale beyond configurable threshold
- Idempotent — if position already closed (size=0), returns early

AutoSignalExecutor, StopLossService, and PositionCleanupService all delegate to this service.

### 2. Optuna PostgreSQL Migration

**Problem:** Optuna server on Render stores sessions in Python dict. Restart = state loss = 404.

**Design:** Replace in-memory dict with Optuna's native PostgreSQL backend (existing TimescaleDB).

**Changes to `services/optimizer-server/app/main.py`:**
- Remove `optimizers: Dict[str, OptunaOptimizer] = {}`
- Each endpoint uses `DATABASE_URL` from environment
- `POST /optimizer/create` → `optuna.create_study(storage=DATABASE_URL, study_name=name)`
- `POST /optimizer/suggest` → `optuna.load_study(storage=DATABASE_URL, study_name=id)` then `study.ask()`
- `POST /optimizer/report` → `study.tell(trial, score)`
- `GET /optimizer/{id}/best` → `study.best_params`
- `DELETE /optimizer/{id}` → `optuna.delete_study(storage=DATABASE_URL, study_name=id)`

**What Optuna auto-creates in PostgreSQL:**
- `optuna_studies`, `optuna_trials`, `optuna_trial_params`, `optuna_trial_values`
- Lightweight: ~100 rows per 15-iteration run

**API contract unchanged** — dashboard's `OptunaClient` needs zero changes. Same endpoints, same shapes. Only server-side storage changes.

**Cleanup:** Dashboard already calls `DELETE /optimizer/{id}` after each run, which now calls `optuna.delete_study()`.

### 3. Wire Optimization Weights to Signal Engine

**Problem:** OptimizationScheduler computes optimal signal weights but only extracts `minEdge`/`minConfidence`. Weight parameters are computed, scored, and discarded. `signal_weights` table never updated.

**Changes to `OptimizationScheduler.updateStrategy()`:**
```
After saving to optimization_runs:
  ├─ Extract weight params from best_params:
  │   combiner.momentumWeight → momentum
  │   combiner.meanReversionWeight → mean_reversion
  │   (map all 5 generators)
  ├─ For each weight:
  │   signalWeightsRepo.update(signalType, { weight: value })
  └─ Log: "Applied optimized weights: {momentum: 0.35, ...}"
```

**Changes to `server.ts` startup:**
```
After loading best_params from optimization_runs:
  ├─ Extract thresholds (already done)
  └─ Extract signal weights and pass to SignalEngine constructor
```

**No changes to SignalEngine** — already syncs from `signal_weights` table every 5 minutes.

**Safety:** Reject weights outside [0.05, 0.95]. Log warning if weight changes >50%.

### 4. Bayesian Confidence Cap + Threshold Tuning

**Problem:** Bayesian cap counts "informative bars" (price changed). Snapshot data = same price repeated = 0 informative bars = confidence crushed to ~0%. Thresholds 0.60/0.45 filter everything out.

**Changes:**

**A. Adjust informative bar definition:**
A bar is informative if:
- Source is `'trade'` (real market activity), OR
- Source is `'snapshot'` AND price differs from market's initial listing price by >$0.01

This prevents fresh inactive markets from generating overconfident signals while allowing established stable markets to pass.

**B. Lower default thresholds to documented values:**
- `minCombinedConfidence`: 0.60 → 0.43
- `minCombinedStrength`: 0.45 → 0.27

(CLAUDE.md documents these as the intended config. They were raised at some point.)

**C. Add floor to Bayesian cap:**
Minimum confidence cap of 0.15 — even with zero informative bars, a very strong signal can still pass. Prevents total silence.

### 5. TimescaleDB CPU Investigation

**Problem:** 218% CPU on 0.25 vCPU. Causes query timeouts, dashboard unhealthy. Adding Optuna tables could worsen.

**Design:** Diagnostic script run on VM, then apply findings.

**Diagnostics:**
1. `pg_stat_activity` → active queries, long-running ones
2. `pg_stat_user_tables` → seq scans vs index scans on price_history
3. Continuous aggregate jobs → refresh frequency
4. Table sizes → price_history row count and bloat
5. Missing indexes → full table scans
6. Connection count vs `max_connections=50`

**Likely culprits:**
1. Continuous aggregate refresh over large time ranges
2. price_history bloat (snapshots add 11,520 rows/day)
3. Missing index on token_id + time
4. Too many concurrent queries from signal generation

**Mitigations (applied based on findings):**
- Data retention policy: `add_retention_policy('price_history', INTERVAL '30 days')`
- Tune continuous aggregate refresh interval
- Add missing indexes
- Reduce `MAX_SIGNAL_MARKETS` if needed

### 6. Account Reconciliation

**Problem:** $2,674.78 unexplained capital loss from historical DELETE bug.

**Design:** One-time script (not automated).

```
1. Sum paper_trades where side='BUY': total_spent
2. Sum paper_trades where side='SELL': total_received
3. expected_capital = initial_capital - total_spent + total_received
4. Diff with paper_account.current_capital = unexplained loss
5. Find orphaned BUYs (no matching SELL, no open position) = DELETE victims
6. Report: expected vs actual, orphaned buys, recommended adjustment
```

**Adjustment (manual approval):**
```sql
UPDATE paper_account
SET current_capital = current_capital + adjustment,
    available_capital = available_capital + adjustment
WHERE id = 1;
```

Runs once, reviewed manually, then applied. Going forward, the PositionClosingService prevents this class of bug.

---

## Implementation Plan

```
Phase 1 (Diagnose — no code changes)
  ├─ TimescaleDB CPU investigation script
  └─ Account reconciliation script

Phase 2 (Core fixes)
  ├─ 2A: PositionClosingService (consolidate close logic)
  │       Must be first — StopLoss and Cleanup depend on it
  ├─ 2B: Bayesian cap + threshold tuning
  │       Independent of 2A, can parallel
  └─ 2C: Apply Phase 1 findings (retention, indexes, etc.)

Phase 3 (Optimization pipeline)
  ├─ 3A: Optuna PostgreSQL migration
  └─ 3B: Wire weights to signal_weights table
       Depends on 3A

Phase 4 (Validate)
  ├─ Account reconciliation adjustment
  ├─ Deploy all to VM
  └─ Monitor 24h: signals, PnL accuracy, optimization, DB CPU
```

Phases 1+2 overlap. Phase 3 independent of Phase 2 (can parallel with worktrees).

**Scope:** ~7 files modified, 1 new service, 2 scripts, 1 Python server update. No new infra.

---

## Files Affected

| File | Change |
|------|--------|
| `packages/dashboard/src/services/PositionClosingService.ts` | **NEW** — consolidated close logic |
| `packages/dashboard/src/services/AutoSignalExecutor.ts` | Delegate close to PositionClosingService |
| `packages/dashboard/src/services/StopLossService.ts` | Delegate close to PositionClosingService |
| `packages/dashboard/src/services/PositionCleanupService.ts` | Delegate close to PositionClosingService |
| `packages/dashboard/src/services/SignalEngine.ts` | Bayesian cap adjustments, threshold defaults |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Write weights to signal_weights table |
| `packages/dashboard/src/server.ts` | Load optimized weights on startup |
| `services/optimizer-server/app/main.py` | PostgreSQL-backed Optuna storage |
| `services/optimizer-server/requirements.txt` | Add `psycopg2-binary` |
| `scripts/diagnose-db-cpu.js` | **NEW** — TimescaleDB diagnostic script |
| `scripts/reconcile-account.js` | **NEW** — account reconciliation script |

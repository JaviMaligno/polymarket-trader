# System Health Timeline Analysis (March 10-16, 2026)

## CPU History — Every Daily Review

| Date | Issue | data-collector | timescaledb | dashboard-api | Trigger |
|------|-------|---------------|-------------|---------------|---------|
| Mar 10 | #5 | — | — | **UNHEALTHY 16h** | Dashboard down, no metrics collected |
| Mar 12 (AM) | #9 | **98.58%** | — | — | sync-markets running full 52K catalog |
| Mar 12 (PM) | #12 | 48.70% | **128.93%** | 0.04% (32min up) | Dashboard just restarted |
| Mar 12 (PM) | #14 | — | — | — | No CPU data in report |
| Mar 13 | #17 | **121%** | **482%** | — | sync-markets + autovacuum on bloated markets table |
| Mar 14 | #20 | — | **711%** | — | Peak: autovacuum + compression + sync + backtest retries |
| Mar 15 | #24 | — | **150.65%** | — | Lower after issue #8 fix (removed is_active re-activation) |
| Mar 16 | #27 | **400.95%** | **209.98%** | 0.01% | Post-deploy runInitialSync() re-triggered full sync |
| **Mar 16 (post-fix)** | — | **1.19%** | **0.04%** | 0.01% | After MAX_SYNC_PAGES + batch upserts + hourly frequency |

### Root Cause: ONE bug, recurring across ALL reviews

`syncMarketsToDb()` fetched ALL ~52,878 active markets from Gamma API (529 pages x 100/page) and upserted each individually every 5 minutes. On the e2-micro (0.25 vCPU):

- **108K individual INSERT queries** per sync cycle
- Sync **never completed** before the next cycle started
- `markets` table bloated to **512MB** (189K rows) with dead tuples
- TimescaleDB autovacuum ran constantly, consuming 200-700% CPU
- All other queries (signals, backtest, prices) starved for resources

**Why it varied in severity:**
- Mar 12: Issue #8 fix stopped re-activating 118K zombie markets, reducing churn slightly
- Mar 14: TimescaleDB compression job + autovacuum + sync = 711% peak
- Mar 15: Lower because some zombie markets had been pruned
- Mar 16: Deploy restart triggered `runInitialSync()` (fresh full sync with no timeout)

**Fix applied today:** MAX_SYNC_PAGES=10 (1000 markets vs 52K), batch upserts (100/query), hourly frequency, 2-min startup timeout.

---

## Optimizer Failure History

| Date | Issue | Error | Root Cause |
|------|-------|-------|------------|
| Mar 10 | #5 | 404: "Optimizer not found" (trials 10-15) | Render server restarted mid-run -> study session lost. `_running_trials` dict empty after restart. |
| Mar 13 | #17 | 20+ 503 errors from Optuna server | Render free tier: cold start or overloaded. Server couldn't respond in time. |
| Mar 15 | #24 | BacktestService VARCHAR vectorization | TimescaleDB can't GROUP BY VARCHAR on compressed chunks. Every trial's backtest failed silently. |
| Mar 16 | — | Working (score 0.037->0.077) | All three fixes deployed |

### Pattern: Three independent failure modes

1. **Render server restart** (Mar 10, ongoing) -> `_running_trials` in-memory dict lost between `suggest()` and `report()`. **Fixed:** recovery via `study.tell(trial_id, score)` directly.

2. **Render cold start / 503** (Mar 13) -> Free tier spins down after 15min idle, cold start can exceed timeout. **Fixed:** consecutive-failure abort (3 in a row -> stop wasting time, fall back to grid search).

3. **BacktestService query failure** (Mar 15) -> VARCHAR in GROUP BY on compressed hypertable. **Fixed:** `SET LOCAL timescaledb.enable_vectorized_aggregation = off` inside transaction.

**Correlation with system events:** Optimizer runs every 6 hours. Failures did NOT correlate with code deploys — they happened at scheduled times. The Render restart failures DID correlate with our pushes to main (Render auto-deploys on every commit, killing in-flight optimization runs).

---

## Signal Generation History

| Date | Issue | Signals/hour | Cause |
|------|-------|-------------|-------|
| Mar 10 | #5 | 0 | dashboard-api UNHEALTHY for 16 hours |
| Mar 12 (AM) | #9 | 0 | Signal gen stopped (dashboard restart lost state) |
| Mar 12 (PM) | #12 | 2 | Recovering after restart |
| Mar 13 | #17 | 0 | TimescaleDB 482% CPU -> queries timeout -> SignalEngine finds 0 markets |
| Mar 14 | #20 | 0 | TimescaleDB 711% -> same as above + markets filtered (50/50) |
| Mar 15 | #24 | 0 | DB overload + all markets near 50/50 price |
| Mar 16 | #27 | 0 | Post-restart, containers only 19min old, not yet generated |

**Pattern:** Signal stall is almost always a **consequence** of CPU/DB overload, not an independent bug. When TimescaleDB is at 200-700% CPU, the SignalEngine's market discovery query times out or returns 0 results. With today's CPU fix, signals should flow normally.

---

## Deploy -> Restart -> CPU Spike Pattern

Every `git push` triggers CI/CD -> Docker image pull -> container restart -> `runInitialSync()` -> full market sync. This was the "periodic" pattern:

```
push to main
  -> Deploy to GCP (2-3 min)
    -> dashboard-api restarts
    -> data-collector restarts
      -> runInitialSync() starts
        -> syncEvents() fetches 55K events (never finishes before timeout)
        -> syncMarkets() fetches 52K markets (never finishes)
        -> CPU spikes to 200-400%
          -> TimescaleDB autovacuum adds another 200-400%
            -> all queries slow -> signals stall -> optimizer fails
```

**Today's fix breaks this chain at step 5:** sync is now limited to 10 pages (1000 markets) with 2-min timeout per initial sync job.

---

## Summary

| Problem | Recurring Since | Root Cause | Fix | Status |
|---------|----------------|------------|-----|--------|
| CPU critical | Mar 10 | syncMarketsToDb() fetches ALL 52K markets | MAX_SYNC_PAGES=10, batch upserts, hourly | Fixed |
| Optimizer 404 | Mar 10 | Render restart loses _running_trials | Recovery via study.tell(id, score) | Fixed |
| Optimizer 503 | Mar 13 | Render cold start timeout | 3-consecutive-failure abort | Fixed |
| Optimizer backtest | Mar 15 | VARCHAR vectorization bug | SET LOCAL disable | Fixed |
| Signal stall | Mar 10 | Consequence of CPU/DB overload | CPU fix resolves this | Fixed |
| Flash positions | Mar 12 | CB fires on every BUY, no min hold | Min hold 5min, skip BUY events, pre-open check | Fixed |

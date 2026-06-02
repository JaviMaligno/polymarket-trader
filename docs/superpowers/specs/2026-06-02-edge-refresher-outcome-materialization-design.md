# EdgeCapacityRefresher — Outcome Materialization (structural timeout fix)

**Date:** 2026-06-02
**Status:** Design approved, pending implementation plan
**Origin:** daily-review #297 — `event_short`/`event_long` `generator_edge` stale 5 days; PRs #288/#289/#290/#295 all mis-diagnosed.

## Problem

The nightly `EdgeCapacityRefresher` (02:30 UTC) measures per-`(signal, market_type, direction)` cost-aware edge from `generator_predictions` × 4h-forward `price_history` drift. For `event_short` and `event_long` the per-type query exceeds the 600s cap and is skipped, leaving `generator_edge` stale and the edge sentinel partially blind for those types.

### Root cause (EXPLAIN ANALYZE on the VM, 2026-06-02)

`buildPerTypeSQL` (with `sampleSize=10000`) has three cost components. PR #295's `(market_type, direction, time)` index fixed only the cheapest:

1. **`COUNT(*)` InitPlan** — 80ms, Index-Only Scan. ✅ Fixed by #295.
2. **Sampled CTE scan — 39.9s** (measured). An Index *Scan* (not Index-Only) heap-fetching all ~171k `event_short` rows in the 7-day window, because the SELECT projects `signal_id/market_id/time/yes_price_at_signal` (not in the index) and `random()` is a post-heap Filter. `read=19036` disk blocks on the e2-micro. **This 39.9s is exactly the "40.8s" measured on 2026-06-01 and mistaken for the whole query.**
3. **`price_history` 4h-forward correlated subquery × ~10,068 sampled rows** — each sampled row triggers a `ChunkAppend` over multiple *compressed* `price_history` chunks (ColumnarScan + decompression), with no startup chunk-exclusion (the predicate `s.time + 4h` is correlated). Estimated full-query cost: 1.27M (29× the sampled scan alone). **This is the bulk of the >560s and the index does not touch it.**

The full query was **always** >600s, before and after #295. `event_short` times out where `event_financial` (508s) does not because it is the largest cohort: 171,835 preds/7d (130,143 long + 41,692 short) vs `event_financial` 126,095.

**Methodology lesson (binding for verification):** measuring one CTE/subplan in isolation and reporting it as the whole-query time produced a false "fixed, proven" two days running. Never claim a perf fix works from a partial-query timing — measure the COMPLETE query end-to-end.

### Severity

NOT urgent in capital terms: `event_short` is blocked in both directions (#275/#277), `event_long` is shadow-only. This is degraded **edge-sentinel observability**, not capital loss — which is why this gets a designed structural fix rather than a reactive nightly patch.

### Relevance to trading outcomes (honest causal chain)

This fix does **not** open trades by itself. Its value is upstream of trading: `market_type_edge_capacity` / `generator_edge` are the cost-aware edge signals that (a) feed `MarketScorer.tradeabilityScore` and market rotation, and (b) drive the daily-review edge sentinel that flags `(signal, type, direction)` cells with `t_net > 0` as candidates to unblock. With `event_short`/`event_long` stale for 5 days and `event_financial` one slow night from also timing out, the system is **blind to whether any explorable edge exists in those cohorts** — it cannot distinguish "no edge" from "not measured". Restoring (and making robust + deterministic) this measurement is the prerequisite for *discovering* better trades, not a source of edge in itself. Concretely, a faster/complete refresh also means the sampling removal raises per-cell `n`, so a genuine edge cell crosses the `t_net` significance bar sooner and with less run-to-run noise. Any actual trade-enabling decision (e.g. lifting an `event_short` direction block) remains a separate, evidence-gated step.

## Approach (chosen: A — materialized outcomes)

Move the expensive 4h-forward price lookup **out of the nightly refresh** and into a deferred, incremental job that computes each prediction's outcome **once**, when it matures. The refresher then reads a small, purpose-built table — no `generator_predictions` heap-fetch, no `price_history` correlated subquery.

Rationale vs alternatives:
- **B (minimal outcomes table + JOIN):** eliminates the price seek (#3) but keeps the 40s/type heap-fetch on `generator_predictions` (#2) and JOINs across compressed chunks. Rejected — leaves the secondary cost and less future margin.
- **C (covering index only):** fixes #2 (40s→ms) but not #3 (>560s). Rejected — does not address the dominant cost; proven ineffective in spirit by #295 today.

The materialization job pays the price seek on **hot, uncompressed data** (`compress_after = '3 days'`; matured predictions are 4-5h old), so its seeks are ~ms. The only expensive pass over compressed chunks is the one-shot backfill, run offline without the cap.

### Why the denormalization is safe

The outcomes table duplicates `signal_id`, `direction`, `y0`, `market_type` from `generator_predictions`. These are **immutable** (fixed at signal time), so there is no divergence risk — it is "cold" duplication that costs only space (~50-100 MB, compressible). `market_type` is the only field that can change (reclassification), but the **current refresher already filters on the frozen `generator_predictions.market_type`**, so storing it frozen here is exact parity, not a new bug. Attributing by *current* `market_type` instead is a deliberate, separate follow-up — explicitly out of scope here.

## Component 1 — Schema (migration `035`)

```sql
CREATE TABLE IF NOT EXISTS generator_prediction_outcomes (
    prediction_id    BIGINT NOT NULL,          -- logical FK to generator_predictions.id
    prediction_time  TIMESTAMPTZ NOT NULL,     -- = generator_predictions.time (partition key + 7d window filter)
    market_id        VARCHAR(128) NOT NULL,
    market_type      VARCHAR(32),              -- frozen, parity with current refresher
    signal_id        VARCHAR(50) NOT NULL,
    direction        VARCHAR(8)  NOT NULL,
    y0               NUMERIC(10,6) NOT NULL,    -- yes_price_at_signal
    y1               NUMERIC(10,6),             -- YES price at +horizon (NULL if no forward match)
    horizon_hours    INT NOT NULL DEFAULT 4,
    no_forward_price BOOLEAN NOT NULL DEFAULT FALSE,  -- matured but never got a forward price → stop retrying
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- PK includes prediction_time because TimescaleDB requires the partition
    -- column in every unique constraint. Mirrors generator_predictions' (time, id) PK.
    PRIMARY KEY (prediction_time, prediction_id, horizon_hours)
);

SELECT create_hypertable('generator_prediction_outcomes', 'prediction_time',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_gpo_type_dir_time
    ON generator_prediction_outcomes (market_type, direction, prediction_time DESC);

ALTER TABLE generator_prediction_outcomes SET (timescaledb.compress_after = '3 days');
SELECT add_retention_policy('generator_prediction_outcomes', INTERVAL '14 days', if_not_exists => TRUE);
```

Hypertable (not a plain table) so it inherits TimescaleDB compression + retention — meaningful on the e2-micro's 350 MB TimescaleDB budget. Size estimate: ~110k preds/day × 14d ≈ 1.5M rows (no heavy `metadata` column); compressed after 3d. Consequence for the job's idempotency guard: the unique target is `(prediction_time, prediction_id, horizon_hours)`, so the `ON CONFLICT` clause must name all three (the job knows `prediction_time = g.time`). The `NOT EXISTS` pre-check is the primary idempotency mechanism; `ON CONFLICT ... DO NOTHING` is the secondary guard.

**Init-SQL gotcha:** `init/*.sql` only runs on a fresh volume. After merge, create the table + index **manually on the live VM** (as was done for migration 034).

## Component 2 — Materialization job

New `materializePredictionOutcomes()` in `packages/data-collector/src/services/MarketPerformanceTracker.ts`, beside `resolveShadowTrades` (same idempotent deferred-outcome pattern).

1. Select matured, not-yet-materialized predictions:
   ```sql
   SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id, g.direction, g.yes_price_at_signal
   FROM generator_predictions g
   WHERE g.time >= NOW() - INTERVAL '8 days'      -- 7d window + margin
     AND g.time <  NOW() - INTERVAL '5 hours'      -- matured: horizon(4h) + 1h
     AND g.direction IN ('long','short')
     AND NOT EXISTS (SELECT 1 FROM generator_prediction_outcomes o
                     WHERE o.prediction_id = g.id AND o.horizon_hours = 4)
   ```
2. For each, seek the forward price (hot/uncompressed data → ~ms):
   ```sql
   SELECT close FROM price_history
   WHERE market_id = $market_id
     AND time >= $g_time + INTERVAL '4 hours'
     AND time <  $g_time + INTERVAL '5 hours'
   ORDER BY time ASC LIMIT 1
   ```
3. Insert outcome (`y1` if matched; else `y1=NULL`). `ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING` (must name the full hypertable PK).

**No-forward-price rule:** a prediction may mature yet never get a forward price (market stopped quoting, resolved, data gap). To avoid eternal retries:
- 5h ≤ age < 8h with no price → leave unmaterialized, retry next run (price may arrive late).
- age ≥ 8h with no price → write `y1=NULL, no_forward_price=true` (processed; never retried).

**Error handling:** per-row try/catch (log + continue), like `persistCellsToHistory`. One bad seek never aborts the batch.

**Schedule:** hourly cron in `Scheduler.ts`. Each run processes only the ~4-5k predictions that matured in the last hour — distributed cost, never a 600s burst.

## Component 3 — Refresher rewrite

`buildPerTypeSQL` in `EdgeCapacityRefresher.ts` reads **only** the outcomes table:

```sql
WITH edges AS (
  SELECT signal_id, market_type, direction,
         CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
  FROM generator_prediction_outcomes
  WHERE prediction_time >= NOW() - INTERVAL '7 days'
    AND market_type = $1
    AND direction IN ('long','short')
    AND y1 IS NOT NULL
)
SELECT signal_id, market_type, direction,
       COUNT(*)::int AS n,
       (AVG(gross_edge)*100)::float AS gross_pct,
       CASE WHEN STDDEV(gross_edge)>0
            THEN (AVG(gross_edge)*SQRT(COUNT(*))/STDDEV(gross_edge))::float END AS t_gross
FROM edges GROUP BY 1,2,3;
```

`idx_gpo_type_dir_time` serves the WHERE directly; scan is proportional to the materialized cohort, with no heap-fetch of absent columns and no `price_history` decompression.

**Sampling removed:** the materialized table is cheap to scan in full, so `sampleSize` / the `random()` filter / the `COUNT(*)` InitPlan are dropped. Benefits: higher statistical power (full cohort `n` per cell instead of ~385), and **deterministic** results (today's sampling adds ±1% run-to-run variance). `EDGE_REFRESH_SAMPLE_SIZE` becomes obsolete (plan decides clean removal vs read-but-unused transition). `perTypeTimeoutMs` is kept as a now-ample safety backstop.

**Unchanged:** `persistCellsToHistory`, `computeEdgeCapacity`, `getLatestEdgePerCell` — they still receive the same `Cell[]`. Only the raw-data source changes. `event_financial` (today 508s) gets the speedup for free (same table).

## Testing (TDD, one test per step)

- `MarketPerformanceTracker.test.ts` — `materializePredictionOutcomes()`: (a) materializes a matured prediction with a forward price; (b) marks `no_forward_price=true` when age ≥ 8h with no price; (c) idempotent (no dup on second run); (d) skips not-yet-matured (<5h) predictions.
- `EdgeCapacityRefresher.test.ts` — `buildPerTypeSQL` emits SQL with no `price_history` and no `random()`; `computeEdgeCapacity` / `persistCellsToHistory` regression (same `Cell[]` → same upserts).
- `Scheduler.test.ts` — the new hourly materialization cron is registered; the refresher no longer passes `sampleSize`.

## Deployment order

1. Merge + deploy code; create table + index manually on VM.
2. Run one-shot `scripts/backfill-prediction-outcomes.js` on VM → fills the 7d window (touches compressed chunks; offline, no cap).
3. Hourly cron keeps the table current thereafter.
4. Next 02:30 UTC refresher reads the populated table → `event_short`/`event_long` edge fresh.
5. **Carry-over verification (new ⏰):** next day, `generator_edge` < 24h stale for all 4 types AND measure the **full** refresher end-to-end time (not a sub-query — today's lesson).

## Success criteria

- All 4 types (incl. `event_short`, `event_long`) with `generator_edge` < 24h stale.
- Full refresher run < 60s total.
- Per-cell `n` ≥ today's (no loss of statistical power; sampling removal should increase it).

## Out of scope (deliberate)

- Attributing edge by *current* `market_type` instead of frozen (separate follow-up).
- Multiple horizons (schema supports it via `horizon_hours` PK component, but only 4h is built).
- Touching live trading, gates, or the FLB executor (separate track).

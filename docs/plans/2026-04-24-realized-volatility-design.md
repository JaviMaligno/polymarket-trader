# Sub-project B.1: Realized Volatility as Scorer Dimension

**Date:** 2026-04-24
**Parent:** [2026-04-24-scorer-overhaul-roadmap.md](./2026-04-24-scorer-overhaul-roadmap.md)
**Status:** Design — awaiting user approval before writing implementation plan.

## Problem statement

Sub-project A ([2026-04-24-scorer-per-type-weights-design.md](./2026-04-24-scorer-per-type-weights-design.md)) added per-type weights and the `typeExpectedValue` dimension, raising the in-sample composite-vs-PnL Pearson from -0.04 to +0.41. The current dimension set (`tradeability`, `liquidity`, `ttr`, `volatility`, `dataQuality`, `typeExpectedValue`) still lacks direct measurement of actual market dynamics over the recent past. Realized volatility — how much a market's price has moved in the last 24 hours — is a market-microstructure feature the scorer does not see today.

This sub-project adds `realizedVolatility` as a first-class scorer dimension.

## Hypothesis

Realized volatility correlates with PnL because:

- Low-vol markets have less price movement, so signals that trigger on noise find no opportunity and end up paying spread/fees to exit near-flat. Expected PnL is weakly negative.
- High-vol markets offer more movement to capture, but signal-to-noise may degrade — too many false triggers.
- There is likely a sweet spot. The optimizer will learn the relationship (direction + strength) from the realized PnL data.

Direction is not pre-assumed. The design makes realized volatility a first-class dim whose weight and effect are learned empirically, not pre-baked into the formula.

## Non-goals

- Change the MarketScorer architecture. This reuses the same dim-based composite that A established.
- Modify signal engine, combiner, or execution layer.
- Add bid-ask spread as a dim. Empirical pre-check (2026-04-24, n=1829 closed trades) showed spread has Pearson -0.025 with PnL globally and is moderately collinear with liquidity (-0.26). Marginal signal over the existing liquidity dim is judged too low to justify the added dim. Deferred to Sub-project B.4.
- Change how volatility (the Pass 2 price-history-derived dim) is computed. That dim is null for cold markets by design; realizedVolatility replaces it conceptually for Pass 1 and complements it for Pass 2.

## Architecture overview

```
┌────────────────────────────────────────────────┐
│ price_history (TimescaleDB hypertable)         │
│   token_id, time, close                        │
└──────────────┬─────────────────────────────────┘
               │ 15-min SQL aggregation
               ▼
┌────────────────────────────────────────────────┐
│ markets (additional columns)                   │
│   realized_volatility_24h FLOAT NULL           │
│   realized_volatility_bar_count SMALLINT NULL  │
└──────────────┬─────────────────────────────────┘
               │ read by scorer + executor
               ▼
┌────────────────────────┐     ┌────────────────────────┐
│ MarketScorer Pass 1/2  │     │ AutoSignalExecutor     │
│   maps raw → [0,1]     │     │   maps raw → [0,1]     │
│   via VOL_REF env var  │     │   via VOL_REF env var  │
└───────────┬────────────┘     └───────────┬────────────┘
            │                              │ at position open
            ▼                              ▼
┌─────────────────────────────────────────────────────┐
│ ScoreDimensions.realizedVolatility                  │
│   number | null (null if <5 bars)                   │
└──────────────────────────────────────────────────────┘
            │ persisted in
            ▼
┌─────────────────────────────────────────────────────┐
│ paper_positions.score_dimensions_at_entry (JSONB)   │
└──────────────────────────────────────────────────────┘
            │ consumed by
            ▼
┌─────────────────────────────────────────────────────┐
│ ScorerWeightOptimizer (per-type + global)           │
│   learns realizedVolatility weight                  │
└──────────────────────────────────────────────────────┘
```

## Design details

### 1. Estimator

**Formula**: non-parametric realized variance estimator (Andersen-Bollerslev-Diebold-Labys 2001 style) applied to first differences of close prices:

```
Δp_i = p_i − p_{i−1}                       (first difference)
realized_volatility_24h = STDDEV_POP(Δp)   over the 24-h window
```

Why first differences (not log-returns):

- Prediction market prices are bounded in [0,1]. The geometric-Brownian-motion assumption implicit in log-returns does not apply. First differences are the correct estimator for bounded martingale processes.
- Log-returns explode numerically near 0 and 1 (where prediction market prices often sit near resolution). First differences stay numerically stable across the full [0,1] range.
- The stddev of Δp converges to the integrated volatility of the underlying martingale under weak mixing assumptions. Non-parametric and distribution-free.

Alternative estimators considered and rejected:

- **Log-returns with floor clamping**: numerically stable but parametrically assumes geometric dynamics; adds complexity without proven benefit for [0,1] prices.
- **Range (max − min)**: ultra-simple but sensitive to single-bar outliers and wastes most bars.
- **Parkinson / Garman-Klass**: OHLC-based; we have close-only snapshots, so these do not apply.

### 2. Window and quality filter

**Window**: trailing 24 hours. Rationale: aligns with other 24h features (`volume_24h`), matches the signal engine's usual memory, and is long enough for statistical stability while short enough to reflect current microstructure.

**Quality filter**: if fewer than 5 first-differences (i.e., fewer than 6 close prices in the window) exist for a market, `realized_volatility_24h = NULL`. Rationale: a stddev over <5 points is statistically meaningless. Downstream treats NULL as "no information" rather than imputing a neutral value.

### 3. Schema

Three tables get schema additions, each idempotent via `ADD COLUMN IF NOT EXISTS` at dashboard startup (same pattern as A):

**`markets` — raw vol storage**
```sql
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS realized_volatility_24h FLOAT,
  ADD COLUMN IF NOT EXISTS realized_volatility_bar_count SMALLINT;
```

- `realized_volatility_24h`: raw stddev (not mapped). Stored for analysis / re-mapping.
- `realized_volatility_bar_count`: number of Δp observations that contributed. Quality signal.
- No default. NULL allowed. Markets without sufficient price data have NULL until the compute job populates them.

**`scorer_weights` — optimizer output per type**
```sql
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS realized_volatility FLOAT NOT NULL DEFAULT 0;
```

- Stores the optimized weight for the new dim per market_type (and `'__global__'`).
- Default 0 for existing rows — they keep old behavior until re-optimized (next Monday cron or manual trigger).
- `saveWeights()` INSERT/UPDATE extended to include this column. Without this, `saveWeights()` breaks on the first post-B.1 run.

**`market_score_history` — score snapshot persistence**
```sql
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_realized_volatility FLOAT;
```

- Nullable (consistent with existing per-dim columns like `score_volatility`, `score_data_quality`).
- `writeScoreHistory()` INSERT extended to include this column. Without this, the snapshot INSERT fails silently (fire-and-forget wrapper logs warn).

Matching init SQL files created for fresh-DB installs:
- `packages/data-collector/src/database/init/020_realized_volatility_markets.sql`
- `packages/data-collector/src/database/init/021_realized_volatility_scorer_weights.sql`
- `packages/data-collector/src/database/init/022_realized_volatility_score_history.sql`

### 4. Compute job

New scheduler job on the VM (`Scheduler.ts`). Schedule: `*/15 * * * *` (every 15 minutes). Name: `compute-realized-volatility`.

```sql
UPDATE markets m
SET realized_volatility_24h = s.vol,
    realized_volatility_bar_count = s.n_bars
FROM (
  SELECT token_id,
         STDDEV_POP(d) AS vol,
         COUNT(*) AS n_bars
  FROM (
    SELECT token_id,
           close - LAG(close) OVER (PARTITION BY token_id ORDER BY time) AS d
    FROM price_history
    WHERE time > NOW() - INTERVAL '24 hours'
  ) diffs
  WHERE d IS NOT NULL
  GROUP BY token_id
  HAVING COUNT(*) >= 5
) s
WHERE s.token_id = m.clob_token_id_yes;

-- Markets that had insufficient data (or were removed) get NULLed explicitly:
UPDATE markets
SET realized_volatility_24h = NULL, realized_volatility_bar_count = NULL
WHERE clob_token_id_yes NOT IN (
  SELECT token_id FROM price_history
  WHERE time > NOW() - INTERVAL '24 hours'
  GROUP BY token_id
  HAVING COUNT(*) >= 5
);
```

Handler responsibilities:

- Log duration of the UPDATE.
- Log distribution snapshot (p50, p95, p99, count of NULL) post-run so we have baseline observability for future re-calibration.
- Wrap in try/catch — if the job fails, log and return; scheduler continues.

Perf expectation: with an index on `price_history (token_id, time)`, the aggregate over ~24h × ~40 active-tracked + occasional cold = ~thousands of bars should complete in <10s. If production measures >20s, investigate index usage before accepting.

### 5. Mapping raw → [0,1] for composite

At score time (Pass 1 and Pass 2 in `MarketScorer`) and at position open (`AutoSignalExecutor`):

```typescript
const VOL_REF = Number(process.env.REALIZED_VOL_REF ?? 0.02);

function mapRealizedVolatility(
  raw: number | null,
  barCount: number | null,
): number | null {
  if (raw === null || barCount === null || barCount < 5) return null;
  return Math.min(1, Math.max(0, raw / VOL_REF));
}
```

VOL_REF = 0.02 means: a 24-hour realized volatility (stddev of Δp) of 2 percentage points maps to 1.0 on the normalized scale. Chosen empirically as "2% is a noticeably volatile prediction market". Tunable via `REALIZED_VOL_REF` env var.

Open item: recalibrate VOL_REF after one training cycle if inter-market spread of mapped values is <0.10 (same playbook as typeExpectedValue's `(shrunk + 1) / 1.5`). The raw value persists in `markets.realized_volatility_24h`, so any re-mapping can be tested analytically without recomputing from price_history.

### 6. Treating the dimension as nullable

`realizedVolatility` in `ScoreDimensions` and `ScorerWeights` is `number | null`. Follows the existing pattern of `volatility` and `dataQuality` (which are also nullable). `compositeScore` skips null contributions and renormalizes by the sum of non-null weights. No existing composite logic changes; the new dim simply participates in the existing null-handling branch.

This is a deliberate departure from `typeExpectedValue`, which uses `0.5` as a neutral fallback. For `typeExpectedValue`, a neutral fallback is well-defined (category performance exists in principle, we just haven't measured enough of it yet). For `realizedVolatility`, "no data" is not equivalent to "neutral volatility" — we genuinely do not know, and imputing any value biases the composite. Nullable is correct.

### 7. AutoSignalExecutor capture

Extend the market metadata query at position-open to fetch the two new columns:

```typescript
const mktResult = await query<{
  market_score: string | null;
  current_price_yes: string | null;
  volume_24h: string | null;
  spread: string | null;
  end_date: string | null;
  market_type: string | null;
  realized_volatility_24h: number | string | null;
  realized_volatility_bar_count: number | null;
}>(
  `SELECT market_score, current_price_yes, volume_24h, spread, end_date,
          market_type, realized_volatility_24h, realized_volatility_bar_count
   FROM markets WHERE id = $1`,
  [signal.marketId],
);
```

Compute and include:

```typescript
const realizedVol = mapRealizedVolatility(
  m.realized_volatility_24h !== null ? Number(m.realized_volatility_24h) : null,
  m.realized_volatility_bar_count,
);

scoreDimensionsAtEntry = {
  tradeability, liquidity, ttr,
  volatility: null, dataQuality: null,
  typeExpectedValue: typeEV,
  realizedVolatility: realizedVol,
};
```

Same `mapRealizedVolatility` helper is shared between executor and scorer (extracted to a module-level function in `MarketScorer.ts`, imported where needed — or duplicated locally in the dashboard package if cross-package import is avoided, following the typeExpectedValueLocal pattern).

### 8. Historical backfill

One-shot at dashboard startup, idempotent via COUNT guard. Populates `realizedVolatility` for post-reset trades that don't yet have it.

```sql
-- Guard
SELECT COUNT(*) FROM paper_positions pp
WHERE pp.closed_at IS NOT NULL
  AND pp.score_dimensions_at_entry IS NOT NULL
  AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
  AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1);

-- Backfill
UPDATE paper_positions pp
SET score_dimensions_at_entry = score_dimensions_at_entry ||
  jsonb_build_object('realizedVolatility', sub.mapped)
FROM markets m,
LATERAL (
  SELECT CASE
    WHEN COUNT(*) FILTER (WHERE d IS NOT NULL) < 5 THEN NULL::FLOAT
    ELSE LEAST(1.0, GREATEST(0.0,
      COALESCE(STDDEV_POP(d) FILTER (WHERE d IS NOT NULL), 0) / 0.02
    ))
  END AS mapped
  FROM (
    SELECT close - LAG(close) OVER (ORDER BY time) AS d
    FROM price_history ph
    WHERE ph.token_id = m.clob_token_id_yes
      AND ph.time BETWEEN pp.opened_at - INTERVAL '24 hours' AND pp.opened_at
  ) diffs
) sub
WHERE m.id = pp.market_id
  AND pp.closed_at IS NOT NULL
  AND pp.score_dimensions_at_entry IS NOT NULL
  AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
  AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1);
```

Retention caveat: `price_history` has 30-day retention. Trades whose `opened_at - 24h` falls outside the retained window (i.e., older than ~29 days) will have COUNT=0 in the inner query and receive `realizedVolatility: null`. Graceful degrade.

Cost estimate: ~336 post-reset trades × LATERAL subquery aggregating ~288 bars each = ~100k aggregate row scans. With `price_history (token_id, time)` index, expected <30s. If materially slower in production, wrap with batch limiting or move to an async script.

### 9. Optimizer updates

`ScorerWeightOptimizer.ts`:

- `randomWeights()`: add `realizedVolatility: r()` to the sampled dims. Now 5 optimizable dims (tradeability, liquidity, ttr, typeExpectedValue, realizedVolatility) plus 2 fixed (volatility, dataQuality).
- Post-search normalization: scale the sum of the 5 optimizable dims to `1 - WEIGHTS.volatility - WEIGHTS.dataQuality = 0.75`.
- `loadClosedTrades`: existing `?? null` fallback on the JSONB extraction handles null values. Extend the JSONB key filter (`? 'realizedVolatility'`) so pre-backfill trades are naturally excluded, matching the typeExpectedValue playbook.
- `computeObjective`: no change — relies on `compositeScore`, which already handles null dims.
- Training threshold: `MIN_TRADES=30` unchanged. After backfill, post-reset trades all have the key. Count per type unaffected except for trades whose pre-open history is older than `price_history` retention — those get `realizedVolatility: null` but the JSONB key is present, so they count toward MIN_TRADES and contribute as a null dim.

### 10. Default weight allocation

`WEIGHTS` in `MarketScorer.ts` gets a 6th optimizable dim. Redistribute:

```
tradeability:       0.21   (was 0.25)
liquidity:          0.17   (was 0.20)
volatility:         0.15   (unchanged, fixed)
ttr:                0.08   (was 0.10)
dataQuality:        0.10   (unchanged, fixed)
typeExpectedValue:  0.17   (was 0.20)
realizedVolatility: 0.12   NEW
SUM:                1.00
```

Rationale for 0.12: modest initial weight. The optimizer will adjust. Starting low for a new feature avoids over-committing before empirical validation; starting non-zero ensures the dim participates meaningfully from day one so the optimizer has a signal to learn.

### 11. Success metrics

**Gate at 2 weeks**: the optimizer's per-type `scorer_weights.best_value` rows show either:

- Global Pearson improvement over the post-A baseline of +0.408 (new feature adds measurable lift), OR
- Per-type Pearson improvement for at least one well-represented type (event_long, event_short, event_financial), OR
- `realizedVolatility` weight in the optimized global row is ≥0.10 (not collapsed to zero by the optimizer — indicates the feature carries signal).

If all three fail, revisit the estimator (window, mapping, filter) before declaring the feature a dead end.

**Gate at 1 month**: global Pearson holds above +0.35 (maintenance), and the pool diversity continues to reflect per-type differentiation (no single type >60% of active).

### 12. Rollback

```sql
-- Drop the dim from all scorer_weights rows' effect by zeroing its weight.
-- All future scoring ignores realizedVolatility.
UPDATE scorer_weights SET type_expected_value = type_expected_value  -- no-op anchor
RETURNING market_type;
-- Cannot zero a single column in ScorerWeights type without schema change.
-- Realistic rollback: revert the PR's code. Schema columns remain (harmless).
```

Full code revert is the practical path. The `markets.realized_volatility_24h` and `markets.realized_volatility_bar_count` columns stay — they are not in any critical read path outside the scorer, and keeping them lets a re-attempt skip the migration.

## Out of scope

- Bid-ask spread as a dim (Sub-project B.4, deferred — empirical check failed).
- Signal-generator consensus (Sub-project B.2, requires SignalEngine instrumentation).
- Signal-level confidence/strength analysis (Sub-project B.3, different layer).
- Alternative volatility estimators (log-returns, Parkinson) — only if the first-differences estimator proves inadequate after a full training cycle.
- Per-market dynamic VOL_REF — single global env constant suffices for v1.

## Open items for implementation plan

- Final VOL_REF value (0.02 proposed). Log distribution on first run to confirm.
- Exact default weight allocation (proposed above; the implementation plan can fine-tune within the 0.10–0.15 range for the new dim).
- Whether the `mapRealizedVolatility` helper lives in MarketScorer (imported cross-package) or is duplicated locally in the dashboard package (following typeExpectedValueLocal's pattern). Decide based on existing imports.
- Backfill SQL form: prefer a scalar correlated subquery in `SET` over `LATERAL` + `FROM markets m`. PostgreSQL's LATERAL access to UPDATE-target columns is version-dependent and less readable. Scalar correlated subquery is cleaner:
  ```sql
  UPDATE paper_positions pp
  SET score_dimensions_at_entry = score_dimensions_at_entry || jsonb_build_object(
    'realizedVolatility',
    (SELECT CASE WHEN COUNT(d) < 5 THEN NULL::FLOAT
                  ELSE LEAST(1.0, GREATEST(0.0, STDDEV_POP(d) / 0.02)) END
     FROM (SELECT close - LAG(close) OVER (ORDER BY time) AS d
           FROM price_history ph
           WHERE ph.token_id = (SELECT clob_token_id_yes FROM markets WHERE id = pp.market_id)
             AND ph.time BETWEEN pp.opened_at - INTERVAL '24 hours' AND pp.opened_at) diffs)
  )
  WHERE pp.closed_at IS NOT NULL ...;
  ```
- Whether the backfill SQL needs batching. Default: single statement, with fallback plan to batch if >60s.
- Compute job secondary UPDATE should filter `WHERE realized_volatility_24h IS NOT NULL` in the NULL-out clause to avoid spurious no-op writes. Cosmetic perf optimization.
- Whether to log cross-type distribution of realized volatility on the first compute-job run for baseline observability (similar to how we discussed typeExpectedValue baseline logging). Recommended.

## Relationship to Sub-project A

B.1 reuses all infrastructure built by A:

- Per-type weight storage, cache, and optimizer loop — unchanged.
- Backfill COUNT-guard pattern — reused verbatim.
- JSONB `?` operator filter in `loadClosedTrades` — extended to check `realizedVolatility`.
- Null-dim handling in `compositeScore` — extended to include the new dim.
- `scripts/trigger-scorer-optimization.ts` — same script triggers retraining with the new feature.

The only genuinely new infrastructure is the compute job and the two `markets` columns. Everything else extends existing patterns.

# Phase 4 — Edge-Aware MarketScorer (cost-aware edge_capacity dim)

**Date**: 2026-05-13
**Series**: Market Intelligence Phase 4 (extends Phases 1+2+2.5)
**Trigger**: After PR-D (#220) cost-aware seed landed, the system is "trading near zero" because only 1 of 24 measured (signal, market_type, direction) cells has positive cost-aware net edge. The MarketRotator keeps selecting the same 49 markets agnostic to whether their cohorts have any net edge. We need scoring to be conscious of cost-aware edge availability.

## Problem (user 2026-05-13)

> "la elección de mercados tendría que ser lo bastante inteligente y consciente de esto como para buscar mejor cuando no hay suficientes buenos"

Current MarketScorer 8-dim formula:
- tradeability, liquidity, ttr, volatility, dataQuality, typeExpectedValue, realizedVolatility, shadowExpectedValue

`typeExpectedValue` (Phase 2 contribution) is RAW Sharpe per market_type — not cost-aware, derived from realized live trade PnL. It correlates with realized profit only AFTER trades close. Phase 4 adds a FORWARD-LOOKING dimension grounded in generator_predictions × cost-aware t_net.

## Goal

A 9th dim **`edge_capacity`** = how much positive cost-aware edge a market_type's signal cohort holds. Markets in types with high edge_capacity get scored UP; markets in types with zero/negative edge_capacity get scored DOWN. ScorerWeightOptimizer tunes the dim's weight via the existing 300-trial random search on score↔pnl correlation.

## Non-goals (deferred)

- **Active explore-mode regime switch.** Initially we let the natural scoring bias do the work — types with high edge_capacity rise, types without sink. A formal "explore-mode" state (widening candidate pool, sampling cold types) can come in Phase 4.1 if needed.
- **Per-(signal, direction) market-specific scoring.** edge_capacity aggregates across cells within a type. A market within a "low edge" type might still be a great candidate for the one edge cell that exists — but that requires per-market t-stat which we don't have.
- **PR-C of per-direction series** (Optuna per-direction param space + backtest disaggregation). Held behind Phase 4 validation: if cost-aware edge_capacity drives meaningful improvement, then PR-C makes sense.

## edge_capacity formula

Given the cost-aware t-stat dataset (e.g. `data/cost-aware-tstat-2026-05-13.json`), for each market_type:

```
edge_capacity(market_type) = Σ max(0, t_net) over all (signal_id, direction) cells in this market_type
```

Then normalize for the scorer:

```
edge_capacity_score = clamp(edge_capacity / EDGE_CAPACITY_NORM, 0, 1)
```

Where `EDGE_CAPACITY_NORM = 10` initially — corresponds to "one cell at t_net=10" or "two cells at t_net=5" being "fully covered". Tunable.

**Edge cases:**
- No cells measured for this type → return null (treated like volatility/dataQuality — drops from compositeScore renormalization).
- All cells anti-edge → edge_capacity = 0 → score = 0 (full penalty).
- One strong cell (e.g. mean_reversion crypto_intraday SHORT t_net=+2.14) → edge_capacity = 2.14 → score = 0.214.

**Sample post-2026-05-13:**
| market_type | edge_capacity | edge_capacity_score |
|---|---|---|
| crypto_intraday | 2.14 (mean_reversion SHORT only) | 0.214 |
| event_financial | 0.0 (all cells anti-edge net) | 0.000 |
| event_short | null (gross=0 across all, unmeasurable) | null → drops |
| event_long | null (not yet measured) | null → drops |
| crypto_daily | null (no predictions in 3d window) | null → drops |

Result: crypto_intraday gets a 0.214 score in this dim, event_financial gets 0.0 (penalty), others fall back to renormalized 8 dims.

## Schema

### New table

```sql
CREATE TABLE IF NOT EXISTS market_type_edge_capacity (
  market_type      VARCHAR(32) PRIMARY KEY,
  edge_capacity    DOUBLE PRECISION NOT NULL,
  n_cells_positive INT NOT NULL,
  n_cells_measured INT NOT NULL,
  rt_cost_pct      DOUBLE PRECISION NOT NULL,
  source           TEXT NOT NULL,  -- e.g. 'measure-edge-capacity.js 2026-05-13'
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

Why a separate table (not extending category_performance):
- Different cadence (edge_capacity refreshes after t-stat measurements; category_performance after live trades close)
- Different semantics (forward-looking generator_predictions vs realized live PnL)
- Different data source (generator_predictions + price_history + rt_cost vs paper_positions)

### Extend market_score_history

```sql
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_edge_capacity FLOAT;
```

Existing rows get NULL. Optimizer query learns to handle the new column.

### Extend scorer_weights

```sql
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS edge_capacity FLOAT;
```

Default NULL = use hardcoded WEIGHTS.edge_capacity from MarketScorer.ts.

### Optional: extend paper_positions

```sql
-- For audit of scoring decisions at trade time (post-Phase 4 trades only)
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS score_edge_capacity_at_entry FLOAT;
```

Deferred to PR-B follow-up if needed (the JSONB `score_dimensions_at_entry` already captures all dims; explicit column is redundant).

## Measurement script — `scripts/measure-edge-capacity.js`

```
DATABASE_URL=postgres://... node scripts/measure-edge-capacity.js \
  [--window 7d] [--horizon 4h] [--rt-cost-json data/rt-cost.json] [--min-n 50] [--dry-run]
```

Pipeline:
1. Read RT cost map (from `scripts/measure-rt-cost.js --format=json` output, or fallback to 1% default).
2. Query `generator_predictions` for (signal_id, market_type, direction) cells with `time >= NOW() - window` and `direction IN ('long','short')` (skip SIGNAL_TYPES_DISABLED).
3. Per cell, compute t_gross from forward 4h drift in price_history; compute t_net = t_gross × (gross_pct − rt_cost_pct) / gross_pct.
4. Aggregate per market_type: `edge_capacity = Σ max(0, t_net)`.
5. UPSERT into `market_type_edge_capacity` with provenance.

Includes a `--dry-run` flag for review before persisting (mirrors PR-D seed script pattern).

## Initial seed

The cost-aware data we already have in `data/cost-aware-tstat-2026-05-13.json` is enough to compute initial edge_capacity values. PR-A includes a one-time seed step:
```bash
node scripts/seed-edge-capacity-from-tstat.js --tstat data/cost-aware-tstat-2026-05-13.json
```
Output: 1 row for `crypto_intraday` (edge_capacity=2.14), 1 row for `event_financial` (edge_capacity=0.0). Other types: no row → MarketScorer treats as null.

## MarketScorer integration

Add to `ScoreDimensions` (line 29):
```typescript
edgeCapacity: number | null;  // null when no measured cells for this type
```

Add static method:
```typescript
static edgeCapacityScore(rawEdgeCapacity: number | null): number | null {
  if (rawEdgeCapacity === null) return null;
  if (rawEdgeCapacity < 0) return 0;
  const NORM = 10;
  return Math.min(1, rawEdgeCapacity / NORM);
}
```

Add to WEIGHTS (line 7) — initial 0.05 (small, lets the 8 existing dims dominate while Optuna learns):
```typescript
edgeCapacity: 0.05
```

Add loader, mirroring loadAllCategoryMetrics:
```typescript
async loadEdgeCapacityMap(): Promise<Map<string, number | null>> {
  const rows = await pool.query('SELECT market_type, edge_capacity FROM market_type_edge_capacity');
  // map.set('crypto_intraday', 2.14) etc; types absent from table → not in map
}
```

Pass 1 + Pass 2 of `scoreAllMarkets` compute `edgeCapacity` per market_type and feed into compositeScore. Pass-through to market_score_history as `score_edge_capacity`.

## ScorerWeightOptimizer integration

Add `edgeCapacity` to:
- `randomWeights()` — uniform [0.0, 0.20] (lower than other dims because the dim is highly informative when present but null often).
- `loadClosedTrades` query — extract via `score_dimensions_at_entry ? 'edgeCapacity'`. Filter for non-null entries.
- Normalization step — include in targetSum that sums to (1 - shadowExpectedValue).
- `saveWeights` — INSERT new column.

After Phase 4 lands, Optuna can tune the dim per market_type as it does for the others. The starting weight 0.05 is a hand-set prior.

## Cron refresh — PR-D

`Scheduler.ts` in data-collector adds:
```typescript
// Refresh edge_capacity from generator_predictions nightly
cron.schedule('30 2 * * *', async () => {
  await refreshEdgeCapacity();
});
```

Function calls into `measureEdgeCapacityAndUpsert()` (extracted from `measure-edge-capacity.js`). Same hook as MarketPerformanceTracker.updateCategoryPriors().

## Validation criteria

Post-deploy (24-72h):
1. `market_type_edge_capacity` table populated for crypto_intraday + event_financial.
2. Market scores in `market_score_history` show the new dim contribution.
3. crypto_intraday markets get a measurable score uplift vs event_financial.
4. **If active rotator pool composition shifts toward crypto_intraday** (more markets of that type get warmed up) → success signal.
5. **If live SHORT trades start emerging** (mean_reversion crypto_intraday SHORT is the one boosted cell) → primary success.

## Risks

- **Initial weight 0.05 may be too low to move the rotator decisions**. Optuna will tune it but needs ≥30 closed trades per type — we currently have 0 on most types. Mitigation: start with 0.05 as hand-set anchor; once enough data accumulates Optuna refines.
- **edge_capacity is sample-size sensitive**. A cell with n=50 and t_net=+5 contributes the same as a cell with n=5000 and t_net=+5. Future refinement: weight by sqrt(n) or use a confidence-adjusted version.
- **No measurement for crypto_daily / event_long / event_short** today. Those types will have null edge_capacity → drop from renormalized score. That might actually hurt them in rotator selection vs types with measured data. Acceptable: types without measurement get "neutral" treatment (null drops), not penalty.

## Out-of-scope (separate work)

- Phase 4.1: active explore-mode (regime switch + widened candidate pool).
- Per-(signal, direction) measurement persisted (not aggregated to market_type) — would let MarketRotator pick markets where the SPECIFIC profitable cell can fire.
- t-stat measurement infrastructure that handles event_long efficiently (the 122k predictions × per-row seeks problem on e2-micro).
- shadowExpectedValue per-type override (out of scope per existing MarketScorer.ts:374 note; addresses different need).

## Sub-PRs

| PR | Branch | Scope | Risk |
|---|---|---|---|
| PR-A | feat/phase4-edge-capacity-schema | Schema (table + columns + indexes), measurement script `measure-edge-capacity.js`, seed script from existing tstat data, schema tests | Low |
| PR-B | feat/phase4-marketscorer-edge-capacity | MarketScorer integration (dim, weight default, loader, Pass 1+2). New tests in MarketScorer.test.ts. Persists to market_score_history. | Medium |
| PR-C | feat/phase4-optimizer-edge-capacity | ScorerWeightOptimizer extension. Adds edge_capacity to randomWeights, normalization, query filter, saveWeights. Tests updated. | Medium |
| PR-D | feat/phase4-edge-capacity-cron | Scheduler.ts adds nightly refresh. Hook same as updateCategoryPriors. Tests for the cron function. | Low |

Total ~4 PRs, similar to per-direction series. Each PR is independently testable and reversible.

## Acceptance

Plan signed off by project owner. PRs land sequentially with deploy + 24h validation between each. After PR-D, observe rotation behavior for 1 week before considering Phase 4.1.

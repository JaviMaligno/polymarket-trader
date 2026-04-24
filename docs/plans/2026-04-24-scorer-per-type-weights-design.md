# Sub-project A: Per-type Scorer Weights + `typeExpectedValue` Dimension

**Date:** 2026-04-24
**Parent:** [2026-04-24-scorer-overhaul-roadmap.md](./2026-04-24-scorer-overhaul-roadmap.md)
**Status:** Design — awaiting user approval before writing implementation plan.

## Problem statement

The composite `MarketScorer` score currently has a Pearson correlation of **-0.04** with realized PnL, despite the optimizer running weekly over 1826 closed trades. The roadmap doc traces this to two causes:

1. The strongest predictive signal (type-level PnL) is encoded in `category_performance.prior`, applied as a multiplier clustered in 1.00–1.15 — negligible practical weight.
2. Individual dimension effects have **opposite signs across market types** (e.g. `tradeability` correlates +0.15 with PnL in event_financial, −0.18 in event_short). A single global weight vector cannot capture both.

This design adds a new dimension that carries the type-level signal directly, and splits `scorer_weights` per market type so each type's weight vector can align with that type's dimension signs.

## Goals

- Raise composite Pearson vs PnL from -0.04 to >0 within 2 weeks of deploy; >+0.15 within a month.
- Let crypto markets and event_financial markets enter the warming pool organically (no quota), driven by their `typeExpectedValue`.
- Preserve backward compatibility so rollback is a single `DELETE FROM scorer_weights WHERE market_type IS NOT NULL`.

## Non-goals

- Changing the scorer formula shape (tradeability curve, liquidity log-volume, TTR decay) — those remain as-is. Rejected rationale captured in roadmap.
- Adding new feature sources (realized vol, spread, signal aggregates) — queued in Sub-project B.
- Any change to `MarketRotator`, signal engine, or execution path.

## Architecture overview

```
┌─────────────────────────┐
│ category_performance    │   (populated daily by compute-market-priors)
│ per market_type:        │
│   sharpe_ratio, n_trades│
└──────────┬──────────────┘
           │ loaded once per Pass 1
           ▼
┌─────────────────────────┐
│ typeExpectedValue(t,n)  │   shrunk-Sharpe → [0,1]
└──────────┬──────────────┘
           │ new dimension in ScoreDimensions
           ▼
┌─────────────────────────┐         ┌─────────────────────────────┐
│ MarketScorer            │◄────────│ scorer_weights              │
│  - loadWeights(type)    │         │   (type, tradeability,      │
│  - scoreAllMarkets()    │         │    liquidity, volatility,   │
│  - compositeScore()     │         │    ttr, data_quality,       │
└──────────┬──────────────┘         │    type_expected_value)     │
           │                        │   UNIQUE(market_type)       │
           │ writes market_score    │   market_type NULL = global │
           ▼                        └─────────────────────────────┘
┌─────────────────────────┐                      ▲
│ markets.market_score    │                      │ optimized per type
└─────────────────────────┘                      │ weekly
                                                 │
                                    ┌────────────┴────────────┐
                                    │ ScorerWeightOptimizer   │
                                    │  loops over types with  │
                                    │  n >= MIN_TRADES (30)   │
                                    │  fallback: global row   │
                                    └─────────────────────────┘
```

## Design details

### 1. New dimension: `typeExpectedValue`

#### Definition

```typescript
// In MarketScorer
function typeExpectedValue(
  sharpe: number | null,
  nTrades: number,
  K = 20,       // shrinkage constant (env SCORER_SHRINKAGE_K)
  MIN_N = 5,    // below this, ignore entirely
): number {
  if (sharpe === null || nTrades < MIN_N) return 0.5;
  const shrunk = (sharpe * nTrades) / (nTrades + K);
  return clamp01((shrunk + 1) / 1.5);
}
```

#### Values with current data

| market_type | sharpe | n | shrunk | typeExpectedValue |
|---|---|---|---|---|
| event_financial | 0.27 | 159 | 0.240 | 0.827 |
| event_long | 0.17 | 1317 | 0.167 | 0.778 |
| event_short | 0.13 | 419 | 0.124 | 0.749 |
| crypto_intraday | 0.32 | 7 | 0.083 | 0.722 |
| crypto_daily | -1.02 | 4 | — | 0.500 (neutral, n<MIN_N) |

Range ≈ [0.50, 0.83] — ~2.5× wider than current `prior` (1.00–1.15), allowing the optimizer to assign meaningful weight.

Compression caveat: with current data the tradeable types span only [0.75, 0.83] (spread ≈ 0.08). That is narrow. The mapping was sized for an anticipated long-run Sharpe range of roughly [-1, +0.5] — sustained +0.5 Sharpe across 100+ trades would saturate to near 1.0. If after a few weeks the observed inter-type spread stays below ~0.10, recalibrate the mapping to a steeper slope (e.g., divide by 0.3 instead of 1.5) to give the optimizer more separation. Treated as an Open Item below.

#### When and where computed

Computed **on the fly** each Pass 1 scoring run. `MarketScorer.scoreAllMarkets()` preloads `category_performance` into a `Map<marketType, {sharpe, n_trades}>` before iterating markets; each market's type looks up once. Zero persistence in `markets` (no stale-state risk). `category_performance` itself is updated nightly by `compute-market-priors`.

#### Persistence at trade entry

When a position opens, the existing path that writes `score_dimensions_at_entry` (JSONB) adds the new field:

```jsonc
{
  "tradeability": 1.0,
  "liquidity": 0.42,
  "volatility": null,
  "ttr": 0.68,
  "dataQuality": null,
  "typeExpectedValue": 0.827   // NEW
}
```

### 2. Schema: per-type weights

#### Migration

```sql
ALTER TABLE scorer_weights ADD COLUMN market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
ALTER TABLE scorer_weights ADD COLUMN type_expected_value NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE scorer_weights ADD CONSTRAINT uniq_scorer_weights_market_type UNIQUE (market_type);
-- Existing single row picks up the default '__global__' automatically.
```

Design choice: use literal sentinel `'__global__'` instead of `NULL` for the fallback row. Rationale:
- Standard `UNIQUE(market_type)` works — no partial index.
- `ON CONFLICT (market_type) DO UPDATE` works uniformly for both per-type and global upserts (PostgreSQL cannot use partial indexes as ON CONFLICT targets without explicit WHERE clauses).
- Query logic stays simple: `WHERE market_type IN ($1, '__global__')`.

Constraints:
- `UNIQUE(market_type)` enforces one row per type + one `'__global__'` row.
- `type_expected_value` defaults 0 on legacy row (the only existing row) so it loads cleanly; optimizer overwrites it.

#### Historical trade backfill

One-shot migration at deploy time. Only touches post-reset trades. Must mirror the runtime `typeExpectedValue` function bit-for-bit — including the neutral (0.5) return for types with `n_trades < MIN_N` or missing Sharpe:

```sql
UPDATE paper_positions pp
SET score_dimensions_at_entry = score_dimensions_at_entry ||
  jsonb_build_object('typeExpectedValue',
    CASE
      WHEN cp.n_trades IS NULL OR cp.n_trades < 5 OR cp.sharpe_ratio IS NULL THEN 0.5
      ELSE GREATEST(0.0, LEAST(1.0,
        ((cp.sharpe_ratio * cp.n_trades / (cp.n_trades + 20.0)) + 1.0) / 1.5
      ))
    END
  )
FROM markets m
LEFT JOIN category_performance cp ON cp.market_type = m.market_type
WHERE m.id = pp.market_id
  AND pp.closed_at IS NOT NULL
  AND pp.score_dimensions_at_entry IS NOT NULL
  AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1);
```

Leakage note: backfill uses current `category_performance`, which includes each trade's own contribution. Per-type impact: event_long 0.08% weight, event_short 0.25%, event_financial 0.7%. Negligible for training.

Temporal filter (`>= last_reset_at`) excludes pre-reset data where strategy and parameters differed. `ORDER BY id LIMIT 1` guards against paper_account accidentally having more than one row in the future.

Expected result: ~1829 rows updated, split roughly 1290 event_long / 386 event_short / 147 event_financial / small remainder. crypto_daily trades (n=4 at category level) receive the neutral 0.5 via the CASE branch; crypto_intraday (n=7) computes normally.

### 3. MarketScorer changes

#### `ScoreDimensions` type

```typescript
export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
  typeExpectedValue: number;   // NEW
}
```

#### `ScorerWeights` type

```typescript
export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;   // NEW
}
```

Default weights (pre-optimization) redistribute a small allocation to the new dimension — e.g. current `WEIGHTS = { tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10 }` becomes `{ tradeability: 0.25, liquidity: 0.20, volatility: 0.15, ttr: 0.10, dataQuality: 0.10, typeExpectedValue: 0.20 }` — exact values finalized in implementation plan.

#### `compositeScore()`

Additive contribution of the new dim: `score += weights.typeExpectedValue * dims.typeExpectedValue`. No structural change; same normalization by weight-sum.

#### `loadWeights(marketType?: string)`

```typescript
const GLOBAL = '__global__';
const MIN_TRADES_FOR_PER_TYPE = 30;

static async loadWeights(marketType?: string): Promise<ScorerWeights> {
  const result = await query<WeightRow>(`
    SELECT tradeability, liquidity, volatility, ttr, data_quality, type_expected_value,
           market_type, n_trades
    FROM scorer_weights
    WHERE market_type IN ($1, $2)
    ORDER BY (market_type = $2) ASC     -- '__global__' last
    LIMIT 2
  `, [marketType ?? GLOBAL, GLOBAL]);

  // Prefer per-type row if it exists AND has been trained on enough data.
  const perType = result.rows.find(r => r.market_type === marketType);
  if (perType && (perType.n_trades ?? 0) >= MIN_TRADES_FOR_PER_TYPE) {
    return toWeights(perType);
  }
  const global = result.rows.find(r => r.market_type === GLOBAL);
  return toWeights(global ?? DEFAULT_WEIGHTS);
}
```

The n_trades guard is defense-in-depth — the optimizer only writes a per-type row when it has ≥ MIN_TRADES, so this branch rarely fires. Defends against a stale row left behind if an operator manually seeds a per-type row.

Cache: `Map<string, {weights, loadedAt}>` keyed by market_type (or `'__global__'`) in MarketScorer, TTL 5 min. No explicit cross-class invalidation — a freshly retrained per-type row is picked up within at most one cache TTL, which is well under the hourly Pass 1 / Pass 2 scoring cadence. Stale-weights window bounded to 5 minutes is acceptable given the weekly retrain schedule.

#### `scoreAllMarkets()` Pass 1

Current implementation is a single SQL UPDATE with hardcoded weights. With per-type weights, split into one UPDATE per type (5 types today) + one fallback UPDATE for `market_type IS NULL OR market_type NOT IN (known types)`:

```typescript
const allTypes = await query(`SELECT DISTINCT market_type FROM markets WHERE market_type IS NOT NULL`);
for (const { market_type } of allTypes.rows) {
  const weights = await MarketScorer.loadWeights(market_type);
  await query(`
    UPDATE markets SET market_score = (
      ${weights.tradeability} * <tradeability expr>
      + ${weights.liquidity} * <liquidity expr>
      + ${weights.ttr} * <ttr expr>
      + ${weights.typeExpectedValue} * <typeEV expr for market_type>
    )
    WHERE market_type = $1 AND tracking_status NOT IN ('warming', 'active', 'cooling')
    ...
  `, [market_type]);
}
// Fallback UPDATE for unknown/null market_type with global weights
```

`<typeEV expr>` is a numeric literal (typeExpectedValue computed once per type, interpolated into SQL). Performance: 5–6 UPDATEs of ~14k rows each, same index path as current. Expected overhead <100ms total.

#### Pass 2 (tracked markets, JS-side)

Pass 2 iterates tracked markets (`warming`/`active`/`cooling`), computes full `ScoreDimensions` in JS (including `volatility` and `dataQuality` from recent price history), and batch-updates. It must also use per-type weights. Plan: reuse the same `loadWeights(marketType)` path with its cache. Expected pattern in the loop body:

```typescript
for (const row of trackedRows) {
  const weights = await MarketScorer.loadWeights(row.market_type);
  const dims = { ...computedDims, typeExpectedValue: typeEVForType(row.market_type) };
  const score = MarketScorer.compositeScore(dims, weights);
  enrichUpdates.push({ ...row, score, dimensions: dims });
}
```

With the 5-min TTL cache, N calls to `loadWeights` across ~40 tracked markets reduce to ≤ 6 DB queries (one per distinct type).

The existing `EnrichUpdate` interface and the `market_score_history` persistence path both need to carry the new `typeExpectedValue` field through. Concrete code changes in those paths are an implementation-plan detail, noted here so they are not missed.

### 4. ScorerWeightOptimizer changes

#### `optimizeScorerWeights()` per-type loop

```typescript
export async function optimizeScorerWeights(): Promise<void> {
  const knownTypes = await query(`
    SELECT DISTINCT market_type FROM markets WHERE market_type IS NOT NULL
  `);

  for (const { market_type } of knownTypes.rows) {
    const trades = await loadClosedTrades(market_type);
    if (trades.length < MIN_TRADES) {
      logger.info({ market_type, n: trades.length }, 'Insufficient trades — skip type');
      continue;
    }
    const weights = runRandomSearch(trades, N_TRIALS);
    await saveWeights(weights, market_type, { nTrades: trades.length, ... });
  }

  // Global fallback row: all trades pooled
  const globalTrades = await loadClosedTrades(undefined); // no filter
  const globalWeights = runRandomSearch(globalTrades, N_TRIALS);
  await saveWeights(globalWeights, GLOBAL, { nTrades: globalTrades.length, ... });
}
```

#### `loadClosedTrades(marketType)` filters

```sql
SELECT pp.score_dimensions_at_entry, pp.realized_pnl
FROM paper_positions pp
JOIN markets m ON m.id = pp.market_id
WHERE pp.closed_at IS NOT NULL
  AND pp.score_dimensions_at_entry IS NOT NULL
  AND pp.score_dimensions_at_entry ? 'typeExpectedValue'   -- only trades with new feature
  AND pp.realized_pnl IS NOT NULL
  AND ($1::text IS NULL OR m.market_type = $1);
```

The `? 'typeExpectedValue'` filter excludes pre-backfill trades automatically. Post-backfill (which covers all post-reset trades) the filter is a no-op.

#### `saveWeights(weights, marketType, meta)`

```sql
INSERT INTO scorer_weights
  (market_type, tradeability, liquidity, volatility, ttr, data_quality, type_expected_value,
   n_trades, n_trials, best_value, updated_at)
VALUES ($1, $2, ..., NOW())
ON CONFLICT (market_type) DO UPDATE SET
  tradeability = EXCLUDED.tradeability, ..., updated_at = NOW();
```

`market_type` is either a concrete type string or `'__global__'`. The non-partial `UNIQUE(market_type)` constraint accepts both uniformly.

#### Manual trigger post-deploy

Add a one-shot script at `scripts/trigger-scorer-optimization.js` that SSH-executes the optimizer via an already-existing admin endpoint, or direct DB-connected Node. Avoids waiting until next Monday 03:17 UTC for first retraining after deploy.

### 5. MarketRotator integration

**No code changes.** The rotator reads `markets.market_score` which the scorer will now populate using per-type weights. No schema change in rotator's queries. The filter for extreme prices (PR #122) remains.

Expected emergent behavior:
- event_financial rises to top of the ranking (high typeExpectedValue + per-type tuned weights).
- event_long loses rank share (its dimensions barely correlate, so their weights drop; typeExpectedValue lifts it only moderately).
- crypto_intraday scores ≈0.72 via typeExpectedValue alone (global fallback on dimensions), competing with mid-ranked events.
- crypto_daily stays near the bottom (neutral typeExpectedValue due to low n + negative Sharpe).

No explicit diversity quota is added. If after 2 weeks the crypto allocation is still zero organically, that decision gets revisited in follow-up work.

## Tests

### Unit tests

`MarketScorer.test.ts`:
- `typeExpectedValue(null, *)` → 0.5
- `typeExpectedValue(0.32, 4)` → 0.5 (n < MIN_N)
- `typeExpectedValue(0.27, 159, K=20)` → 0.827 ± rounding
- `typeExpectedValue(-1.02, 4)` → 0.5 (n < MIN_N; negative Sharpe irrelevant below threshold)
- `typeExpectedValue(2.0, 1000)` → clamped to 1.0
- `loadWeights('event_financial')` with per-type + global rows → returns per-type
- `loadWeights('event_financial')` with only global row → returns global
- `loadWeights('unknown_type')` → returns global

`ScorerWeightOptimizer.test.ts`:
- Optimizer loop iterates known types; skips types with < MIN_TRADES; saves per-type rows
- `loadClosedTrades('event_financial')` filters to that type's trades only
- `loadClosedTrades(null)` loads all trades

### Integration tests

- Backfill migration on synthetic trades produces expected `typeExpectedValue` values.
- Full scoring pipeline: seed markets of 3 types, seed per-type weights rows, verify `market_score` computed matches expected composite.
- Idempotency: running migration twice is safe (existing `typeExpectedValue` is overwritten with current value, no duplicate rows).

### Post-deploy manual verification

1. `SELECT COUNT(*) FROM paper_positions WHERE (score_dimensions_at_entry->>'typeExpectedValue') IS NOT NULL;` → ~1829.
2. Trigger optimizer (manual script), then `SELECT market_type, n_trades, best_value FROM scorer_weights ORDER BY market_type;` → 4 rows (global + event_long + event_short + event_financial).
3. Re-run correlation query from roadmap — global and per-type Pearson should improve (even on training-set evaluation).
4. After 1 hour, `SELECT market_type, ROUND(AVG(market_score)::numeric, 3) FROM markets WHERE tracking_status = 'cold' AND is_active AND NOT is_resolved GROUP BY market_type;` — event_financial avg should exceed event_long avg.
5. After 24 hours, `SELECT market_type, tracking_status, COUNT(*) FROM markets WHERE tracking_status IN ('warming', 'active', 'cooling') GROUP BY market_type, tracking_status;` — diversity of types in warming pool should increase.

## Success metrics

### Gate (2 weeks post-deploy)

- **Primary**: Pearson correlation of `market_score_at_entry` vs `realized_pnl` across all post-deploy trades > **0** (strict positive, vs -0.04 baseline).
- **Secondary**: per-type Pearson for event_financial > **+0.20**; for event_long > **-0.02** (i.e. no worse than baseline noise).

### Target (1 month)

- Global Pearson > **+0.15**.
- Warming pool composition: no single type > 60% of slots.
- At least one crypto_intraday market reaches `tracking_status = 'active'` via organic selection.

### Continuous monitoring

- `scorer_weights.best_value` per row tracked over time. Decay (weekly delta > -0.02) signals the per-type correlation is eroding → triggers investigation.
- A scheduled summary query dumps weights + best_value + n_trades per type weekly, appended to review history JSON for trend visibility.

## Rollback

If 2-week gate misses:

```sql
DELETE FROM scorer_weights WHERE market_type != '__global__';
-- '__global__' row remains and is used for all markets (pre-A behavior with typeExpectedValue still in composite).
```

The `typeExpectedValue` dimension itself stays — it is additive, so its harm is bounded by its allocated weight. If the optimizer has assigned it non-trivial weight and the dimension turns out to be miscalibrated (e.g., because `category_performance` is drifting faster than weekly optimization can track), further rollback:

```sql
UPDATE scorer_weights SET type_expected_value = 0 WHERE market_type = '__global__';
-- Dimension still in schema but contributes 0 to composite. Easy toggle.
```

Full code rollback: revert the PR. The migration's backfill writes can be left in place (harmless JSONB extension). The schema columns (`market_type`, `type_expected_value`) stay; they don't affect the pre-A code paths.

## Out of scope

- Signal engine changes.
- `MarketRotator` logic changes.
- New features (realized vol, spread, signal aggregates) — Sub-project B.
- Non-random-search optimizers (Bayesian, Optuna-style) — potential follow-up if random search hits a ceiling.
- Changes to `compute-market-priors` beyond reading its output.

## Open items for implementation plan

- Exact default-weight allocation for the new dimension (currently proposed 0.20, to be calibrated against pre-optimization behavior).
- Cache TTL for `loadWeights()` per type. Proposed 5 min; could be invalidated explicitly when optimizer writes new weights.
- Whether to add a `last_reset_at` filter to `loadClosedTrades()` in the optimizer. Arguments both ways: filter protects against regime change, no-filter maximizes training data. Default: filter included, env-var to disable.
- Whether per-type rows need `best_value` column (yes, for monitoring) and whether `scorer_weights_history` table is needed. Proposed: skip history table for A; adds complexity and the scheduler's stats dump / weekly summary are sufficient short-term.
- Calibration of the `(shrunk + 1) / 1.5` mapping. Narrow inter-type spread in current data (~0.08 across tradeable types) may leave the optimizer unable to meaningfully differentiate. Action item: re-inspect the observed `typeExpectedValue` distribution after one retraining cycle. If the spread stays < 0.10, tighten the mapping (e.g. divide by 0.3 to spread the typical `[-0.05, +0.25]` shrunk range across the full [0, 1]). Keep the clamp.
- Whether the 2-week gate uses in-sample `best_value` from the optimizer or out-of-sample correlation on post-deploy trades. Default: in-sample + trend (best_value monotonic over consecutive Monday retrains), because strict OOS requires holding out a future window that the weekly-retrain cycle doesn't produce. A separate OOS-monitoring script is follow-up work, not part of Sub-project A.

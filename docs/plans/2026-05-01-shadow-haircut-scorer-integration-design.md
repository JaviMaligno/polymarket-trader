# Two-Source Type Expected Value: Shadow Dimension Added to MarketScorer

**Date:** 2026-05-01
**Branch:** `feat/shadow-haircut-scorer-integration`
**Status:** approved, ready for plan
**Scope:** purely additive. `category_performance` (live) and `MarketScorer.typeExpectedValue` are **unchanged**. A new dimension `shadowExpectedValue` is added with its own table and writer.

---

## 1. Problem

`event_short` has shadow Sharpe **+2.03** (n=444 resolved) but its `category_performance.sharpe_ratio` is **+0.13** (n=419 historic live trades, mostly pre-fix). The `MarketScorer.typeExpectedValue` dimension reads only live data, so event_short's strong shadow validation never reaches the score that drives `MarketRotator` candidate ranking.

Today: event_short has 14 cold candidates with `market_score >= 0.6` but only 2 markets in active. event_financial dominates (23 active) because its raw scoring is structurally higher (volume/liquidity), not because its signals are more correct.

The asymmetry is real: shadow has labeled event_short as the strongest available signal (Sharpe 2.03, 88.5% WR), but the scorer is blind to that.

## 2. Empirical analysis of the shadow/live gap

The original "16x ratio" reported in `memory/project_shadow_execution_realism.md` (event_short shadow 2.03 / live 0.13 all-time) conflated two effects: (a) regime change between live's historic sample and shadow's recent sample, and (b) execution-realism gap (absent fees, slippage, early exits, risk gates).

Time-matched analysis (2026-05-01, shadow's epoch 2026-04-13 → 2026-04-21):

| type | live n | live Sharpe | shadow n | shadow Sharpe | ratio |
|---|---|---|---|---|---|
| event_long | 16 | -0.33 | 333 | -0.99 | 0.33 |
| event_short | 1 | (insufficient) | 444 | +2.03 | unobservable |

Decomposition by component:

| Component | Magnitude | Source |
|---|---|---|
| **Fees** | <0.1% of avg_pnl per trade. **Negligible.** | Measured directly: shadow Sharpe with vs without fee subtraction differs in the 4th decimal. avg_fee_round_trip event_short = $0.28 vs avg_pnl $383. |
| **Slippage** | Variable, not measured | Per `OrderBookExecutionSimulator`, depends on book depth. |
| **Early exits** | Live closes via stop-loss / signal-driven; shadow holds to resolution. **Probably the largest contributor.** | Structural — not a simple scaling factor. |
| **Risk gates** | Live rejects via SHORT gate, concentration gate, near-expiry gate; shadow does not. | Structural — affects which trades are even taken. |
| **Position sizing** | Live respects `MaxPositionSizePct`; shadow uses `theoretical_size` unconstrained. | Structural — affects per-trade variance. |

**Conclusion**: a single multiplicative haircut on shadow Sharpe is conceptually weak because the gap is dominated by structural differences, not by fees. Better to **separate live and shadow as distinct evidence streams** with their own weights, each contributing what they're good at.

## 3. Solution: shadow as additive dimension

Add a new dimension `shadowExpectedValue` to `MarketScorer.compositeScore`:

| Dimension | Source | Weight | Change |
|---|---|---|---|
| `tradeability` | unchanged | 0.21 → 0.1995 | rescaled |
| `liquidity` | unchanged | 0.17 → 0.1615 | rescaled |
| `volatility` | unchanged | 0.15 → 0.1425 | rescaled |
| `ttr` | unchanged | 0.08 → 0.0760 | rescaled |
| `dataQuality` | unchanged | 0.10 → 0.0950 | rescaled |
| `typeExpectedValue` | `category_performance` (live, **all-time**, unchanged) | 0.17 → 0.1615 | rescaled |
| `realizedVolatility` | unchanged | 0.12 → 0.1140 | rescaled |
| **`shadowExpectedValue`** | `category_performance_shadow` (new) | **0.05** | **NEW** |

All other dimensions are scaled by `0.95` factor so the total still sums to 1.0. The data sources and formulas of every other dimension are unchanged.

`typeExpectedValue` keeps reading `category_performance` exactly as today (all-time live data, no time window). Even when sample is historic and pre-fix, that evidence is preserved as one input. `shadowExpectedValue` adds the recent-regime signal via shadow data, downweighted to reflect its theoretical-execution nature.

### Why no time window on live

The previous draft proposed a 7-day window on live to "force regime-current data". Concrete numbers showed this would actually penalise event_short (it would lose its current 0.749 typeEV → 0.5 neutral, and the 0.05-weight shadow boost wouldn't compensate). The keep-historical-live design is purely additive: shadow boosts event_short on top of its existing live evidence, instead of replacing it.

If a future regime change makes long-tail historical evidence misleading, that's a separate spec — out of scope here.

### Why 0.05 weight for shadow

Sized so the addition is meaningful but cannot dominate. Concretely:

- event_short composite contribution before: typeEV 0.749 × 0.17 = **0.127**
- event_short composite contribution after: typeEV 0.749 × 0.1615 + shadowEV 1.0 × 0.05 = 0.121 + 0.050 = **0.171**
- Net delta: **+0.044** to event_short's composite score.
- event_financial (no shadow data) goes from 0.138 → 0.131 (slight rescale-down because its weight share dropped). Net delta: **−0.007**.
- **Spread between the two flips**: event_short was 0.011 below event_financial; now event_short is 0.040 above. Sufficient to enter the rotator's top-50 candidates.

If validation suggests 0.05 is too low (event_short still starved) or too high (other types over-promoted), follow-up PR adjusts. Weight is **not** env-tunable: changing scoring weights at runtime is too risky for a single env knob; it requires deliberate review.

## 4. Architecture / Data flow

```
Scheduler (daily 02:45 UTC)
    ↓
computeMarketPriors()
    ├── updateCategoryPriors()         ← UNCHANGED. Writes category_performance from live trades.
    ├── updateShadowCategoryPerformance()  ← NEW. Writes category_performance_shadow with haircut.
    └── resolveShadowTrades()          ← unchanged
    ↓ (~30 min later, scoring run)
MarketScorer.scoreAllMarkets()
    ├── Loads category_performance        (live, existing)
    ├── Loads category_performance_shadow (NEW)
    ├── For each market:
    │     typeEV    = typeExpectedValue(live_row.sharpe, live_row.n_trades)        ← unchanged formula
    │     shadowEV  = shadowExpectedValue(shadow_row.sharpe, shadow_row.n_trades)  ← new dim
    │     composite = weighted_sum(all_dims)                                       ← +0.05 shadow weight
    └── UPDATE markets.market_score
    ↓ (next rotation cycle)
MarketRotator picks top-50 candidates by market_score
```

`updateCategoryPriors` is untouched. Only one new writer (`updateShadowCategoryPerformance`), one new MarketScorer method (`shadowExpectedValue`), and the dim added to the composite weighted sum.

## 5. Schema

### 5.1 Migration `029_category_performance_shadow.sql` (new)

```sql
CREATE TABLE IF NOT EXISTS category_performance_shadow (
  market_type     VARCHAR(20)  PRIMARY KEY,
  win_rate        DOUBLE PRECISION,
  avg_pnl         DOUBLE PRECISION,
  sharpe_ratio    DOUBLE PRECISION,
  n_trades        INTEGER NOT NULL DEFAULT 0,
  prior           DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0.33,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Bootstrap: empty. updateShadowCategoryPerformance fills it on first daily run.
```

`haircut_applied` is stored per-row so daily review can audit what haircut was used at write time, even if `SHADOW_HAIRCUT` env var changes later.

### 5.2 Runtime startup hook (mirrors PR #163 pattern)

`bootstrapShadowCategoryPerformanceTable()` runs on dashboard-api startup, idempotent `CREATE TABLE IF NOT EXISTS`. Same try/catch shape as `bootstrapDirectionMultiplierRows`. Required because init/*.sql only fires on first volume creation, and the production VM volume already exists.

## 6. Concrete SQL queries

### 6.1 Live (unchanged from current `updateCategoryPriors`)

```sql
SELECT m.market_type,
       COUNT(*)::text AS n_trades,
       AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END)::text AS win_rate,
       AVG(p.realized_pnl)::text AS avg_pnl,
       CASE WHEN STDDEV(p.realized_pnl) > 0
            THEN (AVG(p.realized_pnl) / STDDEV(p.realized_pnl))::text
            ELSE '0' END AS sharpe_ratio
FROM paper_positions p
JOIN markets m ON p.market_id = m.id
WHERE p.closed_at IS NOT NULL
  AND p.realized_pnl IS NOT NULL
  AND m.market_type IS NOT NULL
GROUP BY m.market_type
```

No changes — this is the existing query already used by `updateCategoryPriors`.

### 6.2 Shadow (new query in `updateShadowCategoryPerformance`)

```sql
SELECT market_type,
       COUNT(*) AS n_trades,
       AVG(theoretical_pnl) AS avg_pnl,
       (CASE WHEN STDDEV(theoretical_pnl) > 0
             THEN AVG(theoretical_pnl) / STDDEV(theoretical_pnl)
             ELSE 0 END) AS raw_sharpe,
       AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
FROM shadow_trades
WHERE resolved_at IS NOT NULL
  AND theoretical_pnl IS NOT NULL
GROUP BY market_type
HAVING COUNT(*) >= $1                                  -- $1 = CATEGORY_MIN_SHADOW_N
```

The TS code computes `effective_sharpe = raw_sharpe * SHADOW_HAIRCUT` before upserting into `category_performance_shadow`.

## 7. MarketScorer changes

### 7.1 New static method

```typescript
/**
 * Shadow Expected Value dimension. Mirrors typeExpectedValue but reads
 * the haircut-adjusted shadow Sharpe. Returns 0.5 (neutral) when shadow
 * data is insufficient.
 */
static shadowExpectedValue(
  effectiveSharpe: number | null,
  nTrades: number,
  K: number = SCORER_SHRINKAGE_K,
  MIN_N: number = 5,
): number {
  if (!Number.isFinite(K)) K = SCORER_SHRINKAGE_K;
  if (effectiveSharpe === null || nTrades < MIN_N) return 0.5;
  const shrunk = (effectiveSharpe * nTrades) / (nTrades + K);
  return clamp01((shrunk + 1) / 1.5);
}
```

Identical formula to the existing `typeExpectedValue`, only differs in data source. Reusing the same shrinkage and mapping keeps the two dimensions on a comparable [0, 1] scale.

### 7.2 Updated WEIGHTS

```typescript
export const WEIGHTS = {
  tradeability:       0.1995,  // 0.21 × 0.95
  liquidity:          0.1615,  // 0.17 × 0.95
  volatility:         0.1425,  // 0.15 × 0.95
  ttr:                0.0760,  // 0.08 × 0.95
  dataQuality:        0.0950,  // 0.10 × 0.95
  typeExpectedValue:  0.1615,  // 0.17 × 0.95 (formula unchanged; only weight rescales)
  realizedVolatility: 0.1140,  // 0.12 × 0.95
  shadowExpectedValue: 0.0500, // NEW
} as const;
// Total: 1.0000
```

A unit test verifies the sum is exactly 1.0 within float tolerance.

### 7.3 Updated `compositeScore`

Add the new dimension to the weighted sum, following the same null-handling pattern as the other always-present dimensions:

```typescript
weightedSum += dims.shadowExpectedValue * weights.shadowExpectedValue;
totalWeight += weights.shadowExpectedValue;
```

When `dims.shadowExpectedValue` is `0.5` neutral (no shadow data), the dimension contributes 0.025 to numerator and 0.05 to denominator — net effect on composite is zero relative drag (it adds equal weight to both sides, leaving normalized score unchanged). This is intentional: types without shadow data are not penalised.

### 7.4 New `loadAllCategoryMetrics`

Replaces the single-source `loadCategoryMetrics`:

```typescript
static async loadAllCategoryMetrics(): Promise<{
  live:   Map<string, { sharpe: number | null; n: number }>;
  shadow: Map<string, { sharpe: number | null; n: number }>;
}> {
  // Two queries via Promise.all, both wrapped in try/catch.
  // Empty maps on any error → both EVs default to 0.5 (neutral).
}
```

Old `loadCategoryMetrics` is deleted; nothing else uses it.

### 7.5 `scoreAllMarkets` integration

Where Pass 1 currently calls `MarketScorer.typeExpectedValue(...)` per market_type, also call `MarketScorer.shadowExpectedValue(...)` with the matching shadow row, and pass both into the dimensions object. Same pattern in Pass 2 (enrich tracked).

## 8. Constants & env vars

```typescript
const CATEGORY_MIN_SHADOW_N = parseInt(process.env.CATEGORY_MIN_SHADOW_N ?? '30', 10);
const SHADOW_HAIRCUT = parseFloat(process.env.SHADOW_HAIRCUT ?? '0.33');
```

`shadowExpectedValue` weight `0.05` is **not** env-tunable. Changing dimension weights is a deliberate scoring decision that goes through code review.

`SHADOW_HAIRCUT=0.33` is the working empirical estimate from `memory/project_shadow_execution_realism.md`. Sample is small (n_live=16 in time-matched comparison); operator can adjust based on daily review's `implied_haircut` metric (§10).

## 9. Bootstrap behavior

Daily 02:45 UTC run after deploy populates:

| type | live (existing) | shadow (new) | typeEV | shadowEV | composite contribution |
|---|---|---|---|---|---|
| event_short | sharpe=0.13, n=419 | sharpe=2.03×0.33=0.67, n=444 | 0.749 | ~1.0 | 0.121 + 0.050 = **0.171** |
| event_financial | sharpe=0.23, n=201 | shadow has 0 resolved | 0.812 | 0.5 (neutral) | 0.131 + 0.025 = **0.156** |
| event_long | sharpe=0.17, n=1317 | sharpe=−0.99×0.33=−0.33, n=333 | 0.778 | ~0.46 | 0.126 + 0.023 = **0.149** |
| crypto_intraday | sharpe=0.28, n=8 (insufficient) | shadow has 0 resolved | 0.5 (neutral) | 0.5 (neutral) | 0.081 + 0.025 = **0.106** |
| crypto_daily | sharpe=−1.02, n=4 (insufficient) | shadow has 0 resolved | 0.5 (neutral) | 0.5 (neutral) | 0.081 + 0.025 = **0.106** |

Key effects:
- **event_short overtakes event_financial in scoring contribution** (0.171 vs 0.156) for the first time.
- **event_long** stays scored but lower — fine because allowlist excludes it from the live executor.
- **crypto_***: no change (no shadow data, no live sample). Still gated by Crypto Data Gap upstream.

The pool composition should shift: event_short candidates rise in the top-50 ranking, displacing some event_financial candidates over the next 1-2 rotation cycles.

## 10. Daily review validation query

Updates to `scripts/daily-review-prompt.md` add:

```sql
SELECT cp.market_type,
       cp.sharpe_ratio AS live_sharpe,
       cp.n_trades AS live_n,
       cps.sharpe_ratio AS shadow_effective_sharpe,
       cps.n_trades AS shadow_n,
       cps.haircut_applied,
       -- Implied haircut: if we know live_sharpe (recent stable signal), what would the
       -- haircut have to be for shadow_effective to match it?
       CASE
         WHEN cp.n_trades >= 30 AND cps.n_trades >= 30 AND cps.sharpe_ratio != 0
         THEN ROUND(
           (cp.sharpe_ratio / NULLIF(cps.sharpe_ratio / cps.haircut_applied, 0))::numeric,
           3
         )
         ELSE NULL
       END AS implied_haircut
FROM category_performance cp
LEFT JOIN category_performance_shadow cps ON cps.market_type = cp.market_type
ORDER BY cp.market_type;
```

Daily review interpretation rules:
- For each row with both live and shadow data ≥30 trades, the `implied_haircut` should be in `[0.15, 0.55]` (approximately the 0.33 ± 0.20 band). Outside that band → flag for per-type haircut consideration.
- For types with shadow data but no live data (e.g. event_short until rotation pulls it in), the shadow signal is the only evidence — note in review that we are operating on shadow-only.
- Sign disagreement (live positive, shadow negative or vice versa) is a regime-divergence flag — surface for human review.

## 11. Files touched

```
packages/data-collector/src/database/init/029_category_performance_shadow.sql       [new schema]
packages/data-collector/src/services/MarketPerformanceTracker.ts                    [+updateShadowCategoryPerformance; updateCategoryPriors unchanged]
packages/data-collector/src/services/MarketPerformanceTracker.test.ts               [+tests for new writer + haircut env]
packages/data-collector/src/services/MarketScorer.ts                                [+shadowExpectedValue method; rescaled WEIGHTS; updated compositeScore; new loadAllCategoryMetrics]
packages/data-collector/src/services/MarketScorer.test.ts                           [+tests for new dim, weight invariants, two-source composite]
packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts               [new — runtime startup hook]
packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts          [new — unit test for SQL string]
packages/dashboard/src/server.ts                                                    [+wire bootstrap hook]
scripts/daily-review-prompt.md                                                      [+shadow validation section]
docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md                   [this spec]
```

Estimated scope: 5 files modified + 4 files new. Total ≈ 300 LOC, dominated by tests. Single PR.

## 12. Test plan

### 12.1 Unit tests

- **`MarketScorer.shadowExpectedValue`**: same coverage as existing `typeExpectedValue` tests (boundary cases, MIN_N=5, NaN handling, K shrinkage, clamp to [0, 1]).
- **`MarketScorer.WEIGHTS`**: assert sum equals 1.0 within float tolerance.
- **`MarketScorer.compositeScore`**: 
    - shadowEV present → contributes 0.05 weight to weighted sum.
    - shadowEV null → renormalises remaining dims (existing optional-dim pattern).
    - shadowEV 0.5 (neutral) on a type with no shadow data → composite identical to no-shadow-dim baseline within float tolerance.
- **`MarketPerformanceTracker.updateShadowCategoryPerformance`**:
    - Applies haircut to raw shadow Sharpe before upsert.
    - Stores `haircut_applied` per row.
    - Skips upsert when `n_trades < CATEGORY_MIN_SHADOW_N`.
    - Honors `SHADOW_HAIRCUT` env var override.
- **`bootstrapShadowCategoryPerformance`**: SQL contains `CREATE TABLE IF NOT EXISTS category_performance_shadow`; idempotent.

### 12.2 Regression

- Existing `MarketScorer` tests pass with the rescaled WEIGHTS (existing tests should not assert weights individually; if they do, update them to the new values).
- Existing `MarketPerformanceTracker.computePrior` tests unchanged (the prior formula is reused for both writers).

### 12.3 Smoke (post-deploy)

§10 daily review query returns rows for both tables, with `implied_haircut` computed where both have ≥30 trades.

## 13. Validation post-deploy

### 13.1 Immediate (within 1 hour after first 02:45 UTC daily run)

```sql
SELECT * FROM category_performance_shadow ORDER BY market_type;
```
Expected: rows for `event_long` and `event_short` (the two types with shadow_resolved ≥ 30); `haircut_applied = 0.33`; `sharpe_ratio` = raw_shadow_Sharpe × 0.33.

### 13.2 After 24 hours

Pool composition shift:

```sql
SELECT m.market_type,
       COUNT(*) FILTER (WHERE m.tracking_status = 'active') AS active,
       COUNT(*) FILTER (WHERE m.tracking_status = 'cold' AND m.market_score >= 0.6) AS cold_top
FROM markets m
WHERE m.is_active = true AND m.is_resolved = false
GROUP BY m.market_type ORDER BY m.market_type;
```

Compare with pre-deploy snapshot. **Expected: event_short active count rises from 2 toward 5+** as the rotator promotes high-shadow-EV candidates over the next 2-3 rotation cycles.

### 13.3 Tuning levers if event_short still starved after 48h

In order of preference:

1. **Lower `SHADOW_HAIRCUT=0.20`** — assumes the gap is larger than estimated; shadow gets more aggressive penalty. Reduces event_short shadowEV but only marginally given the big margin. Probably wrong direction.
2. **Raise `SHADOW_HAIRCUT=0.50`** — assumes shadow over-estimates less than thought; event_short shadowEV stays clamped at 1.0 but shadow contributions for other types get larger. Indirect.
3. **Follow-up PR raising `shadowExpectedValue` weight** from `0.05` to `0.08–0.10`. The most direct lever if shadow is empirically reliable but underweighted. Requires fresh review.
4. **Reopen rotator-side z-score-per-type spec**. Last resort because it conflicts with the merit-based-only rule (`feedback_no_diversity_quota.md`).

### 13.4 After 1 week

- Run §10 daily review query.
- If `implied_haircut` for event_short is consistently in `[0.15, 0.55]`, the universal 0.33 is roughly right. Keep.
- If consistently outside that band, open follow-up PR for per-type haircut overrides (e.g. `SHADOW_HAIRCUT_EVENT_SHORT`).
- If event_short live now has ≥30 trades over 7d (rotation working), live is the dominant signal via typeEV; shadow continues as secondary.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Universal `SHADOW_HAIRCUT=0.33` poorly calibrated for some types | Daily review surfaces `implied_haircut` per type; per-type override is documented follow-up |
| Live `category_performance` includes pre-fix historical data that skews typeEV positively for types that have since changed regime | This is preserved deliberately. The shadow dim adds the recent-regime signal; if a type's live history is stale-positive, the shadow data is the corrective signal. event_long demonstrates: typeEV stays positive (0.778) because of historical strong sample, but shadowEV drags it down (0.46) reflecting current adversity. |
| `0.05` shadow weight too low to move event_short out of starvation | Pre-computed (§9): event_short's composite contribution rises from 0.127 to 0.171, overtaking event_financial's 0.156 by 0.015. Sufficient margin. If post-deploy shows otherwise, §13.3 step 3 raises the weight |
| Schema migration fails on production | Boot helper in dashboard-api startup, wrapped in try/catch, won't block boot if it fails. Same pattern as PR #163 |
| event_long enters live executor pool via shadow | Won't happen: `ALLOWED_MARKET_TYPES` excludes event_long downstream. shadow can't bypass that |
| Shadow data is missing for new types (crypto_*) | They get `shadowEV=0.5` neutral — no penalty, no boost. Composite unchanged for those types. |

## 15. Non-goals / Out of scope

- **Per-type shadow haircuts** (`SHADOW_HAIRCUT_EVENT_SHORT` etc): deliberately deferred. Universal haircut first; per-type override only after data justifies.
- **Adaptive haircut** that auto-adjusts from live/shadow ratios over time: deferred.
- **Modeling shadow execution-realism at the source** (subtract simulated stop-loss exits, risk gate rejections, slippage): out of scope. The two-dimension architecture sidesteps this by treating shadow as a separate, downweighted evidence stream.
- **Time-windowing live data** (`category_performance` over last N days): considered and rejected (§3 rationale). Live history is preserved in full.
- **Rotator-side z-score-per-type**: explicitly not done in this spec. Last-resort fallback if the scorer change alone is insufficient (§13.3 step 4).

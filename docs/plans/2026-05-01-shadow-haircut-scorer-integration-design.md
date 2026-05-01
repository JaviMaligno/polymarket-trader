# Shadow Haircut Scorer Integration — Design Spec

**Date:** 2026-05-01
**Branch:** `feat/shadow-haircut-scorer-integration`
**Status:** approved, ready for plan

---

## 1. Problem

`event_short` shadow Sharpe is **+2.03** (n=444 resolved) but its `category_performance.sharpe_ratio` is **+0.13** (n=419 historic live trades, mostly pre-fixes). The `MarketScorer.typeExpectedValue` dimension (weight 0.17) reads exclusively from live data, so event_short's strong shadow validation never reaches the score that drives `MarketRotator` candidate ranking.

Net result: `event_short` has 14 cold candidates with `market_score >= 0.6` but only 2 markets in `tracking_status='active'`. `event_financial` dominates the top-50 candidates query (28/50) because its raw scoring is structurally higher (more volume/liquidity) — not because its signals are more correct.

Today's data (2026-05-01) confirms the bias is asymmetric per type:

| type | live Sharpe (all-time) | shadow Sharpe | n_live | n_shadow_resolved |
|---|---|---|---|---|
| event_long | +0.17 | −0.99 | 1317 | 333 |
| event_short | +0.13 | +2.03 | 419 | 444 |
| event_financial | +0.23 | (0 resolved) | 201 | 0 |

The all-time live numbers are not representative of the current regime: event_long was removed from `ALLOWED_MARKET_TYPES` after shadow flagged it; event_short is starved by the rotator; event_financial has live recent flow but historical Sharpe predates dm-per-type fixes.

## 2. Solution

Modify `MarketPerformanceTracker.updateCategoryPriors()` to compute `category_performance.sharpe_ratio` per market_type using a routing rule:

1. **Live recent (preferred)**: if `live_n_recent >= 30` (closed positions in last 7 days), use the time-windowed live Sharpe.
2. **Shadow with empirical haircut (fallback)**: if `shadow_n_resolved >= 30`, use `shadow_sharpe × 0.33`.
3. **Insufficient evidence**: skip the upsert. The row falls back to the seed/prior state, and `MarketScorer.typeExpectedValue` returns its neutral 0.5 default when `n_trades < 5`.

The 0.33 haircut is the time-matched live/shadow Sharpe ratio observed for `event_long` in the shadow's epoch (2026-04-13 to 2026-04-21, n_live=16, n_shadow=333). It approximates the absent-fees-and-slippage gap. The sample is small; the haircut is a **working hypothesis** to validate post-deploy, not a calibrated constant. Documented in `memory/project_shadow_execution_realism.md`.

The MarketScorer integration is unchanged: `typeExpectedValue` reads `category_performance.sharpe_ratio` and `n_trades` as today; only the writer changes.

## 3. Architecture / Data flow

```
Scheduler (daily 02:45 UTC)
    ↓
computeMarketPriors()
    ↓
updateCategoryPriors()  ← refactored
    ├── Query 1: live recent Sharpe per type
    │       paper_positions JOIN markets
    │       WHERE closed_at > NOW() - INTERVAL '<window> days'
    │       GROUP BY market_type
    ├── Query 2: shadow Sharpe per type
    │       shadow_trades
    │       WHERE resolved_at IS NOT NULL
    │       GROUP BY market_type
    └── JS-side merge per market_type:
            if live.n >= MIN_LIVE_RECENT_N
                → upsert { sharpe: live.sharpe, n: live.n }
            elif shadow.n >= MIN_SHADOW_N
                → upsert { sharpe: shadow.sharpe * SHADOW_HAIRCUT, n: shadow.n }
            else
                → skip upsert (row unchanged; reads default to neutral)
    ↓
resolveShadowTrades()  (unchanged)
    ↓ (~6h later, next scoring run)
MarketScorer.scoreAllMarkets() → typeExpectedValue() → market_score
    ↓ (every rotation cycle)
MarketRotator picks top-50 candidates
```

Single function changed (`updateCategoryPriors`); no new services, no schedule changes, no schema changes.

## 4. Concrete SQL queries

### 4.1 Live recent

```sql
SELECT m.market_type,
       COUNT(*) AS n_trades,
       AVG(p.realized_pnl) AS avg_pnl,
       (CASE WHEN STDDEV(p.realized_pnl) > 0
             THEN AVG(p.realized_pnl) / STDDEV(p.realized_pnl)
             ELSE 0 END) AS sharpe_ratio,
       AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
FROM paper_positions p
JOIN markets m ON p.market_id = m.id
WHERE p.closed_at IS NOT NULL
  AND p.realized_pnl IS NOT NULL
  AND m.market_type IS NOT NULL
  AND p.closed_at > NOW() - (INTERVAL '1 day' * $1)   -- $1 = CATEGORY_LIVE_RECENT_DAYS
GROUP BY m.market_type
```

### 4.2 Shadow

```sql
SELECT market_type,
       COUNT(*) AS n_trades,
       AVG(theoretical_pnl) AS avg_pnl,
       (CASE WHEN STDDEV(theoretical_pnl) > 0
             THEN AVG(theoretical_pnl) / STDDEV(theoretical_pnl)
             ELSE 0 END) AS sharpe_ratio,
       AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
FROM shadow_trades
WHERE resolved_at IS NOT NULL
  AND theoretical_pnl IS NOT NULL
GROUP BY market_type
```

No epoch filter on shadow (we use whatever resolved data exists; resolution timestamps are inherently recent because resolution requires market end_date to pass).

## 5. Constants and env vars

```typescript
const CATEGORY_LIVE_RECENT_DAYS = parseInt(process.env.CATEGORY_LIVE_RECENT_DAYS ?? '7', 10);
const MIN_LIVE_RECENT_N = parseInt(process.env.CATEGORY_MIN_LIVE_RECENT_N ?? '30', 10);
const MIN_SHADOW_N = parseInt(process.env.CATEGORY_MIN_SHADOW_N ?? '30', 10);
const SHADOW_HAIRCUT = parseFloat(process.env.SHADOW_HAIRCUT ?? '0.33');
```

All four are env-tunable. If post-deploy validation shows the haircut needs adjustment per type, this stays simple — operator changes the env var, no redeploy needed for the core formula. Per-type haircuts are out of scope (see §10).

The user noted that 7 days may be too long or too short — this is the parameter most likely to need tuning. Operator can lower to 5 or 10 days based on observed type sample sizes.

## 6. Bootstrap behavior

Immediate, no phased migration. The daily 02:45 UTC run that follows the deploy will recompute per type:

| type | pre-deploy `category_performance` | expected post-deploy | notes |
|---|---|---|---|
| event_short | sharpe=0.13, n=419, prior=1.06 | sharpe=0.67 (=2.03·0.33), n=444, prior≈1.4 | shadow source; the desired effect |
| event_financial | sharpe=0.23, n=201 | depends on 7-day live count | likely live source if n_recent ≥ 30 |
| event_long | sharpe=0.17, n=1317 | sharpe=−0.33 (=−0.99·0.33), n=333, prior≈0.6 | shadow source; correct because allowlist excludes |
| crypto_intraday | sharpe=0.28, n=8 | row skipped if both n_live<30 and n_shadow<30 | falls back to neutral via MIN_N gate in typeEV |
| crypto_daily | sharpe=−1.02, n=4 | row skipped | same |

**No DELETE statements** — rows for types with insufficient evidence are simply not upserted. Their stale `sharpe_ratio` value is preserved but irrelevant because `typeExpectedValue` returns 0.5 when `n_trades < 5`.

## 7. Daily review validation query

To monitor whether the 0.33 haircut is behaving as expected, the daily review's prompt (`scripts/daily-review-prompt.md`) gains a new section:

```sql
-- Compare effective vs realized Sharpe per shadow-sourced type
WITH live_recent AS (
  SELECT m.market_type,
         COUNT(*) AS n_live,
         CASE WHEN STDDEV(p.realized_pnl) > 0
              THEN AVG(p.realized_pnl) / STDDEV(p.realized_pnl)
              ELSE NULL END AS live_sharpe
  FROM paper_positions p JOIN markets m ON p.market_id = m.id
  WHERE p.closed_at > NOW() - INTERVAL '7 days'
    AND p.realized_pnl IS NOT NULL
  GROUP BY m.market_type
),
shadow AS (
  SELECT market_type,
         COUNT(*) AS n_shadow,
         CASE WHEN STDDEV(theoretical_pnl) > 0
              THEN AVG(theoretical_pnl) / STDDEV(theoretical_pnl)
              ELSE NULL END AS shadow_sharpe
  FROM shadow_trades
  WHERE resolved_at IS NOT NULL
  GROUP BY market_type
)
SELECT cp.market_type,
       cp.sharpe_ratio AS effective_sharpe,
       cp.n_trades,
       l.live_sharpe AS live_recent_sharpe_actual,
       l.n_live,
       s.shadow_sharpe AS shadow_sharpe_raw,
       s.n_shadow,
       -- Inferred source by matching n:
       CASE WHEN cp.n_trades = l.n_live THEN 'live'
            WHEN cp.n_trades = s.n_shadow THEN 'shadow'
            ELSE 'unknown' END AS source,
       -- If shadow source AND live has data, compute the implied haircut:
       CASE WHEN cp.n_trades = s.n_shadow AND l.n_live >= 5
            THEN ROUND((l.live_sharpe / NULLIF(s.shadow_sharpe, 0))::numeric, 3)
            ELSE NULL END AS implied_haircut
FROM category_performance cp
LEFT JOIN live_recent l ON l.market_type = cp.market_type
LEFT JOIN shadow s ON s.market_type = cp.market_type
ORDER BY cp.market_type;
```

Daily review interpretation rules (added to prompt):
- For each `source='shadow'` row with `implied_haircut` available, alert if `|implied_haircut − 0.33| > 0.20`.
- After ≥5 shadow-source types accumulate ≥30 live trades each (informally, after 1–2 weeks of shadow-driven promotion), recommend revisiting the haircut value.

## 8. Test plan

### 8.1 Unit tests for `updateCategoryPriors`

Mock `query` to return live/shadow rows, assert the upsert calls match expected source-routing decisions.

```typescript
// Test 1: live ≥ 30 wins over shadow
//   live: n=50, sharpe=0.5
//   shadow: n=400, sharpe=2.0
//   → upsert with sharpe=0.5, n=50

// Test 2: live < 30, shadow ≥ 30 → shadow with haircut
//   live: n=10, sharpe=0.1
//   shadow: n=400, sharpe=2.0
//   → upsert with sharpe=0.66, n=400

// Test 3: live < 30, shadow < 30 → no upsert for that type
//   live: n=5, shadow: n=10
//   → upsert NOT called for that market_type

// Test 4: env override of SHADOW_HAIRCUT
//   process.env.SHADOW_HAIRCUT = '0.5'
//   shadow sharpe 2.0 → upsert sharpe=1.0

// Test 5: env override of CATEGORY_LIVE_RECENT_DAYS
//   passed as parameter to query

// Test 6: no live and no shadow → no upsert at all (no rows in either query)
```

### 8.2 SQL syntax test

The two queries are concrete strings. Test them by mocking `query` and asserting:
- The SQL contains `INTERVAL '1 day' *` parameterised input.
- The shadow query has no time filter beyond `resolved_at IS NOT NULL`.

### 8.3 Integration smoke

The daily review query (§7) runs against a fresh seed of paper_positions + shadow_trades; assert it returns rows with sane `source` inference.

## 9. Files touched

```
packages/data-collector/src/services/MarketPerformanceTracker.ts                [refactor updateCategoryPriors]
packages/data-collector/src/services/MarketPerformanceTracker.test.ts           [+6 tests for routing]
scripts/daily-review-prompt.md                                                   [+haircut validation section]
docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md               [this spec]
```

No schema migration. No new files. No env vars added to docker-compose by default (operator opts in if non-default values needed).

Estimated scope: 1 file refactored + 1 test file extended + 1 prompt updated + 1 doc. ~150 LOC mostly tests.

## 10. Non-goals / Out of scope

- **Per-type haircuts**: a single global haircut is a deliberate simplification. If post-deploy review shows event_short and event_long need different haircuts, a follow-up PR introduces a per-type override map (e.g. `SHADOW_HAIRCUT_EVENT_SHORT`).
- **Shadow execution-realism fix at the source**: applying realistic fees/slippage to `shadow_trades.theoretical_pnl` (option 1 in `project_shadow_execution_realism.md`) remains deferred. The haircut here treats the symptom, not the cause. That work is multi-session.
- **Adaptive haircut**: feedback-loop where the haircut auto-adjusts from observed live/shadow ratios. Mentioned in §7 as "after ≥5 types validate, revisit". Not implemented now.
- **Bootstrapping new types**: types that newly enter shadow-tracked but have <30 shadow_resolved fall back to neutral. They will rise organically as shadow accumulates resolutions. No special-case bootstrap logic.

## 11. Validation post-deploy

Immediate (within ~30 minutes after first 02:45 UTC run after deploy):

```sql
-- Confirm category_performance reflects the new logic
SELECT market_type, sharpe_ratio, n_trades, prior, updated_at::timestamp(0)
FROM category_performance
ORDER BY market_type;
-- Expected: event_short row updated_at recent; sharpe_ratio ≈ 0.67
```

After 24 hours:
- Run the §7 daily review query manually.
- Verify `event_short` is `source=shadow` with `effective_sharpe ≈ 0.67`.
- Verify `MarketScorer` next run produces higher `market_score` for event_short candidates (compare top-50 distribution before/after).

After 1 week:
- `event_short` should have ≥30 live trades (assuming rotation now promotes its candidates).
- Daily review reports `implied_haircut` for `event_short`. If consistently in [0.13, 0.53] (±0.20 of 0.33), haircut OK. Otherwise adjust `SHADOW_HAIRCUT` env var.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Haircut 0.33 too generous → event_short over-promoted, live performs worse than expected | Daily review validation alerts when implied haircut diverges. Operator lowers `SHADOW_HAIRCUT` env var, no redeploy. Worst case: revert via env `SHADOW_HAIRCUT=0` (effectively disable shadow contribution). |
| Haircut 0.33 too conservative → event_short still doesn't enter pool | Operator raises `SHADOW_HAIRCUT` env var. Or lower `MIN_LIVE_RECENT_N` so live data with smaller sample takes over. |
| `event_long` enters pool via shadow | Won't happen: `ALLOWED_MARKET_TYPES` excludes event_long at the executor; the rotator's live lane already filters to allowed types. shadow score change for event_long is harmless. |
| Sample size n_live=16 is too small to defend 0.33 | Acknowledged in spec §1 and `project_shadow_execution_realism.md`. Validation plan in §7 corrects within 1–2 weeks. |
| 7-day window misses recent shadow validation | Operator raises `CATEGORY_LIVE_RECENT_DAYS` to 10 or 14 if observation shows too many types falling to shadow path |

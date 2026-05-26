# SignalEngine market feed — per-`market_type` allocation

**Status:** design approved 2026-05-26
**Author:** brainstorm session 2026-05-26 (daily-review #266 investigation)
**Supersedes:** none

## Problem

`event_short` markets are tracked (18 active, all priced with avg 229 bars/24h) but produce **0 generator predictions in any rolling 24h window**. The EdgeCapacityRefresher correctly skips event_short — no measurable cells. The daily review attributes this to "category depleted by reclassification" (false: 549 active event_short markets exist).

Root cause: the SignalEngine market feed pipeline has **three independent layers, each biased toward high-volume markets**, none of which considers `market_type`. Compounded, they starve low-volume types completely.

### Measured distribution (2026-05-26)

| layer | code | event_long | event_financial | crypto_daily | event_short |
|-------|------|-----------|-----------------|--------------|-------------|
| Tracked (data-collector OK) | `markets.tracking_status='active'` | 37 | 17 | 8 | 18 |
| With recent price data | join `price_history` 24h | 37 | 17 | 8 | 18 |
| **Predictions generated 24h** | `generator_predictions` | **27 markets / 40k preds** | **9 / 16k** | **6 / 10k** | **0 / 0** |

The gap is entirely between the tracked+priced state and the predictions actually generated.

### The biased chain

1. **DB fetch** — `PolymarketService.fetchMarketsFromDb()` (`packages/dashboard/src/services/PolymarketService.ts:471-502`):
   ```sql
   SELECT ... FROM markets m
   WHERE m.is_active = true AND ...
   ORDER BY m.volume_24h DESC NULLS LAST
   LIMIT $4  -- marketsToFetch
   ```
   `event_short` markets have low `volume_24h` (short-duration events accumulate less volume). They lose the top-N ranking before any diversification runs.

2. **Selection** — `selectDiversifiedMarkets()` (`PolymarketService.ts:363-413`):
   - Diversifies by `category` (text field like "crypto"/"politics"), **not** by `market_type`.
   - `byCategory` bucketing does not guarantee any `market_type` representation.
   - Categories cluster across types; a "politics" bucket can be entirely event_long.

3. **Per-cycle slice** — `SignalEngine.computeSignals()` (`packages/dashboard/src/services/SignalEngine.ts:507`):
   ```ts
   const marketsToProcess = this.activeMarkets.slice(0, this.config.maxMarketsPerCycle);
   ```
   No sort, no per-type round-robin. Takes the first N from the array, which preserves whatever bias `setActiveMarkets` inherited.

## Goal

Ensure each `market_type` with active markets in the DB obtains representation in the SignalEngine processing pipeline proportional to its strategic importance (live vs shadow), enabling cost-aware edge measurement and signal generation across all types — not just the high-volume ones.

## Non-goals

- Tuning the per-type budgets via Optuna or any adaptive scheme (deferred Phase 6+).
- Moving from polling architecture to event/streaming feed.
- Raising the total `MAX_SIGNAL_MARKETS` cap as part of this work — measure the diversifier's impact first, raise later if justified.
- Changing how `MarketRotator` (data-collector side, L1 of the original framing) selects markets. The L1 distribution is currently fine for our purposes; the bug is downstream.

## Architecture

Three coordinated fixes, one per biased layer. Each is independently testable and ships behind the same per-type budget configuration.

### L1 — DB fetch: per-type sub-query union

Replace the single `ORDER BY volume_24h DESC LIMIT N` with a union of per-type sub-queries, each with its own `LIMIT`.

Pseudocode shape:
```sql
(SELECT ... WHERE market_type = 'crypto_intraday' AND <existing filters>
 ORDER BY volume_24h DESC LIMIT $cypher_intraday_budget)
UNION ALL
(SELECT ... WHERE market_type = 'crypto_daily' AND <existing filters>
 ORDER BY volume_24h DESC LIMIT $crypto_daily_budget)
UNION ALL
(... event_financial, event_short, event_long ...)
UNION ALL
-- Force-included markets bypass per-type budgets (preserve existing semantics)
(SELECT ... WHERE id = ANY($force_ids::varchar[]) AND <minimal filters>)
```

- Each sub-query keeps existing filters: `is_active`, `is_resolved=false`, `tracking_status != 'cold'`, price range, recent price history existence.
- Budget map: `SIGNAL_FETCH_BUDGET_PER_TYPE`.
- Force-included markets are still appended outside the per-type budgets (preserves the RPv2 cohort pin behaviour).
- Total candidate pool size ≈ `sum(budgets) + |force_ids|`.

**Why per-type rather than a fatter top-N + diversifier**: even fetching top 500 by volume, event_short can still fail to surface if its top-volume entries fall below crypto_intraday's tail. Per-type sub-queries are a structural guarantee, not a probabilistic one.

### L2 — Selection: `selectDiversifiedMarkets` with `byMarketType` primary axis

Refactor `selectDiversifiedMarkets()` to use `market_type` as the **primary** diversification axis, with `category` as a secondary axis within each type.

```
allMarkets
  ↓
group by market_type
  ↓
for each type:
  take min(SIGNAL_SLOTS_PER_TYPE[type], available)
  within the take, apply existing byCategory diversification as tie-breaker
  ↓
concat selected per type + force-included
  ↓
return up to MAX_SIGNAL_MARKETS
```

- Slot budget map: `SIGNAL_SLOTS_PER_TYPE`.
- Underfill redistribution: if a type has fewer candidates than its budget, the leftover slots go to types with surplus candidates in this priority order:
  1. Types in `ALLOWED_MARKET_TYPES` (live-traded) get leftover first, split proportionally to their original budget.
  2. Remaining leftover (if any) goes to non-allowed (shadow-only) types proportionally.
  3. Final cap remains `MAX_SIGNAL_MARKETS` — never exceed it.
- Force-included markets are pinned at the top and count **outside** the per-type budget.
- Existing `rankMarketsByVolumeScoreBlend` is preserved as the within-type ranker — only the bucketing axis changes.

### L3 — Cycle slice: round-robin per type within `maxMarketsPerCycle`

Replace `this.activeMarkets.slice(0, N)` with a round-robin pull:

```ts
const buckets = groupBy(this.activeMarkets, m => m.marketType);
const result: ActiveMarket[] = [];
while (result.length < N && hasAnyNonEmpty(buckets)) {
  for (const type of Object.keys(buckets)) {
    if (buckets[type].length === 0) continue;
    result.push(buckets[type].shift());
    if (result.length >= N) break;
  }
}
```

- Guarantees even per-cycle distribution even if `setActiveMarkets` somehow receives a biased list.
- Stateless across cycles: each cycle reads `this.activeMarkets` fresh and applies the round-robin from scratch — no need to track which markets were processed last cycle. (The round-robin always starts from the same iteration order over `Object.keys(buckets)` — Map insertion order is deterministic given the same input list, so the same type wins ties consistently. If per-cycle ordering fairness matters in future, add a rotating start offset.)
- If `maxMarketsPerCycle >= activeMarkets.length`, processes all (no change from current behaviour for small lists).

## Configuration

Two env vars introduced. Both parsed by a shared util `parsePerTypeBudget(envValue: string): Map<string, number>`.

```bash
# Per-type LIMIT in the candidate fetch sub-queries (L1)
SIGNAL_FETCH_BUDGET_PER_TYPE="crypto_intraday:30,crypto_daily:30,event_financial:40,event_short:40,event_long:60"

# Per-type slot allocation in selectDiversifiedMarkets (L2)
SIGNAL_SLOTS_PER_TYPE="crypto_intraday:8,crypto_daily:8,event_financial:12,event_short:12,event_long:10"

# Existing — kept; total cap. Sum of SIGNAL_SLOTS_PER_TYPE should equal this.
MAX_SIGNAL_MARKETS=50
MAX_TRACKED_MARKETS=50  # PolymarketService cap for the diversified pool
```

Defaults reflect:
- ALLOWED_MARKET_TYPES (live: crypto_intraday + crypto_daily + event_financial + event_short) get the larger slot budgets.
- event_long is shadow-only but kept at 10 slots to maintain FLB measurement (project_flb_strategy_design.md).
- Fetch budget is ≥3× slot budget per type — gives the diversifier choice within each type.

### Backward-compatibility default

If both env vars are unset, the code falls back to current behaviour (single ORDER BY volume DESC + byCategory diversification). This lets the PR land without compose changes, then enabling happens via a separate compose update with monitoring.

### Validation rules

At PolymarketService initialization:
- Parse both env vars; on malformed input, log error and use fallback (current behaviour).
- `sum(SIGNAL_SLOTS_PER_TYPE) > MAX_SIGNAL_MARKETS`: log warn, cap each entry proportionally so sum equals the cap.
- `sum(SIGNAL_FETCH_BUDGET_PER_TYPE) < sum(SIGNAL_SLOTS_PER_TYPE)`: log warn (diversifier will not have enough candidates per type).
- Types in budget maps that don't appear in markets table: silently ignored (no warning — supports future market type additions).
- Types in markets table not in budget maps: get 0 slots (intentional — explicit opt-in).

## Components affected

| Path | Change |
|------|--------|
| `packages/dashboard/src/services/PolymarketService.ts` | Refactor `fetchMarketsFromDb` to use per-type sub-queries. Refactor `selectDiversifiedMarkets` to bucket by `market_type` first. |
| `packages/dashboard/src/services/SignalEngine.ts` | Replace `computeSignals` slice with round-robin per-type pull. |
| `packages/dashboard/src/services/PolymarketService.ts` (new export) | `parsePerTypeBudget(raw: string \| undefined): Map<string, number>` — sibling of existing `parseAllowedMarketTypes`. |
| `packages/dashboard/src/services/PolymarketService.test.ts` | Unit tests for `parsePerTypeBudget` and the new `selectDiversifiedMarkets` per-type bucketing. |
| `packages/dashboard/src/services/SignalEngine.test.ts` | Unit test for the round-robin slice with biased input distribution. |
| `docker-compose.gcp.yml` | Add `SIGNAL_FETCH_BUDGET_PER_TYPE` and `SIGNAL_SLOTS_PER_TYPE` env vars to dashboard-api service. Update `MAX_TRACKED_MARKETS`/`MAX_SIGNAL_MARKETS` to match the slot sum if changing them. |

## Tests

### Unit

1. **`parsePerTypeBudget`** — empty/undefined → empty Map; `"a:1,b:2"` → `{a→1, b→2}`; malformed entries dropped silently with warn; non-numeric values dropped.
2. **L1 fetch SQL builder** — given a budget map, produces a UNION ALL with one branch per type, each with the right LIMIT. Force-include branch always present when force IDs set.
3. **L2 `selectDiversifiedMarkets`** — given candidates with biased type distribution (e.g., 50 event_long, 5 event_short), respects per-type slots and does not over-allocate to event_long. Underfill from event_short redistributes to surplus types.
4. **L3 `computeSignals` slice** — given `activeMarkets` with 30 event_long, 10 event_short, `maxMarketsPerCycle=20`, the processed batch contains close-to-proportional types (not 20 event_long).
5. **Backward compat** — both env vars unset → behaves identically to current code path (covered by existing tests passing unchanged).

### Integration

6. End-to-end with a DB fixture (test database): seed markets across 4 types with skewed volumes, configure budgets, run one full cycle, assert predictions are produced for all 4 types in proportions matching slot budgets.

### Manual verification on VM after deploy

7. After enabling env vars in compose: query `generator_predictions` grouped by `market_type` over 24h, verify ratios match `SIGNAL_SLOTS_PER_TYPE` ratios (±20% tolerance — sample noise).
8. `market_type_edge_capacity.updated_at` for event_short advances within 48h of deploy (currently stuck at 2026-05-17).
9. dashboard-api memory and CPU within limits (no regression from the per-cycle round-robin work).

## Rollout

1. PR lands with backward-compat default (env vars unset → no behavioural change).
2. Compose update sets env vars to the defaults above, in a separate change.
3. Monitor 48h:
   - `predictions_per_type_per_day` ratios match slot ratios (±20%)
   - dashboard-api memory steady < 100 MiB
   - `market_type_edge_capacity` for all types updates daily
4. If ratios off-target, adjust env vars (no code change needed).
5. If signal compute time per cycle exceeds the interval (60s), consider raising `MAX_SIGNAL_MARKETS` or lowering `SIGNAL_INTERVAL_MS` impact — handled as separate decision once measured.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Diversifier reduces overall signal quality by including lower-volume markets | Edge measurement is the goal here, not maximum aggregate signal. Validate via `generator_edge.t_net` per type post-deploy — if a type's t_net stays at ~0, we have measurement (the goal); if it goes negative we have noise (informative). |
| event_long signal compute drops from 27 → 10 markets/cycle; FLB measurement slows | FLB strategy is hold-to-resolution: a 10-market sample is still sufficient for the +36 t-stat we already measured. If FLB t-stat degrades, raise event_long budget. |
| Per-type sub-query union increases DB query time | Each sub-query hits indexed `(market_type, volume_24h DESC)` (verify index exists; add if not). Per-type union should be O(types × log n) — same complexity as current global sort. |
| Force-include cohort double-counted (per-type budget + pinned) | Spec is explicit: force-included markets count outside per-type budgets, test #2 covers this. |
| Type listed in `SIGNAL_SLOTS_PER_TYPE` with no active markets — slot wasted | L2 underfill redistribution covers this; spec is explicit. |

## Open questions

None — design is concrete. Implementation specifics (e.g., exact signature of `parsePerTypeBudget`) belong in the implementation plan.

## See also

- `project_session_2026-05-26_roadmap.md` — master roadmap including this brainstorm output
- `feedback_no_diversity_quota.md` — historical principle against per-type quotas in MarketRotator. **This design is consistent with that feedback**: that principle was about *trading* selection (don't trade diverse types just for diversity's sake); this spec is about *measurement* coverage (ensure each type produces enough predictions for cost-aware edge to be measurable). Different concern, different layer.
- `project_event_short_supply.md` — earlier framing that conflated the supply-vs-bug question; this spec settles that question (it was always a feed bug, not a supply problem).
- `2026-05-19-market-panel-recorder-design.md` — sibling pipeline (market panel snapshots) that also feeds from the markets table; budgets here may inform a future panel-side allocation if symmetric coverage matters.

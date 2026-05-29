# Resolution detection driven from our market universe

**Date:** 2026-05-29
**Status:** Design approved, pending implementation plan
**Origin:** Daily-autoreview analysis of Watchdog #280. Shadow PnL is uncomputable for the live-tradeable market types; root-caused to a starved resolution-detection job.

## Problem

`shadow_trades` are recorded for all live-tradeable types (crypto_daily 3963, event_financial 15909, event_short 5830 over 30d) but **0 of them resolve**. The shadow resolver (`MarketPerformanceTracker.resolveShadowTrades`) is type-agnostic — it gates only on `markets.is_resolved = true`. The gap is upstream, in resolution **detection**.

`GammaCollector.syncResolvedMarketsToDb` (Scheduler job `sync-resolved-markets`, hourly at :33) scans Polymarket's global `closed=true` feed **newest-first**, capped at `MAX_SYNC_PAGES=10` → **1000 markets/run**. Polymarket resolves far more than that per hour — the 5-minute BTC/ETH/SOL/XRP "Up or Down" firehose alone is thousands/day. The page budget is consumed by markets we never tracked (the `UPDATE ... WHERE id = $3` no-ops on them), so our slower-resolving markets fall outside the window and never get `is_resolved = true`.

**Evidence** (markets past `end_date` but still `is_resolved = false`, 2026-05-29):

| market_type | past_end | resolved | past_end_unresolved |
|---|---|---|---|
| crypto_daily | 1219 | 33 | 1188 (97%) |
| crypto_intraday | 12998 | 5 | 12993 |
| event_financial | 727 | 136 | 632 (87%) |
| event_long | 18052 | 5218 | 13520 (75%) |
| event_short | 47492 | 4198 | 43305 (91%) |

Systemic, not type-specific. `event_long` only shows resolved shadow trades because its base is huge (5218 resolved in absolute terms), not because it is treated differently.

**Consequences:** shadow PnL is unusable for promotion decisions on the tradeable types; the edge-research program (the 3 vías + the `market_panel` recorder, which is 314/323 `event_long` for the same reason) is starved of resolved `(features, outcome)` observations.

This is the same structural family as PR #271 (per-type SignalEngine allocation) and the `crypto_intraday` ingestion gap: the data-collector relies on capped global Polymarket feed slices instead of driving from our own market universe.

## Goal

Invert the pattern: **resolution starts from our universe, not from the firehose.** Resolve every ended-but-unresolved market we hold, by querying Gamma for those specific market ids, draining the backlog over time under a per-run budget.

### In scope
1. A targeted resolution job that selects our unresolved-ended markets and fetches their outcomes from Gamma by id.
2. Remove `crypto_intraday` from `ALLOWED_MARKET_TYPES` (untradeable 5-minute supply; cleanup).

### Out of scope
- Restoring ingestion of the 5-minute crypto markets.
- An attempts-counter / permanent give-up for markets Gamma can never resolve (throttle alone suffices; revisit if the irresoluble backlog grows).
- Changes to `syncMarketsToDb` / `syncEventsToDb` (they keep `MAX_SYNC_PAGES`; not touched here).

## Feasibility (verified 2026-05-29)

- `markets.id` equals Gamma's `market.id` (GammaCollector insert uses `market.id`).
- `GET /markets/{id}` returns `closed`, `outcomePrices`, `closedTime` for a real ended market (`1651554` → `closed=true`, `outcomePrices=["0","1"]`, `closedTime=2026-05-12`).
- `GET /markets?id=<id>&closed=true` returns the row; the `closed=true` filter automatically excludes not-yet-closed markets (so absent-from-response = "not closed yet", which we throttle and retry).
- **Plan-time verification:** confirm a multi-id query `?id=A&id=B&closed=true` returns multiple rows in one response (single-id and the param syntax are confirmed; batch cardinality is not).

## Architecture

New method on `GammaCollector`, replacing the global-scan body of `syncResolvedMarketsToDb`:

```
resolveOurMarkets(budget, batchSize):
  1. SELECT id FROM markets
       WHERE end_date < NOW()
         AND NOT COALESCE(is_resolved, false)
         AND (last_resolution_check IS NULL
              OR last_resolution_check < NOW() - INTERVAL '<RESOLUTION_RECHECK_HOURS> hours')
       ORDER BY <priority>          -- see below
       LIMIT budget
  2. for each chunk of batchSize ids:
       rateLimiter.acquire('gamma_markets')
       rows = GET /markets?id=...&closed=true       -- only already-closed come back
       for each returned row:
         outcome = parseResolutionOutcome(row.outcomePrices)   -- 'yes' | 'no' | null
         if outcome is null: bump last_resolution_check; continue   -- invalid / 50-50
         UPDATE markets SET is_resolved=true, resolution_outcome=outcome,
                resolved_at=<closedTime || NOW()>, is_active=false, updated_at=NOW()
           WHERE id = $id AND COALESCE(is_resolved,false) = false   -- idempotent
       for each requested id NOT in the response (still open):
         UPDATE markets SET last_resolution_check = NOW() WHERE id = $id
  3. resolveShadowTrades() runs after, unchanged (already type-agnostic)
```

**Priority ordering** (best value first, since the budget is finite):
1. Markets with a downstream consumer — an unresolved row in `shadow_trades` or `market_panel`.
2. Then live-tradeable types (`crypto_daily`, `event_financial`, `event_short`).
3. Then by `end_date` descending (most recently ended first).

Expressed as an `ORDER BY` over boolean/`EXISTS` flags; refined for query cost during planning (a materialised flag or a join may be cheaper than correlated `EXISTS` on `shadow_trades`).

### Schema change

Add `markets.last_resolution_check TIMESTAMPTZ` (nullable). Idempotent migration (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) plus a startup `CREATE/ALTER IF NOT EXISTS` guard, because the init SQL only runs on first volume init (per the data-collector migration gotcha). Purpose: markets Gamma never returns as closed (delisted, or genuinely still open past our `end_date` estimate) are rechecked on a throttle (`RESOLUTION_RECHECK_HOURS`, default e.g. 24h) instead of consuming the per-run budget every hour.

### Scheduler & config

`sync-resolved-markets` (hourly :33) calls `resolveOurMarkets`. Env-tunable with e2-micro-safe defaults:
- `RESOLUTION_BUDGET_PER_RUN` — max markets selected per run (e.g. 500).
- `RESOLUTION_BATCH_SIZE` — ids per Gamma request (e.g. 20, pending batch-cardinality verification).
- `RESOLUTION_RECHECK_HOURS` — throttle for absent/unresolvable markets (e.g. 24).

The global newest-first pagination loop and the resolution use of `MAX_SYNC_PAGES` are removed.

### Backlog drain

The ~71k current unresolved-ended markets drain across many cron cycles under the budget, consumed-first. This is expected and noted; the daily review's coverage/freshness checks will show the resolved counts climbing.

## crypto_intraday removal

`crypto_intraday` is the only live type whose supply is the 5-minute "Up or Down" product — untradeable for our 60s-signal / 4h-hold / ~1% round-trip-cost pipeline (acting with 1–5 min latency on a 5-minute, ~50/50 market needs HFT-grade microstructure edge we don't have), and there is no observed tradeable 1–4h crypto product distinct from that churn. crypto_daily already covers crypto ≤7d. Remove it:

- `docker-compose.gcp.yml` — drop `crypto_intraday` from `ALLOWED_MARKET_TYPES` (both occurrences: data-collector and dashboard, lines 78 and 320).
- `scripts/coverage-alerts.js` — drop it from `DEFAULT_ALLOWED_MARKET_TYPES`.
- `scripts/daily-review.sh` — drop it from the `allowed_market_types` fallback literal.
- `EXECUTOR_BLOCKED_TYPE_DIRECTIONS` `crypto_intraday:long` entry becomes redundant; leave it (harmless, minimises churn) or drop it — implementer's call, noted.
- Re-add caveat: if the edge-research calibration study later finds the short-crypto band is exploitable hold-to-resolution, revisit.

## Testing

Vitest (`packages/data-collector/src/collectors/*.test.ts`); extract pure logic.

1. **`parseResolutionOutcome(outcomePrices)` → `'yes'|'no'|null`** (currently inline). `["1","0"]`→yes, `["0","1"]`→no, `["0.5","0.5"]`→null, `["0.99",…]`→yes, `["0.01",…]`→no, malformed/`[]`/non-JSON→null.
2. **Target-set SQL** — assert the query string contains `end_date < NOW()`, the `NOT ... is_resolved` guard, the `last_resolution_check` throttle, the priority `ORDER BY`, and `LIMIT budget` (pattern: `MarketRotator.test.ts`).
3. **`resolveOurMarkets` integration** (mock Gamma client + `query`):
   - Gamma returns a subset of requested ids as closed → resolution UPDATE for those with correct outcome and `resolved_at`.
   - Requested ids absent from the response → `last_resolution_check` bump only, no resolution UPDATE.
   - Resolution UPDATE carries `WHERE ... is_resolved=false` (idempotent).
   - Budget/batch respected: N ids, batch K → `ceil(N/K)` Gamma calls; never more than `budget` markets/run.

## Error handling

- **Network/HTTP failure on a batch** — catch, log, continue to the next batch (don't abort the run). **No** `last_resolution_check` bump (transient → retry next run).
- **Batch succeeded but ids absent** (market not yet closed) — bump `last_resolution_check`. Key distinction: throttle only on a successful response, never on a failed request.
- **Invalid / 50-50 resolution** (`["0.5","0.5"]` or partial) — do not mark resolved (`resolution_outcome` stays null); bump `last_resolution_check` so it isn't re-queried hourly.
- **Per-market UPDATE failure** — catch, log, continue (existing pattern).
- **Delisted / permanently-absent markets** — perpetually "absent" → throttled every `RESOLUTION_RECHECK_HOURS`; they recycle but never resolve. Low cost with the throttle; no attempts-counter (YAGNI), noted as a future tweak if the irresoluble backlog grows.
- **Malformed `closedTime`** — fall back to `NOW()` (existing pattern).
- **Rate limiting & runtime** — `rateLimiter.acquire('gamma_markets')` per batch; runtime bounded by `budget` and the Scheduler's existing `withTimeout` wrapper.

## Files touched

- `packages/data-collector/src/collectors/GammaCollector.ts` — new `resolveOurMarkets`, extracted `parseResolutionOutcome`, removal of the resolution global-scan loop.
- `packages/data-collector/src/services/Scheduler.ts` — `sync-resolved-markets` wiring + new env vars.
- `packages/data-collector/src/database/init/*.sql` — `last_resolution_check` column + startup guard.
- `packages/data-collector/src/collectors/GammaCollector.*.test.ts` — new tests.
- `docker-compose.gcp.yml`, `scripts/coverage-alerts.js`, `scripts/daily-review.sh` — `crypto_intraday` removal from the allowlist.

## See also

- `project_2026-05-29_watchdog_280.md` (memory) — the diagnosis.
- PR #271 — sibling per-type-allocation fix (same structural family).
- `project_edge_research_3vias.md`, `project_flb_strategy_design.md` — the consumers this unblocks.

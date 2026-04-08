# Cold Market Filter + Optimizer Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop catastrophic losses from stale-price markets, connect the Optuna optimizer so the system can learn optimal signal weights and direction multiplier.

**Architecture:** Four independent fixes: (1) filter cold markets at DB query level, (2) expand Optuna parameter space with directionMultiplier and missing weights, (3) configure Neon + Render + VM env vars to reconnect optimizer, (4) merge PR #84 as defense-in-depth. Fixes 1-2 are code changes deployed via CI/CD. Fix 3 is infra config. Fix 4 is a PR merge.

**Tech Stack:** TypeScript (dashboard), Python (optimizer server), PostgreSQL (TimescaleDB + Neon), Docker, GCP, Render

**Spec:** `docs/plans/2026-04-08-optimizer-reconnect-cold-filter-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/dashboard/src/services/PolymarketService.ts:438` | Add `tracking_status != 'cold'` to market discovery query |
| Modify | `packages/dashboard/src/services/SignalEngine.ts:76,290` | Add `trackingStatus` to `ActiveMarket`, filter in `setActiveMarkets` |
| Modify | `packages/dashboard/src/services/OptimizationScheduler.ts:38-55` | Expand `OPTUNA_PARAM_SPACE` with 5 new params, fix momentum range |
| Modify | `docker-compose.gcp.yml:121` | Add `OPTIMIZER_URL` env var |
| Modify | `packages/dashboard/src/services/SignalEngine.filter.test.ts` | Add cold market filter test |

---

### Task 1: Merge PR #84 (Large-Loss Cooldown)

**Files:** None — PR already exists with CI green.

- [ ] **Step 1: Verify PR status**

Run: `gh pr view 84 --json state,statusCheckRollup`
Expected: `state: OPEN`, all checks passed

- [ ] **Step 2: Merge PR**

```bash
gh pr merge 84 --merge --body "Defense in depth: 4h cooldown on any close with realized loss >= $25, not just stop_loss. Prevents re-entry loops like Iran market (-$472)."
```

- [ ] **Step 3: Verify merge**

Run: `git pull origin main`
Expected: PR #84 commit appears in log

---

### Task 2: Cold Market Filter — Test

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.filter.test.ts`

- [ ] **Step 1: Write failing test for cold market filter**

Add to `SignalEngine.filter.test.ts` — the test file uses a standalone `filterMarkets` function that mirrors `setActiveMarkets` logic. Add `trackingStatus` to the function signature and test:

```typescript
function filterMarketsWithTracking(markets: Array<{ currentPrice: number; isActive?: boolean; isResolved?: boolean; trackingStatus?: string }>) {
  const MIN_PRICE = 0.05;
  const MAX_PRICE = 0.95;

  return markets.filter(m => {
    if (m.isActive === false) return false;
    if (m.isResolved === true) return false;
    if (m.trackingStatus === 'cold') return false;
    const price = m.currentPrice;
    if (price < MIN_PRICE || price > MAX_PRICE) return false;
    return true;
  });
}

describe('cold market filter', () => {
  it('should filter out cold markets', () => {
    const markets = [
      { currentPrice: 0.50, isActive: true, trackingStatus: 'cold' },
      { currentPrice: 0.30, isActive: true, trackingStatus: 'active' },
    ];
    const filtered = filterMarketsWithTracking(markets);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].currentPrice).toBe(0.30);
  });

  it('should keep markets without trackingStatus (backwards compat)', () => {
    const markets = [
      { currentPrice: 0.30, isActive: true },
    ];
    expect(filterMarketsWithTracking(markets)).toHaveLength(1);
  });

  it('should keep active and hot markets', () => {
    const markets = [
      { currentPrice: 0.30, isActive: true, trackingStatus: 'active' },
      { currentPrice: 0.60, isActive: true, trackingStatus: 'hot' },
    ];
    expect(filterMarketsWithTracking(markets)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/SignalEngine.filter.test.ts`
Expected: All tests pass (the test uses its own standalone function, so it's self-contained)

- [ ] **Step 3: Commit test**

```bash
git add packages/dashboard/src/services/SignalEngine.filter.test.ts
git commit -m "test: add cold market filter tests"
```

---

### Task 3: Cold Market Filter — Implementation

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts:76-87` (interface)
- Modify: `packages/dashboard/src/services/SignalEngine.ts:285-314` (filter)
- Modify: `packages/dashboard/src/services/PolymarketService.ts:430-452` (DB query)
- Modify: `packages/dashboard/src/services/PolymarketService.ts:463-478` (mapping)

- [ ] **Step 1: Add `trackingStatus` to `ActiveMarket` interface**

In `packages/dashboard/src/services/SignalEngine.ts`, add field after `endDate`:

```typescript
interface ActiveMarket {
  id: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo?: string;
  currentPrice: number;
  volume24h?: number;
  isActive?: boolean;    // Market is still active for trading
  isResolved?: boolean;  // Market has been resolved
  marketType?: string;   // crypto_intraday, crypto_daily, event_short, event_long
  endDate?: Date | null; // Market resolution date for duration-based weight scaling
  trackingStatus?: string; // active, hot, cold — cold markets have stale prices
}
```

- [ ] **Step 2: Add cold filter in `setActiveMarkets`**

In `packages/dashboard/src/services/SignalEngine.ts`, add counter at line 288 and filter after resolved check (line 301):

```typescript
    let inactiveCount = 0;
    let resolvedCount = 0;
    let coldCount = 0;
    let extremePriceCount = 0;
    let fiftyFiftyCount = 0;

    const filtered = markets.filter(m => {
      // Filter 1: Skip inactive markets
      if (m.isActive === false) {
        inactiveCount++;
        return false;
      }

      // Filter 2: Skip resolved markets
      if (m.isResolved === true) {
        resolvedCount++;
        return false;
      }

      // Filter 3: Skip cold markets (stale price data)
      if (m.trackingStatus === 'cold') {
        coldCount++;
        return false;
      }

      // Filter 4: Skip extreme prices (no profitable trade opportunity)
      const price = m.currentPrice;
      if (price < MIN_PRICE || price > MAX_PRICE) {
        extremePriceCount++;
        return false;
      }
```

Update the log line to include cold count:

```typescript
    const totalExcluded = inactiveCount + resolvedCount + coldCount + extremePriceCount + fiftyFiftyCount;
    if (totalExcluded > 0) {
      console.log(`[SignalEngine] Filtered markets: ${inactiveCount} inactive, ${resolvedCount} resolved, ${coldCount} cold, ${extremePriceCount} extreme prices, ${fiftyFiftyCount} near-50/50`);
    }
```

- [ ] **Step 3: Add `tracking_status` to DB query and mapping in PolymarketService**

In `packages/dashboard/src/services/PolymarketService.ts`, add `tracking_status` to the query type (after line 429):

```typescript
      const marketsResult = await query<{
        id: string;
        condition_id: string;
        question: string;
        category: string;
        clob_token_id_yes: string;
        clob_token_id_no: string;
        current_price_yes: string;
        current_price_no: string;
        volume_24h: string;
        liquidity: string;
        end_date: Date;
        is_active: boolean;
        market_type: string | null;
        tracking_status: string | null;
      }>(`
```

Add `m.tracking_status` to SELECT (line 436, after `m.market_type`):

```sql
          m.market_type,
          m.tracking_status
```

Add `AND m.tracking_status != 'cold'` to WHERE (after line 439):

```sql
        WHERE m.is_active = true
          AND m.is_resolved = false
          AND COALESCE(m.tracking_status, 'active') != 'cold'
```

Add `trackingStatus` to the market mapping (after line 477):

```typescript
          marketType: m.market_type || undefined,
          trackingStatus: m.tracking_status || undefined,
```

- [ ] **Step 4: Add `trackingStatus` to `updateSignalEngineMarkets` mapping**

In `packages/dashboard/src/services/PolymarketService.ts` line 678 mapping, add after `endDate`:

```typescript
        .map(m => ({
          id: m.id,
          question: m.question,
          tokenIdYes: m.tokenIds[0],
          tokenIdNo: m.tokenIds[1],
          currentPrice: m.outcomePrices[0],
          volume24h: m.volume,
          isActive: m.isActive,
          isResolved: false,
          marketType: m.marketType,
          endDate: m.endDate ?? null,
          trackingStatus: m.trackingStatus,
        }));
```

Note: `PolymarketMarket` interface (line 50) needs `trackingStatus?: string` added after `marketType`:

```typescript
  marketType?: string;
  trackingStatus?: string;
```

- [ ] **Step 5: Run all tests**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass (527+)

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/PolymarketService.ts
git commit -m "fix: filter cold markets from signal generation

Cold markets retain stale current_price_yes (e.g., 0.50 when actual
is 0.003), bypassing price filters and causing catastrophic losses.
Filter at both DB query level and SignalEngine setActiveMarkets."
```

---

### Task 4: Expand OPTUNA_PARAM_SPACE

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts:38-55`

- [ ] **Step 1: Add missing parameters and fix momentum range**

Replace `OPTUNA_PARAM_SPACE` in `packages/dashboard/src/services/OptimizationScheduler.ts` (lines 38-55):

```typescript
const OPTUNA_PARAM_SPACE: ParameterDef[] = [
  // Direction multiplier — most critical parameter
  { name: 'combiner.directionMultiplier', type: 'float', low: -1.5, high: 1.5 },
  // Combiner thresholds
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.onlyDirection', type: 'categorical', choices: [null, 'LONG', 'SHORT'] },
  // Signal weights — all active generators
  { name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },
  // Risk
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.maxPositions', type: 'int', low: 5, high: 15 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'risk.takeProfitPct', type: 'float', low: 15.0, high: 80.0 },
  // Signal-specific parameters
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  { name: 'meanReversion.bollingerPeriod', type: 'int', low: 15, high: 30 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];
```

Changes from current:
- Added `combiner.directionMultiplier` [-1.5, 1.5]
- Added `combiner.ofiWeight` [0.0, 2.0]
- Added `combiner.mlofiWeight` [0.0, 2.0]
- Added `combiner.hawkesWeight` [0.0, 2.0]
- Changed `combiner.momentumWeight` from [0.2, 1.5] to [-1.5, 1.5]
- Changed `combiner.meanReversionWeight` from [0.2, 1.5] to [0.0, 2.0]

- [ ] **Step 2: Run tests**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass. OPTUNA_PARAM_SPACE is a data constant — no runtime behavior changes until optimizer connects.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat: expand Optuna parameter space with directionMultiplier and signal weights

Add combiner.directionMultiplier [-1.5, 1.5] so the optimizer can
discover the optimal flip value. Add OFI/MLOFI/Hawkes weights.
Fix momentumWeight to allow negative (contrarian) values."
```

---

### Task 5: Configure Infrastructure

**Files:**
- Modify: `docker-compose.gcp.yml:121`

**Prerequisites:** User must create Neon DB and set Render env var manually before this task.

- [ ] **Step 1: User creates Neon database**

Manual step — user creates database in Neon console:
- Region: `aws-us-east-1`
- Note the connection string: `postgresql://user:pass@host/dbname?sslmode=require`

- [ ] **Step 2: User sets Render optimizer DATABASE_URL**

Manual step — in Render dashboard for `polymarket-optimizer-server`:
- Add env var `DATABASE_URL` = Neon connection string from step 1

- [ ] **Step 3: Add OPTIMIZER_URL to docker-compose.gcp.yml**

Replace the comment block at line 121-122:

```yaml
      # OPTIMIZER_URL removed: Render service can't reach TimescaleDB (localhost-only port).
      # Without it, OptimizationScheduler falls back to local grid search.
```

With:

```yaml
      OPTIMIZER_URL: "https://polymarket-optimizer-server.onrender.com"
```

- [ ] **Step 4: Run tests locally**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass. The env var only affects runtime, not tests.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "feat: reconnect Optuna optimizer via Render + Neon

Set OPTIMIZER_URL so OptimizationScheduler uses OptunaClient (16 params)
instead of grid search fallback (2 params). Optimizer stores trial
history in Neon PostgreSQL, not the trading DB."
```

---

### Task 6: Deploy and Verify

- [ ] **Step 1: Push all changes**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

- [ ] **Step 2: Wait for CI/CD to build and deploy**

Run: `gh run list --limit 3`
Wait for the workflow to complete successfully.

- [ ] **Step 3: Deploy to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

Wait ~30s, then verify:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml ps"
```

Expected: All 3 containers healthy.

- [ ] **Step 4: Verify cold filter active**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --tail=50 dashboard-api 2>&1 | grep -i 'cold\|Filtered markets'"
```

Expected: Log lines showing `X cold` in the filtered markets summary.

- [ ] **Step 5: Verify optimizer connected**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --tail=50 dashboard-api 2>&1 | grep -i 'optuna\|optimizer'"
```

Expected: `[OptimizationScheduler] Optuna mode enabled: https://polymarket-optimizer-server.onrender.com`

- [ ] **Step 6: Close firewall**

```bash
gcloud compute firewall-rules delete allow-postgres-render --quiet
```

- [ ] **Step 7: Verify firewall deleted**

```bash
gcloud compute firewall-rules list --filter="name~postgres"
```

Expected: No results.

---

### Task 7: Post-Deploy Validation (6h later)

- [ ] **Step 1: Check optimizer ran**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT status, best_score, parameter_space::text LIKE '\''%directionMultiplier%'\'' as has_dm FROM optimization_runs ORDER BY created_at DESC LIMIT 3;'"
```

Expected: Most recent run shows `has_dm = true` and status `completed`.

- [ ] **Step 2: Check no cold market trades**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT count(*) FROM paper_positions p JOIN markets m ON p.market_id = m.id WHERE p.opened_at > NOW() - INTERVAL '\''6 hours'\'' AND m.tracking_status = '\''cold'\'';'"
```

Expected: count = 0

- [ ] **Step 3: Check direction multiplier updated**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT signal_type, weight, updated_at FROM signal_weights WHERE signal_type = '\''direction_multiplier'\'';'"
```

Expected: `weight` differs from -1.0000 (optimizer found a different value).

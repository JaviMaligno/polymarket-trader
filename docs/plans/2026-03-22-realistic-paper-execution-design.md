# Realistic Paper Trading Execution — Design

## Problem

Paper trading currently executes at `signal.price` with 0% slippage, 100% fill, and no order book consideration. This makes paper PnL unreliable for deciding when to move to real money. Key gaps:

- No spread: buys at mid-price instead of ask, sells at mid instead of bid
- No market impact: large orders don't walk the book
- No partial fills: always assumes full execution
- No liquidity check: trades on illiquid markets succeed instantly

## Solution

Add `OrderBookExecutionSimulator` that sits between signal generation and trade recording. Uses real order book data when available, falls back to a calibrated proportional model.

## Architecture

```
Signal Engine → AutoSignalExecutor
                  → OrderBookExecutionSimulator
                    → Query orderbook_snapshots (< 60s)
                      → YES: walk-the-book on real asks/bids
                      → NO:  proportional model with penalty floor
                    → Return SimulationResult
                  → Record trade with real execution data
                  → Create/close position at simulated price
```

### New Component

**`OrderBookExecutionSimulator`** (`packages/dashboard/src/services/OrderBookExecutionSimulator.ts`)

```typescript
interface SimulationConfig {
  maxSnapshotAgeMs: number;        // 60000 (60s)
  estimatedSlippageFloor: number;  // 0.01 (1%) — conservative start
  estimatedBaseRate: number;       // 0.002 (0.2%) — calibrated later
  estimatedVolumeFactor: number;   // 0.10 — calibrated later
  feeRate: number;                 // 0.001 (0.1%)
  maxSlippagePct: number;          // 0.05 (5%) — reject above this
}

interface SimulationResult {
  executed: boolean;
  executedPrice: number;
  executedSize: number;
  slippagePct: number;
  fee: number;
  fillSource: 'orderbook' | 'estimated';
  snapshotAgeMs: number | null;
  availableDepth: number;
  bestBid: number | null;
  bestAsk: number | null;
  rejectReason?: string;
}

class OrderBookExecutionSimulator {
  async simulateBuy(marketId, tokenId, size, signalPrice): Promise<SimulationResult>
  async simulateSell(marketId, tokenId, size, signalPrice): Promise<SimulationResult>
  async loadConfig(): Promise<void>  // loads calibrated params from DB
}
```

### Walk-the-Book (orderbook mode)

When a fresh snapshot exists (< 60s):

1. Parse `asks` JSON array (for buys) or `bids` (for sells)
2. Walk levels consuming liquidity:
   ```
   asks: [{price: 0.87, size: 50}, {price: 0.88, size: 100}, {price: 0.89, size: 200}]
   order: 219 shares
   fill: 50@0.87 + 100@0.88 + 69@0.89 = avg 0.882
   slippage vs best_ask: (0.882 - 0.87) / 0.87 = 1.4%
   ```
3. If total depth < requested size: partial fill (execute what's available)
4. If slippage > maxSlippagePct (5%): reject trade
5. Record: executedPrice, executedSize, slippagePct, availableDepth

### Proportional Model (estimated mode)

When no fresh snapshot exists:

1. Fetch `volume_24h` from markets table
2. Compute: `slippage = max(floor, baseRate + (orderSize × signalPrice / volume24h) × volumeFactor)`
3. Adjust price: `executedPrice = signalPrice × (1 + slippage)` for buys, `× (1 - slippage)` for sells
4. Always full fill (no depth data to estimate partials)
5. fillSource = 'estimated'

Initial conservative params: floor=1%, baseRate=0.2%, volumeFactor=10%.

### Auto-Calibration

After collecting real order book data for tradeable markets (~3-5 days):

1. **Calibration script** (`scripts/calibrate-slippage.js`):
   - For each real snapshot of tradeable markets (spread < 0.20)
   - Simulate walk-the-book for order sizes: [50, 100, 200, 500] shares
   - Compute actual slippage at each size
   - Fit proportional model params (baseRate, volumeFactor) via least-squares
   - Store in `trading_config` table (key: `slippage_model_params`)

2. **Periodic recalibration**: Weekly via optimization scheduler or manual trigger

3. **OrderBookExecutionSimulator.loadConfig()**: Reads calibrated params from DB on startup and periodically refreshes

## Changes to Existing Components

### AutoSignalExecutor

**Opening positions** (lines ~578-597):
- Before: `executed_price = signal.price`
- After: `const sim = await this.simulator.simulateBuy(marketId, tokenId, shares, signal.price)`
- Use `sim.executedPrice` for trade record and position entry price
- Use `sim.executedSize` (may be < requested for partial fills)
- If `!sim.executed`: skip trade, log reason

**Closing positions** (lines ~759-772):
- Before: exit price from price_history
- After: `const sim = await this.simulator.simulateSell(marketId, tokenId, size, exitPrice)`
- Pass `sim.executedPrice` to PositionClosingService

### Data Collector — ClobCollector

**Priority order book collection**:
- Query `markets` table for `tracking_status = 'active'` (signal engine markets)
- Collect order books for these ~20 markets FIRST, every cycle
- Then collect remaining tracked markets if time permits
- This ensures fresh snapshots for markets we actually trade

### Database Migrations

**paper_trades** — 3 new columns:
```sql
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS fill_source VARCHAR(20) DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS snapshot_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS available_depth DECIMAL(20,6);
```

Note: `best_bid`, `best_ask`, `orderbook_depth`, `slippage_pct` columns already exist but are currently NULL. They will now be populated.

## Rejection Scenarios

| Condition | Action |
|-----------|--------|
| No snapshot AND no volume_24h | Reject trade |
| Slippage > 5% (either mode) | Reject trade |
| Partial fill < 50% of requested | Reject trade |
| Snapshot age > 60s | Use estimated mode |

## Observability

After deployment, monitor:
- `fill_source` distribution: what % uses real books vs estimated
- `slippage_pct` by source: are estimated trades realistic?
- `snapshot_age_ms` distribution: is 60s threshold right?
- Trade rejection rate: are we rejecting too many?

Query for evaluation:
```sql
SELECT
  fill_source,
  COUNT(*) as trades,
  ROUND(AVG(slippage_pct)::numeric, 4) as avg_slippage,
  ROUND(AVG(snapshot_age_ms)::numeric, 0) as avg_snapshot_age,
  COUNT(CASE WHEN executed_size < requested_size THEN 1 END) as partial_fills
FROM paper_trades
WHERE fill_source != 'legacy'
GROUP BY fill_source;
```

## Phases

### Phase 1 (immediate)
- Implement OrderBookExecutionSimulator
- Wire into AutoSignalExecutor (open + close)
- DB migration for new columns
- Fix ClobCollector to prioritize active markets
- Deploy with conservative estimated params

### Phase 2 (after ~3-5 days of data)
- Run calibration script on collected real snapshots
- Adjust model parameters
- Evaluate fill_source distribution and slippage realism

### Phase 3 (ongoing)
- Periodic recalibration
- Tighten/loosen maxSnapshotAgeMs based on data
- Consider adding latency simulation (200-500ms delay) if other gaps are more impactful

## Non-Goals (YAGNI)

- Limit orders in paper trading (we use market orders)
- Sub-second latency simulation (60s snapshot granularity makes this moot)
- Synthetic order book generation (we use real data)
- Pending order queue (paper trades are immediate)

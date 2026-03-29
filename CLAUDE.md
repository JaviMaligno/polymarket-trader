# Polymarket Trading System

## Overview

Automated trading system for Polymarket prediction markets. Uses signal generation, optimization, and automated execution for paper trading.

## Architecture

```
polymarket-trader/
├── packages/
│   ├── signals/          # Signal generators (momentum, mean_reversion, OFI, etc.)
│   ├── data-collector/   # Market data collection service
│   ├── dashboard/        # API server + frontend + trading execution
│   ├── trader/           # Trading engine (paper trading)
│   ├── optimizer/        # Bayesian optimization for signal weights
│   └── backtest/         # Backtesting framework
└── scripts/              # Utility scripts for operations
```

## Deployment

- **GCP VM**: e2-micro (1GB RAM) running TimescaleDB + data-collector + dashboard-api
- **Database**: Timescale Cloud (external)
- **CI/CD**: GitHub Actions builds Docker images, pushes to GHCR, deploys to GCP
- **Images**: ghcr.io/javimaligno/polymarket-trader/{dashboard-api,data-collector}

### Docker Commands (on GCP VM)

```bash
# SSH into VM
gcloud compute ssh polymarket-vm --zone=us-east1-b

# View logs
docker compose -f docker-compose.gcp.yml logs -f dashboard-api
docker compose -f docker-compose.gcp.yml logs -f data-collector

# Restart services
docker compose -f docker-compose.gcp.yml restart dashboard-api

# Pull latest images (built by CI/CD) and restart
docker compose -f docker-compose.gcp.yml pull
docker compose -f docker-compose.gcp.yml up -d --remove-orphans
```

## Recurring Analysis Scripts

All scripts require `DATABASE_URL` environment variable pointing to Timescale Cloud.

### Quick Status Check
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/check-status.js
```
Shows: total markets, active markets (24h), recent prices, trades today, paper account balance/equity/PnL, signals last hour.

### Trade Analysis
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/check-trades.js
```
Shows: last 10 trades with details, hourly trade breakdown (6h), 24h statistics, signal type distribution.

### System Activity
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/check-activity.js
```
Shows: market counts by category, price data freshness, recent price updates, optimization runs, current signal weights.

### Diagnose Losses
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/diagnose-loss.js
```
Analyzes recent trades to identify patterns in losing trades.

## Signal Generation Pipeline

1. **Data Collection**: data-collector fetches market prices every 5 seconds
2. **Signal Generation**: SignalEngine runs 5 generators (momentum, mean_reversion, OFI, MLOFI, Hawkes)
3. **Signal Combination**: WeightedAverageCombiner combines signals with optimized weights
4. **Execution**: AutoSignalExecutor opens/closes positions based on combined signals

### Current Configuration

- **Combiner thresholds**: minCombinedConfidence=0.43, minCombinedStrength=0.27
- **Market filter**: Excludes markets with Yes price <5% or >95%
- **Max positions**: 50 concurrent open positions
- **Signal interval**: 60 seconds

### Signal Directions

- **LONG**: Buy Yes token (price expected to rise)
- **SHORT**: Buy No token or close Yes position (price expected to fall)

## System Invariants (for debugging and review)

Rules that MUST hold. When data violates one, there's a bug.

### Position Lifecycle
- All position closes MUST go through `PositionClosingService` (`packages/dashboard/src/services/PositionClosingService.ts`)
- `paper_positions` with `closed_at IS NOT NULL` must have `size = 0` (otherwise: zombie — capital trapped)
- Every buy trade should have a corresponding sell trade eventually (buy count >> sell count = positions lost)

### Capital Accounting
- `current_capital + SUM(open position costs) ≈ initial_capital + total_realized_pnl - total_fees`
- `paper_account.total_realized_pnl` must equal `SUM(realized_pnl)` from all closed positions
- **Known historical gap**: Pre-reset trade data exists in DB. Last reset: 2026-03-29 (reset #6, CLOB API inverted prices). Use `WHERE created_at >= '2026-03-29'` for post-reset trade analysis.

### Historical Bug Patterns
- Services bypassing PositionClosingService with direct SQL
- ON CONFLICT upserts not resetting all fields (e.g., `closed_at`)
- Hardcoded config values that should read env vars
- Formula asymmetry (e.g., peak uses equity but drawdown uses capital-only)

## Key Environment Variables

```bash
# Database
DATABASE_URL=postgres://...
NODE_TLS_REJECT_UNAUTHORIZED=0  # Required for Timescale Cloud

# Trading
INITIAL_CAPITAL=10000
MAX_DRAWDOWN=0.15
MAX_DAILY_LOSS=500

# Risk Protection
ENABLE_RISK_PROTECTION=true
MAX_EXPOSURE_PER_MARKET=0.03
MAX_TOTAL_EXPOSURE=0.60

# Executor
EXECUTOR_MIN_CONFIDENCE=0  # Uses combiner thresholds instead
EXECUTOR_MIN_STRENGTH=0
EXECUTOR_MAX_OPEN_POSITIONS=50
```

## Common Operations

### Check if system is generating signals
```bash
# View dashboard logs on GCP
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker compose -f docker-compose.gcp.yml logs --tail=100 dashboard-api | grep -E "(signals generated|executed|Signal)"'
```

### Verify price collection
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT COUNT(*) as count, MAX(time) as latest FROM price_history WHERE time > NOW() - INTERVAL \\'1 hour\\'')
  .then(r => console.log('Prices last hour:', r.rows[0]))
  .then(() => pool.end());
"
```

### Force signal computation
```bash
curl -X POST http://34.68.123.XXX:3001/api/signals/compute
```

## Troubleshooting

### No signals being generated
1. Check market filtering - may have filtered all markets with extreme prices
2. Verify price data is being collected (check-status.js)
3. Check SignalEngine logs for "Filtered X markets"

### Signals generated but not executed
1. Check existing positions count vs maxOpenPositions
2. Verify signal confidence/strength meets thresholds
3. Check AutoSignalExecutor logs for rejection reasons

### VM out of memory
- e2-micro has only 1GB RAM
- TimescaleDB: 280MB limit
- Data-collector: 100MB limit
- Dashboard-api: 200MB limit
- If OOM, restart with `docker compose restart`

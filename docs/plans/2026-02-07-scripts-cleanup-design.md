# Scripts Cleanup and Test Organization Design

## Overview

Reorganize the `scripts/` folder to remove ad-hoc/debug scripts, document remaining operational scripts with self-documenting `--help` support, and create a structured `tests/` folder with comprehensive test coverage.

## Goals

1. Remove 24 obsolete/debug scripts
2. Keep 14 operational scripts with `--help` autodocumentation
3. Create `tests/` folder with unit/integration/e2e structure
4. Add new tests for critical modules (signals, backtest, trading)

## Scripts Classification

### Scripts to KEEP (14)

| Script | Category | Purpose |
|--------|----------|---------|
| `deploy.sh` | Deployment | Deploy Docker services |
| `stop.sh` | Deployment | Stop services |
| `logs.sh` | Deployment | View container logs |
| `backup.sh` | Deployment | Database backup |
| `gcp-vm-setup.sh` | Deployment | GCP VM setup |
| `auto-update.sh` | Deployment | Auto-update system |
| `health.sh` | Monitoring | Health check |
| `health-monitor.sh` | Monitoring | Continuous monitoring |
| `init-database.sql` | Database | Initial SQL schema |
| `run-schema.js` | Database | Execute migrations |
| `run-retention.js` | Database | Manage retention policies |
| `run-optimization.js` | Trading | Strategy parameter optimization |
| `start-paper-trading.js` | Trading | Start paper trading |
| `train-rl-model.ts` | Trading | Train RL model |

### Scripts to DELETE (24)

```
add-missing-tables.js
aggressive-cleanup.js
analyze-losses.js
analyze-price-issues.js
analyze-signal-neutrality.js
analyze-tables.js
analyze-top100-coverage.js
check-1dollar-positions.js
check-data.js
check-exits.js
check-opt-params.js
check-overnight-status.js
check-price-movement.js
check-retention-status.js
check-signals-detailed.js
check-signals.js
check-trades.js
check-trading-status.js
cleanup-inactive.js
cleanup-to-top-markets.js
debug-prices.js
enable-compression.js
init-live-trading.js
show-positions-pnl.js
```

## Self-Documenting Script Format

### JavaScript/TypeScript Pattern

```javascript
#!/usr/bin/env node
/**
 * script-name.js - Short description
 *
 * Detailed description of what the script does.
 *
 * Usage: node scripts/script-name.js [options]
 *
 * Options:
 *   --help     Show this help message
 *   --dry-run  Show actions without executing
 *
 * Environment:
 *   VAR_NAME  Description (required|optional)
 *
 * Example:
 *   VAR_NAME="value" node scripts/script-name.js
 */

if (process.argv.includes('--help')) {
  const fs = require('fs');
  const content = fs.readFileSync(__filename, 'utf8');
  const match = content.match(/\/\*\*[\s\S]*?\*\//);
  if (match) {
    console.log(match[0].replace(/^\/\*\*|\*\/$/g, '').replace(/^ \* ?/gm, ''));
  }
  process.exit(0);
}
```

### Bash Pattern

```bash
#!/bin/bash
# script-name.sh - Short description
#
# Detailed description of what the script does.
#
# Usage: ./scripts/script-name.sh [arguments]
#
# Arguments:
#   arg1  Description (default: value)
#
# Environment:
#   VAR_NAME  Description (default: value)
#
# Example:
#   ./scripts/script-name.sh production

if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi
```

## Tests Structure

```
tests/
├── unit/
│   ├── categorization.test.ts
│   ├── momentum-signal.test.ts
│   ├── mean-reversion-signal.test.ts
│   ├── weighted-combiner.test.ts
│   ├── performance-calculator.test.ts
│   ├── slippage-model.test.ts
│   └── risk-profiles.test.ts
├── integration/
│   ├── paper-trading-engine.test.ts
│   ├── signal-to-order-flow.test.ts
│   └── database-repositories.test.ts
└── e2e/
    ├── trading-cycle.test.ts
    └── api-endpoints.test.ts
```

## README Structure

`scripts/README.md` will contain:

1. Brief intro explaining all scripts support `--help`
2. Categorized table (Deployment, Database, Trading, Monitoring)
3. One-line description per script

## Implementation Steps

### Phase 1: Cleanup
1. Delete 24 obsolete scripts
2. Move `test-categories.ts` to `tests/unit/categorization.test.ts`

### Phase 2: Autodocumentation
3. Add `--help` to all 8 bash scripts
4. Add `--help` to all 4 JS scripts
5. Add `--help` to 1 TS script
6. Create `scripts/README.md`

### Phase 3: Test Structure
7. Create `tests/unit/`, `tests/integration/`, `tests/e2e/`
8. Adapt categorization test with proper imports

### Phase 4: New Tests
9. Create unit tests for signals (momentum, mean-reversion, combiner)
10. Create unit tests for backtest (performance-calculator, slippage)
11. Create integration tests (paper-trading-engine, signal-to-order)
12. Create e2e tests (trading-cycle, api-endpoints)

## Test Coverage Focus

### Unit Tests
- **MomentumSignal**: RSI calculation, MACD signals, momentum normalization
- **MeanReversionSignal**: Bollinger Bands, Z-Score thresholds
- **WeightedCombiner**: Signal aggregation, confidence calculation
- **PerformanceCalculator**: Sharpe ratio, Sortino, max drawdown, win rate
- **SlippageModel**: Fixed, proportional, orderbook models

### Integration Tests
- **PaperTradingEngine**: Order lifecycle, position management, portfolio state
- **SignalToOrderFlow**: Signal generates correct order parameters
- **DatabaseRepositories**: CRUD operations work correctly

### E2E Tests
- **TradingCycle**: Full flow from signal detection to position closure
- **APIEndpoints**: REST endpoints return expected responses

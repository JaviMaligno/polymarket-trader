# Polymarket Trading System

A full-stack trading system for Polymarket prediction markets with backtesting, paper trading, and live trading capabilities.

## Features

- **Data Collection**: Automated collection of market data, price history, and trade data from Polymarket APIs
- **Signal Framework**: Modular signal system supporting wallet tracking, momentum, mean reversion, and arbitrage strategies
- **Backtesting Engine**: Event-driven backtesting with realistic order book simulation
- **Paper Trading**: Simulated trading with real market data
- **Weight Optimization**: Bayesian optimization for signal weight tuning

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- Docker (for TimescaleDB)

### Installation

```bash
# Clone the repository
cd polymarket-trader

# Install dependencies
pnpm install

# Copy environment file
cp packages/data-collector/.env.example packages/data-collector/.env

# Start TimescaleDB
docker-compose up -d timescaledb

# Wait for database to be ready, then start data collection
pnpm collector:dev
```

### Project Structure

```
polymarket-trader/
├── packages/
│   ├── data-collector/    # Data ingestion service
│   ├── signals/           # Signal framework (coming soon)
│   ├── backtest/          # Backtesting engine (coming soon)
│   └── trading/           # Live/paper trading (coming soon)
├── python/                # ML optimization services (coming soon)
└── docker-compose.yml     # TimescaleDB container
```

## Data Collection

The data collector automatically:

1. **Syncs markets** every 5 minutes from Gamma API
2. **Syncs events** every 10 minutes
3. **Updates prices** every minute
4. **Collects price history** every 15 minutes

### Rate Limits

The system respects Polymarket's free tier rate limits:
- Gamma API: 4000 req/10s (general), 300 req/10s (markets), 500 req/10s (events)
- CLOB API: 1500 req/10s (prices/books), 1000 req/10s (history)
- Data API: 200 req/10s (trades), 150 req/10s (positions)

## Database

Using TimescaleDB for efficient time-series storage:

- **Hypertables**: price_history, trades, positions, orderbook_snapshots
- **Continuous Aggregates**: 5-minute, hourly, and daily bars
- **Compression**: Automatic compression for data older than 7 days

## Development Status

- [x] Phase 1: Data Foundation (data-collector package)
- [ ] Phase 2: Signal Framework
- [ ] Phase 3: Backtesting Engine
- [ ] Phase 4: Weight Optimization
- [ ] Phase 5: Validation Framework
- [ ] Phase 6: Paper Trading
- [ ] Phase 7: Live Trading

## License

MIT

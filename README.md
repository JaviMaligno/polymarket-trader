# Polymarket Trading System

A full-stack trading system for Polymarket prediction markets with signal generation, backtesting, paper trading, and live trading capabilities.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GCP VM (e2-micro)                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Data Collector │  │  Dashboard API  │  │   TimescaleDB   │  │
│  │   (Node.js)     │  │   (Node.js)     │  │   (PostgreSQL)  │  │
│  │   :10000        │  │   :3001         │  │   :5432         │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                           Render                                 │
│  ┌─────────────────┐  ┌─────────────────┐                       │
│  │    Optimizer    │  │    Frontend     │                       │
│  │  (Python/Optuna)│  │   (React/Vite)  │                       │
│  └─────────────────┘  └─────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Data Collection**: Automated collection of market data, price history, and trade data from Polymarket APIs
- **Signal Framework**: Modular signal system with momentum, mean reversion, and composite strategies
- **Backtesting Engine**: Event-driven backtesting with realistic order book simulation
- **Paper Trading**: Simulated trading with real market data and performance tracking
- **Weight Optimization**: Bayesian optimization (Optuna) for signal weight tuning
- **Dashboard**: Real-time monitoring with WebSocket updates

## Project Structure

```
polymarket-trader/
├── packages/
│   ├── data-collector/    # Market data ingestion service
│   ├── signals/           # Signal generation framework
│   ├── backtest/          # Backtesting engine
│   ├── trader/            # Paper/live trading engine
│   ├── optimizer/         # Weight optimization (Node.js client)
│   └── dashboard/         # API server + React frontend
├── services/
│   └── optimizer-server/  # Python FastAPI + Optuna server
├── scripts/               # Utility scripts
├── docs/                  # Documentation
│   └── gcp-deployment.md  # GCP deployment guide
└── docker-compose.gcp.yml # GCP VM deployment
```

## Quick Start (Local Development)

### Prerequisites

- Node.js 18+
- pnpm 8+
- Docker (for TimescaleDB)

### Installation

```bash
# Install dependencies
pnpm install

# Start TimescaleDB locally
docker-compose up -d timescaledb

# Start data collector
pnpm collector:dev

# Start dashboard (in another terminal)
pnpm --filter @polymarket-trader/dashboard dev
```

## Deployment

The system runs on **GCP Free Tier** (e2-micro VM) with the frontend and optimizer on Render.

See [docs/gcp-deployment.md](docs/gcp-deployment.md) for detailed deployment instructions.

### Quick Deploy to GCP

```bash
# SSH into VM
gcloud compute ssh polymarket-vm --zone=us-east1-b

# Clone and setup
git clone https://github.com/JaviMaligno/polymarket-trader.git
cd polymarket-trader

# Configure environment
echo "DATABASE_URL=your_connection_string" > .env

# Start services
docker compose -f docker-compose.gcp.yml up -d --build
```

## Services

| Service | Location | URL |
|---------|----------|-----|
| Dashboard API | GCP | http://34.74.36.101:3001 |
| Data Collector | GCP | http://34.74.36.101:10000 |
| Optimizer | Render | https://polymarket-optimizer-server.onrender.com |
| Frontend | Render | https://polymarket-dashboard-frontend.onrender.com |

## API Endpoints

### Dashboard API (port 3001)

- `GET /health` - Health check
- `GET /api/markets` - List tracked markets
- `GET /api/signals` - Get current signals
- `GET /api/positions` - Get open positions
- `GET /api/account` - Get account status
- `WS /ws` - WebSocket for real-time updates

### Data Collector (port 10000)

- `GET /health` - Health check with sync status

## Configuration

Environment variables for GCP deployment:

```env
DATABASE_URL=postgresql://user:pass@host:5432/db
NODE_ENV=production
ENABLE_SIGNAL_ENGINE=true
ENABLE_OPTIMIZATION=true
OPTIMIZER_URL=https://polymarket-optimizer-server.onrender.com
```

## License

MIT

# Scripts

Operational scripts for the Polymarket Trader system.

All scripts support `--help` for detailed usage information.

## Deployment

| Script | Description |
|--------|-------------|
| `deploy.sh` | Build and start Docker services |
| `stop.sh` | Stop all running services |
| `logs.sh` | View container logs |
| `backup.sh` | Backup TimescaleDB database |
| `gcp-vm-setup.sh` | Setup fresh GCP VM |
| `auto-update.sh` | Auto-pull and redeploy (cron) |

## Database

| Script | Description |
|--------|-------------|
| `init-database.sql` | Initial SQL schema |
| `run-schema.js` | Execute schema migrations |
| `run-retention.js` | Manage retention policies |

## Trading

| Script | Description |
|--------|-------------|
| `run-optimization.js` | Optimize strategy parameters |
| `start-paper-trading.js` | Start paper trading mode |
| `train-rl-model.ts` | Train RL model on historical data |

## Monitoring

| Script | Description |
|--------|-------------|
| `health.sh` | One-time health check |
| `health-monitor.sh` | Continuous monitoring (cron) |

## Usage Examples

```bash
# Deploy in production
./scripts/deploy.sh production

# Check service health
./scripts/health.sh

# View dashboard-api logs
./scripts/logs.sh dashboard-api

# Run database migrations
DATABASE_URL="postgres://..." node scripts/run-schema.js

# Start paper trading
node scripts/start-paper-trading.js

# Get help for any script
./scripts/deploy.sh --help
node scripts/run-optimization.js --help
```

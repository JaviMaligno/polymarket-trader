# Going Live: Paper Trading -> Real Trading

This guide walks you through transitioning the Polymarket trading system from paper trading to real money trading.

## Prerequisites

- [ ] Paper trading system running and generating signals
- [ ] Familiarity with crypto wallets (Polygon/USDC)
- [ ] GCP project with Secret Manager API enabled (or POLYGON_PRIVATE_KEY env var for testing)
- [ ] USDC on Polygon network
- [ ] Access to the dashboard API (API key for POST endpoints)

## Phase 0: Setup (One Time)

### 1. Create a Dedicated Wallet

Create a NEW Polygon wallet specifically for the bot. Do NOT reuse your personal wallet.

You can use any Ethereum-compatible wallet tool:
- MetaMask: Create new account, export private key
- ethers.js: `npx ts-node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address, '\nKey:', w.privateKey)"`

Save the private key securely. You will need it in the next step.

### 2. Store Private Key in GCP Secret Manager

```bash
# Create the secret
echo -n "0xYOUR_PRIVATE_KEY" | gcloud secrets create polymarket-bot-key --data-file=-

# Grant the VM's service account access
gcloud secrets add-iam-policy-binding polymarket-bot-key \
  --member="serviceAccount:YOUR-VM-SA@YOUR-PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Set the env var on the VM:
```
GCP_SECRET_NAME=projects/YOUR-PROJECT/secrets/polymarket-bot-key/versions/latest
```

Alternative (for local testing only): Set `POLYGON_PRIVATE_KEY=0x...` in .env

### 3. Configure Wallet Address

```bash
curl -X POST http://YOUR_API_HOST:3001/api/trading/mode \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"wallet_address": "0xYOUR_WALLET_ADDRESS"}'
```

Or directly in the database:
```sql
INSERT INTO trading_config (key, value, description)
VALUES ('wallet_address', '"0xYOUR_WALLET_ADDRESS"', 'Bot wallet address')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

### 4. Set Environment Variables

Add to docker-compose.gcp.yml for the dashboard-api service:
```yaml
environment:
  - GCP_SECRET_NAME=projects/YOUR-PROJECT/secrets/polymarket-bot-key/versions/latest
  - POLYGON_RPC_URL=https://polygon-rpc.com  # or your preferred RPC
  - CLOB_API_URL=https://clob.polymarket.com
  - SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### 5. Calculate Thresholds

Run the threshold calculator to get data-driven values:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/calculate-trading-thresholds.js
```

Apply the recommended thresholds:
```bash
curl -X POST http://YOUR_API_HOST:3001/api/trading/mode \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"min_balance_threshold": RECOMMENDED_MIN, "warning_balance_threshold": RECOMMENDED_WARNING}'
```

### 6. Restart the Service

```bash
docker compose -f docker-compose.gcp.yml restart dashboard-api
```

Check logs to confirm initialization:
```bash
docker compose -f docker-compose.gcp.yml logs dashboard-api | grep -i "real trading"
```

Expected: `Real trading services initialized` or `No wallet configured -- real trading disabled`

## Phase 1: Dry Run (24+ hours)

### Enable Dry-Run Mode

```bash
curl -X POST http://YOUR_API_HOST:3001/api/trading/mode \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"real_trading_enabled": true, "real_trading_dry_run": true}'
```

### Monitor Logs

```bash
docker compose -f docker-compose.gcp.yml logs -f dashboard-api | grep -E "(DRY RUN|CLOB order|ExecutionRouter)"
```

### Dry-Run Checklist

Run for at least 24 hours, then verify:
- [ ] Orders reference correct token IDs (match market's token_id)
- [ ] Prices are within expected range (0.01-0.99)
- [ ] Sizes match position sizing logic (not 0, not absurdly large)
- [ ] No errors in logs related to order building/signing
- [ ] System continues to record paper trades normally
- [ ] Mode shows correctly: `curl http://YOUR_API_HOST:3001/api/trading/mode`

## Phase 2: Minimal Live Test ($5-10)

### Fund the Wallet

1. Buy USDC on your preferred exchange (Coinbase, Kraken, etc.)
2. Send $5-10 USDC to your bot wallet address on Polygon network
3. Verify it arrived: check on polygonscan.com or via wallet status endpoint

### Enable Real Trading

```bash
curl -X POST http://YOUR_API_HOST:3001/api/trading/mode \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"real_trading_enabled": true, "real_trading_dry_run": false}'
```

### Verify First Trade

Wait for the system to execute a real trade, then check:
- [ ] Order visible on Polymarket (check your wallet on polymarket.com)
- [ ] Wallet balance decreased by trade amount
- [ ] Trade recorded in DB with `execution_mode='real'`
- [ ] Slack notification received (if configured)

```sql
-- Check for real trades
SELECT time, market_id, side, executed_size, executed_price, execution_mode
FROM paper_trades
WHERE execution_mode = 'real'
ORDER BY time DESC LIMIT 5;
```

### Verify Full Cycle

Wait for a position to close, then verify:
- [ ] USDC returned to wallet (minus fees)
- [ ] Position closed in DB with realized PnL
- [ ] Sell trade recorded with `execution_mode='real'`

## Phase 3: Gradual Production

1. Deposit your initial capital (based on comfort level and paper trading performance)
2. Thresholds are already set from Phase 0
3. Monitor the first week closely
4. Check wallet status regularly:
   ```bash
   curl http://YOUR_API_HOST:3001/api/wallet/status
   ```

### What to Watch

- Slack notifications for low balance warnings
- Trade frequency vs paper trading (should be similar)
- Real PnL vs paper PnL divergence
- Slippage (real execution price vs intended price)

## Emergency: Kill Switch

### Immediate Stop

```bash
curl -X POST http://YOUR_API_HOST:3001/api/trading/mode \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"real_trading_enabled": false}'
```

### What Happens

- System immediately switches to paper-only trading
- Open positions on Polymarket **persist** -- they are on-chain
- Close open positions manually at polymarket.com if needed
- System continues generating signals and recording paper trades
- No data is lost

### Recovering

When ready to resume:
1. Verify wallet has sufficient USDC
2. Re-enable: `{"real_trading_enabled": true}`
3. System picks up where it left off

## Troubleshooting

### "No wallet configured"
- Check `wallet_address` in trading_config: `curl http://YOUR_API_HOST:3001/api/trading/mode`
- Value should be a valid Ethereum address (0x...)

### "Failed to initialize real trading"
- Check GCP Secret Manager access
- Verify `GCP_SECRET_NAME` env var is set correctly
- Try fallback: set `POLYGON_PRIVATE_KEY` env var directly

### Trades showing as paper despite real trading enabled
- Check balance: `curl http://YOUR_API_HOST:3001/api/wallet/status`
- If balance < min_threshold, system auto-degraded
- Deposit more USDC and re-enable manually

### Real trade failed, recorded as paper
- Check logs for CLOB errors
- Common: "Insufficient balance", "Market closed", network timeouts
- System automatically falls back to paper -- no action needed

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| GCP_SECRET_NAME | No | (empty) | GCP Secret Manager resource name for private key |
| POLYGON_PRIVATE_KEY | No | (empty) | Fallback: private key as env var (dev only) |
| POLYGON_RPC_URL | No | https://polygon-rpc.com | Polygon JSON-RPC endpoint |
| CLOB_API_URL | No | https://clob.polymarket.com | Polymarket CLOB API URL |
| SLACK_WEBHOOK_URL | No | (empty) | Slack webhook for notifications |

## Database Config Reference

| Key | Type | Description |
|-----|------|-------------|
| real_trading_enabled | boolean | Master toggle for real trading |
| real_trading_dry_run | boolean | Build orders without submitting |
| wallet_address | string | Polygon wallet address |
| min_balance_threshold | number | Auto-degrade below this USDC balance |
| warning_balance_threshold | number | Send warning above min but below this |
| max_slippage | number | Max slippage for limit orders (default: 0.02) |

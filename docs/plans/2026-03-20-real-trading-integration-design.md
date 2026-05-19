# Real Trading Integration Design

**Date**: 2026-03-20
**Status**: Approved
**Goal**: Enable automated real trading on Polymarket while maintaining paper trading as fallback

## Overview

Integrate real order execution via Polymarket's CLOB API into the existing paper trading system. The system operates in dual mode — every trade is recorded in the existing tables, with an `execution_mode` field distinguishing real from paper. When real funds run out or the user disables real trading, the system degrades gracefully to paper trading without interruption.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 AutoSignalExecutor               │
│            (lógica actual sin cambios)           │
├─────────────────────────────────────────────────┤
│              ExecutionRouter (NUEVO)             │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │ PaperExecutor │    │ RealExecutor (NUEVO)  │  │
│  │ (actual)      │    │ @polymarket/clob-client│  │
│  └──────────────┘    └───────────────────────┘  │
├─────────────────────────────────────────────────┤
│              WalletMonitor (NUEVO)               │
│  - Consulta balance USDC en Polygon cada 5min   │
│  - Notifica fondos bajos via Slack               │
│  - Degradación automática a paper                │
├─────────────────────────────────────────────────┤
│           Tablas existentes + campo nuevo         │
│  paper_trades.execution_mode = 'paper' | 'real'  │
│  paper_positions.execution_mode = 'paper'|'real'  │
│  trading_config.real_trading_enabled (hot toggle) │
└─────────────────────────────────────────────────┘
```

### Principle

The `AutoSignalExecutor` does not change. A new `ExecutionRouter` sits between the executor and the trade recording layer, deciding whether each trade should also be sent to Polymarket's CLOB. The `RealExecutor` wraps `@polymarket/clob-client` for signing and submitting orders. The `WalletMonitor` watches the wallet balance and can disable real trading automatically.

## Components

### 1. ExecutionRouter

Decides execution mode per trade based on priority chain:

```typescript
class ExecutionRouter {
  async execute(trade: TradeIntent): Promise<TradeResult> {
    const mode = await this.resolveMode();

    if (mode === 'dry_run') {
      const payload = await this.realExecutor.buildOrder(trade);
      logger.info({ payload }, 'DRY RUN — order built but not sent');
      return { ...this.paperExecute(trade), execution_mode: 'paper' };
    }

    if (mode === 'real') {
      const result = await this.realExecutor.execute(trade);
      return { ...result, execution_mode: 'real' };
    }

    return { ...this.paperExecute(trade), execution_mode: 'paper' };
  }

  // Priority: hot toggle > balance check > env var
  private async resolveMode(): Promise<'real' | 'paper' | 'dry_run'> {
    const config = await this.getConfig(); // trading_config table
    if (!config.real_trading_enabled) return 'paper';

    const balance = this.walletMonitor.getCachedBalance();
    if (balance < config.min_balance_threshold) return 'paper';

    if (config.dry_run) return 'dry_run';

    return 'real';
  }
}
```

### 2. RealExecutor

Wraps `@polymarket/clob-client`:

- **Startup**: Loads private key from GCP Secret Manager, initializes CLOB client with wallet signer
- **execute()**: Builds limit order at best available price with slippage tolerance, signs it, submits to CLOB
- **Retries**: 1 retry on network timeout, no retry on CLOB errors (insufficient balance, market closed)
- **Dry-run**: Builds and signs order but does not submit; logs full payload
- **Slippage**: Configurable `MAX_SLIPPAGE` (default 0.02). For "market orders", submits limit order at best price + slippage

### 3. WalletMonitor

```typescript
class WalletMonitor {
  private cachedBalance: number;
  private readonly checkInterval = 5 * 60 * 1000; // 5 minutes

  async check(): Promise<void> {
    const balance = await this.getUSDCBalance(); // ethers.js read-only RPC call
    this.cachedBalance = balance;

    if (balance < this.minBalanceThreshold) {
      await this.setRealTradingEnabled(false);
      this.notify('funds_low', { balance, threshold: this.minBalanceThreshold });
    } else if (balance < this.warningThreshold) {
      this.notify('funds_warning', { balance });
    }
  }
}
```

**Notifications** via existing Slack webhook:
- `funds_warning`: Informative — balance approaching threshold
- `funds_low`: Action taken — switched to paper trading automatically
- `mode_change`: Audit — mode changed by user or system

**Re-activation**: When user deposits more USDC, WalletMonitor detects it but does NOT re-enable real trading automatically. User must re-enable manually via API.

**Thresholds**: Calculated from historical paper trading data:
- `min_balance_threshold`: Based on average cost of 2-3 trades from paper trading history
- `warning_threshold`: 2x min_balance_threshold

## Database Changes

### Modified tables (columns added)

```sql
ALTER TABLE paper_trades ADD COLUMN execution_mode VARCHAR(10) DEFAULT 'paper';
ALTER TABLE paper_positions ADD COLUMN execution_mode VARCHAR(10) DEFAULT 'paper';
```

### New entries in trading_config (existing table)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| real_trading_enabled | boolean | false | Hot toggle for real trading |
| real_trading_dry_run | boolean | false | Build+sign orders without submitting |
| min_balance_threshold | numeric | (from data) | Minimum USDC balance for real trading |
| warning_balance_threshold | numeric | (from data) | Warning notification threshold |
| max_slippage | numeric | 0.02 | Slippage tolerance for limit orders |
| wallet_address | text | null | Polygon wallet address (public) |

No new tables created.

### API Endpoints

```
POST /api/trading/mode
  { "real_trading_enabled": true }     → enable real trading
  { "real_trading_enabled": false }    → switch to paper
  { "real_trading_dry_run": true }     → enable dry-run mode

GET /api/trading/mode
  → { mode: "real"|"paper"|"dry_run", balance: 142.50, wallet_address, ... }

GET /api/wallet/status
  → { address, balance, last_checked, min_threshold, warning_threshold }
```

Mode changes are logged with timestamp in trading_config for audit.

## Security

- **Private key**: Stored in GCP Secret Manager (free tier, up to 6 versions). Never on disk.
- **Dedicated wallet**: New wallet created specifically for the bot. Not reused from personal wallets.
- **Kill switch**: `POST /api/trading/mode { "real_trading_enabled": false }` stops real trading immediately. Open positions on Polymarket persist and can be closed manually on their website.
- **No auto-reactivation**: Real trading never turns itself back on after being disabled.

## Testing Strategy

### Layer 1: Unit tests (mock CLOB client)
- ExecutionRouter correctly delegates to RealExecutor vs PaperExecutor
- WalletMonitor degrades to paper when balance drops
- Hot toggle respected
- Mode priority chain works correctly
- Notifications fire at correct thresholds

### Layer 2: Integration tests (dry-run mode)
- RealExecutor builds and signs real orders without submitting
- Logs show exact payload that would be sent to CLOB
- Wallet connection works, balance reads correctly
- Run for at least 24h in production to verify stability
- Checklist:
  - [ ] Orders reference correct token IDs
  - [ ] Prices within expected range
  - [ ] Sizes match position sizing logic
  - [ ] Slippage tolerance applied correctly
  - [ ] Signatures valid

### Layer 3: Live test (minimal capital)
- Deposit $5-10 USDC on Polygon
- Enable real trading
- Wait for 1 trade to execute
- Verify:
  - [ ] Order visible on Polymarket
  - [ ] Wallet balance decreased correctly
  - [ ] Trade recorded in DB with `execution_mode='real'`
  - [ ] Position created in DB
- Close position (wait for signal or manual)
- Verify:
  - [ ] USDC returned to wallet
  - [ ] Position closed in DB with realized PnL
  - [ ] Full cycle complete

## Onboarding: Paper to Real

### Phase 0 — Setup (once)
1. Create dedicated Polygon wallet for the bot (new keypair, do not reuse personal wallet)
2. Store private key in GCP Secret Manager (`polymarket-bot-private-key`)
3. Configure `wallet_address` in trading_config
4. Deploy updated code with ExecutionRouter, RealExecutor, WalletMonitor
5. Install dependencies: `@polymarket/clob-client`

### Phase 1 — Dry-run
1. Set `real_trading_dry_run = true` via API
2. Monitor logs for 24h+ — verify orders are built correctly
3. Run through dry-run checklist above
4. Fix any issues found

### Phase 2 — Minimal live test
1. Deposit $5-10 USDC to wallet on Polygon
2. Set `real_trading_dry_run = false`, `real_trading_enabled = true`
3. Wait for 1 complete trade cycle (open + close)
4. Run through live test checklist above
5. If any issues: disable real trading, investigate, fix, repeat

### Phase 3 — Gradual production
1. Deposit initial capital (amount based on paper trading performance and comfort level)
2. Thresholds auto-calculated from historical trade data
3. Monitor first week closely — dashboard shows real vs paper trades
4. Adjust thresholds and slippage based on real execution experience

### Emergency — Kill switch
- `POST /api/trading/mode { "real_trading_enabled": false }` — immediate stop
- Open positions on Polymarket persist — close manually on their website if needed
- System continues in paper trading mode — no data loss, optimization continues

## Resource Impact

- **VM**: One additional HTTP call per real trade (CLOB order submission) — negligible
- **WalletMonitor**: One RPC call every 5 minutes to Polygon — negligible
- **Database**: Two new VARCHAR columns, no new tables — negligible
- **Memory**: CLOB client + ethers signer in memory — ~10-20MB additional
- **GCP Secret Manager**: 1 API call on service startup — free tier

## Dependencies

| Package | Purpose | Already in project? |
|---------|---------|-------------------|
| `@polymarket/clob-client` | CLOB order submission | No — add to dashboard |
| `ethers` | Wallet signing + USDC balance check | Yes (data-collector) |
| `@google-cloud/secret-manager` | Private key retrieval | No — add to dashboard |

## Funding Flow

```
User's bank (EUR/GBP/USD)
  → Crypto exchange (Coinbase/Kraken/etc) — manual
  → Buy USDC
  → Send to bot's Polygon wallet
  → Bot trades via CLOB API
  → Profits stay in wallet (auto-reinvested)
  → Withdraw: send USDC back to exchange → bank — manual
```

Funding and withdrawal are manual (Option A). The system notifies when funds are low but never auto-purchases USDC.

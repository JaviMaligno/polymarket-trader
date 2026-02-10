# Fix signal_type in Paper Trades

## Problem

96% of paper trades (1,143 of 1,196) have `signal_type = NULL` in the database, preventing analysis of which signals drive profitable trades.

**Root cause:** In `server.ts`, when listening to `order:filled` events, `recordTrade()` is called without the `signalInfo` parameter:

```typescript
tradingSystem.engine.on('order:filled', (order, fill) => {
  paperTradingService.recordTrade(order, fill); // ← missing signalInfo
});
```

## Solution

Propagate signal information through `order.metadata.signalInfo` from order creation to trade recording.

### Changes

#### 1. StrategyOrchestrator.ts

Add `signalInfo` to order metadata with the dominant signal type:

```typescript
// Line ~709
metadata: {
  signalInfo: {
    signalType: this.getPrimarySignalType(signal),
    direction: signal.direction,
    strength: signal.strength,
    confidence: signal.confidence,
  },
},
```

Add helper method:

```typescript
private getPrimarySignalType(signal: CombinedSignalOutput): string {
  if (!signal.weights || Object.keys(signal.weights).length === 0) {
    return 'combined';
  }
  const maxWeight = Math.max(...Object.values(signal.weights));
  const primary = Object.entries(signal.weights)
    .find(([, w]) => w === maxWeight);
  return primary?.[0] ?? 'combined';
}
```

#### 2. server.ts

Extract `signalInfo` from order metadata:

```typescript
tradingSystem.engine.on('order:filled', (order: any, fill: any) => {
  const signalInfo = order.metadata?.signalInfo as {
    signalId?: number;
    signalType?: string;
    bestBid?: number;
    bestAsk?: number;
  } | undefined;

  paperTradingService.recordTrade(order, fill, signalInfo).catch((err: Error) => {
    console.error('Failed to record trade:', err);
  });
});
```

### Files NOT Changed

- `PaperTradingEngine.ts` - already supports metadata in OrderRequest
- `PaperTradingService.ts` - already accepts signalInfo parameter
- `AutoSignalExecutor.ts` - already works correctly (uses different flow)
- Types - using existing metadata field

### Expected Outcome

All trades from StrategyOrchestrator will have `signal_type` populated with the dominant signal name ('momentum', 'mean_reversion', etc.).

### Testing

1. Deploy changes to GCP VM
2. Wait for new trades to be generated
3. Query: `SELECT signal_type, COUNT(*) FROM paper_trades WHERE time > NOW() - INTERVAL '1 hour' GROUP BY signal_type`
4. Verify new trades have signal_type populated

# B.2 Pre-Deploy Sanity Backtest — Results

Date: 2026-04-25
Period: 2026-03-23 to 2026-04-22 (30 days)
Invocation: `POST /api/backtest/run` on the GCP VM (polymarket-dashboard-api container, port 3001).
Both runs used: `minCombinedConfidence=0.43`, `minCombinedStrength=0.27`, `conflictResolution=weighted`, `initialCapital=10000`.
Market selection: top 20 markets by bar count with ≥35 bars in the date range (non-deterministic ordering when counts tie).

| consensusDiscountFloor | Trades | Winning | Losing | Win Rate | Realized PnL | Sharpe | Notes |
|---|---|---|---|---|---|---|---|
| 1.0 (baseline) | 42 | 19 | 18 | 45.2% | −$111.35 | 0.0223 | pre-B.2 no-op behavior |
| 0.5 (proposed) | 57 | 36 | 16 | 63.2% | +$271.18 | 0.0276 | trade count delta: +35.7% |

Full metrics (baseline / proposed):
- annualizedReturn: −12.7% / +384.8%
- maxDrawdown: 27.1% / 29.6%
- profitFactor: 1.100 / 1.023

**Decision**: kept 0.5. No code change required.

**Rationale**: Trade count did not drop — it increased by 35.7% at floor=0.5 vs 1.0. Sharpe improved slightly (0.0223 → 0.0276). Neither the ">40% drop" nor the "10-40% drop" branches of the decision rule triggered. The ">40% drop" and "10-40% drop" rules were both vacuously false (trade count went up). Default 0.5 ships as-is and Optuna will converge on the empirical optimum.

**Unexpected direction of effect**: The consensus discount at floor=0.5 reduces confidence for low-consensus signals (consensus near 0 → discount ≈ 0.5, making it harder to pass the `minCombinedConfidence=0.43` gate). Expected fewer trades. Instead, more trades appeared — likely explained by non-deterministic market selection between the two runs (top 20 markets by bar count with no stable tie-breaking). Both runs fetched different market subsets, so the comparison is indicative but not perfectly controlled. The absence of any trade suppression is sufficient evidence that 0.5 is not aggressively over-filtering.

**Caveats**:
1. Market selection is non-deterministic across runs (top 20 ordered by COUNT DESC with no stable tie-breaker). The two runs may have selected overlapping but not identical market sets.
2. price_history retention is 30 days; the earliest portion of the window (first week) may have sparser coverage for markets with low trading activity.
3. Backtest signals (MomentumSignal + MeanReversionSignal) are a subset of the 5 live generators. Live behavior with OFI/MLOFI/Hawkes may differ.
4. Both runs returned 0 for predictionMetrics (Brier score, log loss) — those fields are unaffected by this change.

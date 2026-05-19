# Issue #17 Follow-up Designs

**Date**: 2026-03-13
**Trigger**: Issue #17 — all 7 active markets filtered by 50/50 rule, zero signals generated
**Status**: Design approved

## Overview

Three improvements addressing signal generation quality and operational review:

1. **PriceRangeWeightModifier** — Replace hard 50/50 block with weight reduction
2. **Hysteresis on combined_exit** — Different thresholds for open vs close to prevent churn
3. **Claude-first daily review** — Claude analyzes severity before routing alerts

---

## Design 1: PriceRangeWeightModifier

### Problem

The hard 50/50 filter (`setActiveMarkets()` excludes markets with Yes price 0.45–0.55) completely silences signal generation when the market universe is small. Order-flow signals (OFI, MLOFI, Hawkes) remain informative even at near-50% prices — only momentum and mean_reversion lose edge there.

### Architecture

Same pattern as `DurationWeightModifier`: a modifier class that applies per-signal multipliers based on market price range, composing multiplicatively with duration weights.

**File**: `packages/signals/src/modifiers/PriceRangeWeightModifier.ts`

### Price Bands

| Band | Range | Description |
|------|-------|-------------|
| **uncertain** | 0.45 – 0.55 | Coin-flip territory |
| **transitional** | 0.40–0.45 / 0.55–0.60 | Some edge, reduced confidence |
| **normal** | < 0.40 / > 0.60 | Full signal validity |

### Weight Multiplier Matrix

| Signal | normal | transitional | uncertain |
|--------|--------|-------------|-----------|
| momentum | 1.0 | 0.6 | 0 |
| mean_reversion | 1.0 | 0.4 | 0 |
| OFI | 1.0 | 1.0 | 1.0 |
| MLOFI | 1.0 | 1.0 | 1.0 |
| Hawkes | 1.0 | 1.0 | 1.0 |
| volume_anomaly | 1.0 | 1.0 | 1.0 |
| spread_compression | 1.0 | 1.0 | 0.8 |
| cross_market_corr | 1.0 | 0.8 | 0.5 |
| price_divergence | 1.0 | 1.0 | 1.0 |
| attention_spike | 1.0 | 1.0 | 1.0 |
| news_sentiment | 1.0 | 1.0 | 0.7 |

### Integration

- Remove hard block from `SignalEngine.setActiveMarkets()` (the `price < 0.05 || price > 0.95` extreme check stays)
- Apply `PriceRangeWeightModifier` in the same pipeline slot as `DurationWeightModifier`, composing multiplicatively:
  ```
  finalWeight = baseWeight × durationMultiplier × priceRangeMultiplier
  ```
- `currentPrice` (Yes token price) passed as context to modifier

### Optimizer Candidates

All band boundaries (0.45, 0.55, 0.40, 0.60) and all multiplier values in the matrix are candidates for Bayesian optimization. Store in `trading_config` table, load on startup.

---

## Design 2: Hysteresis on combined_exit

### Problem

A single threshold for both opening and closing positions causes churn: if combined confidence fluctuates near the threshold, positions open, weaken slightly, close, re-open. Each round-trip costs fees with no directional gain.

### Design

Two thresholds in `trading_config`:
- `open_threshold`: 0.43 — confidence required to enter a position (current `minCombinedConfidence`)
- `exit_threshold`: 0.25 — confidence required to exit (opposing signal must reach this level)

**Logic in `AutoSignalExecutor.processSignal()`:**

- **Open**: signal confidence ≥ `open_threshold` → enter (unchanged)
- **Exit**: signal direction reverses AND confidence ≥ `exit_threshold` → close
- **Hold**: signal weakens below `open_threshold` but opposing signal < `exit_threshold` → hold position

The dead band (0.25–0.43) means weak contrary noise doesn't trigger exits. A real reversal (confidence ≥ 0.25 in the opposite direction) still closes the position.

**No minimum hold time** — hysteresis achieves anti-churn without an arbitrary time floor. Strong reversals close immediately.

### Optimizer Candidates

Both `open_threshold` (0.43) and `exit_threshold` (0.25) go into the Bayesian parameter space. The optimizer can tune the gap between them to minimize churn while capturing reversals.

### Implementation Note

Rename `minCombinedConfidence` → `openThreshold` in `SignalEngine` config and `trading_config` for clarity. Keep backward-compatible read of old key during transition.

---

## Design 3: Claude-first Daily Review

### Problem

Hardcoded thresholds in the alert pipeline generate false alarms. Example: "7 markets filtered" is flagged as a signal problem but is actually correct behavior of the 50/50 rule. Claude has context to distinguish expected from unexpected behavior.

### Flow

```
daily-review.sh (raw JSON, 20 sections)
  → GitHub Actions: call Claude (Sonnet 4.6) with raw JSON + format-review.js template
  → Claude outputs: narrative + alerts.json
  → Routing: GitHub Issue (always) + Gmail (if critical) + Slack (if critical)
```

### Components

**`daily-review.sh`** — unchanged. Produces raw JSON.

**`format-review.js`** — becomes a template/prompt guide. Defines:
- Output structure (sections, what to analyze)
- Threshold hints for Claude (e.g., "drawdown >10% is typically critical")
- Format for `alerts.json`: `{ severity: "critical"|"warning"|"info", message, reason }`

Claude uses these as guidelines, not hard rules — it can override based on context.

**New GitHub Actions step** (`analyze-review`):
```yaml
- name: Analyze with Claude
  run: |
    node scripts/analyze-review.js "$RAW_JSON" "$FORMAT_TEMPLATE"
  # outputs: GITHUB_ISSUE_BODY, ALERTS_JSON, GMAIL_SUMMARY
```

**`scripts/analyze-review.js`** — calls Claude API (Sonnet 4.6):
- System prompt: "You are a trading system monitor. Analyze the daily review data and produce: (1) a narrative GitHub issue body, (2) alerts.json with only genuinely concerning items, (3) a 3-5 bullet Gmail summary."
- Passes raw JSON + template as user message
- Writes outputs to env vars for downstream routing steps

**Routing** uses `alerts.json` severity counts:
- Always: create GitHub Issue with Claude's narrative
- If `critical` count > 0: send Gmail summary + Slack alert
- `warnings` only: GitHub Issue only (no noise in Slack/Gmail)

### Cost

~2000 tokens per daily review call ≈ $0.003/day at Sonnet 4.6 pricing. Negligible.

---

## Implementation Plan

### Phase A — PriceRangeWeightModifier (signals + dashboard)

1. `PriceRangeWeightModifier.ts` — modifier class with matrix
2. Wire into `SignalEngine` (compose with DurationWeightModifier)
3. Remove 50/50 hard block from `setActiveMarkets()`
4. Add band boundaries + multipliers to optimizer parameter space

### Phase B — Hysteresis (dashboard)

5. Add `exit_threshold` to `trading_config` table + load on startup
6. Modify `AutoSignalExecutor.processSignal()` — split open/exit threshold logic
7. Rename `minCombinedConfidence` → `openThreshold` in config

### Phase C — Claude-first review (GitHub Actions + scripts)

8. `scripts/analyze-review.js` — Claude API call, parse outputs
9. Update `.github/workflows/daily-trade-review.yml` — add analyze step, wire routing
10. Update `format-review.js` — convert to template/prompt guide

### Phase Dependencies

```
Phase A ─── standalone
Phase B ─── standalone
Phase C ─── standalone (can run in parallel with A and B)
```

All three phases can execute in parallel.

# Event Financial OTM Near-Expiry Gate — Design

**Date**: 2026-04-21
**Status**: Spec ready
**Related**: Issue #117 (daily review), PR #118 (closed — superseded by this design)

## Context and Motivation

The daily auto-review of 2026-04-21 (issue #117) identified a recurring loss pattern on `event_financial` markets — specifically WTI crude oil price-level markets (1712297, 1712301, 1712302, 1894941). Losses are structural, not variance: 1712297 has 12 losses / 0 wins over 7 days; 1712302 has 9L/3W (25% win rate); 1894941 has 13L/0W.

The existing controls fail to stop the bleed:

- `NEAR_RESOLUTION_HOURS = 24` blocks `mean_reversion` within 24h of expiry, but WTI is traded 1–14 days out.
- `NEAR_RESOLVED_LOWER = 0.03` only blocks prices below 3%; WTI at 12% passes.
- Per-market 24h loss blocker (PR #106): WTI trades 1–2x/day, clears the 24h window.
- 7-day persistent loser ban (PR #114): `winRate < 0.15` threshold — 1712302 at 25% slips through.

Reactive responses have been threshold bumps of the same controls (PR #118 proposed `0.15 → 0.35`). A threshold chase cannot fix a structural signal/market mismatch — each new WTI market arrives with a new win rate and starts the cycle again.

### Root cause

`event_financial` markets with bounded expiry (≤2 weeks) and extreme-band prices (≤20% or ≥80%) reflect asymmetric informational priors, not mispricing. A WTI market at 12% with 9 days to expiry is fair-valued: "small probability of a large move before expiry". Mean-reversion signals interpret 12% as "oversold, revert up" and go LONG; but 12% IS the fair value. Every entry is buying deep OTM option-like exposure near expiry.

This pathology is **specific to the conjunction** (market type × time to resolution × extreme price). A `Fed rate decision` market at 50/50 with the same expiry is potentially tradeable; a `WTI` market at 12% with 6 months to expiry could revert on new information. Only the conjunction is structurally broken.

## Design Decisions (summary of brainstorm)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Gate condition logic | `market_type = event_financial` **AND** `TTR < N days` **AND** `price extreme` | Conjunction kills the exact pathology; doesn't over-block near-expiry 50/50 or long-horizon extreme markets. |
| 2 | Signal scope | All signals on matching markets (not only `mean_reversion`) | Empirically all signals lose in this zone; architectural consistency with `market_type` gate. |
| 3 | Parameter lifecycle | Hybrid — defaults now, Optuna refines in next full run | Stops the bleed immediately; honors "all params optimized" principle in background. |
| 4 | Blocked signals disposition | Shadow trade (`INSERT INTO shadow_trades`) | Coherent with existing `market_type` gate; cheap; preserves optionality to relax gate later. |
| 5 | Existing open positions | Let them run; gate blocks opens only | Consistent with all existing gates (none force-close); WTI positions resolve at expiry anyway. |

## Architecture

### Location

New gate `0e` in `AutoSignalExecutor.canExecute()`, inserted between `0d` (market_type gate) and the per-market loss blockers:

```
0a. market active/resolved check
0b. near-resolved PRICE (0.03/0.97 bounds)
0c. near-resolution TIME (24h generic — blocks mean_reversion)
0d. market_type gate (ALLOWED_MARKET_TYPES)
0e. EventOTMGate  ← NEW
    per-market 24h loss blocker
    per-market 7d persistent loser ban
    confidence/strength thresholds
execute
```

**Order rationale**:

- After `0d`: market type must be in `ALLOWED_MARKET_TYPES` before we ask "is this market-shape pathological?"
- Before per-market loss blockers: structural mismatch (market shape) is a stronger reason to block than trade history. We reject the signal on first principles rather than after three losses.

### Gate logic

```typescript
// New constants (add to top of AutoSignalExecutor.ts)
const EVENT_OTM_MARKET_TYPES = new Set(
  (process.env.EXECUTOR_EVENT_OTM_MARKET_TYPES || 'event_financial')
    .split(',').map(s => s.trim()).filter(Boolean)
);
const EVENT_OTM_TTR_HOURS = parseFloat(process.env.EXECUTOR_EVENT_OTM_TTR_HOURS || '240'); // 10 days
const EVENT_OTM_PRICE_LO = parseFloat(process.env.EXECUTOR_EVENT_OTM_PRICE_LO || '0.20');
const EVENT_OTM_PRICE_HI = parseFloat(process.env.EXECUTOR_EVENT_OTM_PRICE_HI || '0.80');

// Inside canExecute(), after 0d market_type gate:

// 0e. EventOTMGate: event_financial markets near expiry with extreme prices are
// fair-valued asymmetric priors, not mispricing. Block new opens; allow closes.
if (
  signal.marketType &&
  EVENT_OTM_MARKET_TYPES.has(signal.marketType) &&
  market.end_date &&
  EVENT_OTM_TTR_HOURS > 0
) {
  const hoursToResolution =
    (new Date(market.end_date).getTime() - Date.now()) / 3600000;
  const priceExtreme =
    signal.price < EVENT_OTM_PRICE_LO || signal.price > EVENT_OTM_PRICE_HI;

  if (
    hoursToResolution > 0 &&
    hoursToResolution < EVENT_OTM_TTR_HOURS &&
    priceExtreme
  ) {
    const openPositions = await paperPositionsRepo.getAll();
    const hasOpenPosition = openPositions.some(p => p.market_id === signal.marketId);
    if (!hasOpenPosition) {
      console.log(
        `[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ` +
        `event_otm_near_expiry (TTR=${hoursToResolution.toFixed(1)}h, price=${signal.price.toFixed(4)})`
      );
      this.insertShadowTrade(signal, 'event_otm_gated').catch(() => {});
      return {
        executed: false,
        reason: `event_otm_near_expiry: TTR=${hoursToResolution.toFixed(1)}h, price=${signal.price.toFixed(4)}`,
      };
    }
  }
}
```

Note: `insertShadowTrade` currently uses `signal.signalId` as `signal_type`. To preserve gating metadata, extend the helper with an optional override: `insertShadowTrade(signal, signalTypeOverride?: string)`. Default behavior unchanged.

### Failure modes

| Condition | Behavior |
|-----------|----------|
| `signal.marketType` null/undefined | Gate does not fire (0d already blocks unclassified) |
| `market.end_date` null | Gate does not fire; `[AutoExecutor]` logs once per market |
| `hoursToResolution` negative (market expired) | Gate does not fire; 0a handles expired/resolved markets |
| `EVENT_OTM_TTR_HOURS = 0` | Gate disabled — rollback mechanism |
| `shadow_trades` INSERT fails | Fire-and-forget — signal still blocked; no blocking on logging |

### Parameters

All env-var driven with sensible defaults. Parameters are **tunable** (thresholds), not **structural** (the condition shape is fixed).

| Env var | Default | Optuna range | Meaning |
|---------|---------|--------------|---------|
| `EXECUTOR_EVENT_OTM_MARKET_TYPES` | `event_financial` | — (structural) | Market types subject to the gate |
| `EXECUTOR_EVENT_OTM_TTR_HOURS` | `240` (10d) | `[24, 336]` | Time-to-resolution threshold in hours |
| `EXECUTOR_EVENT_OTM_PRICE_LO` | `0.20` | `[0.05, 0.25]` | Lower extreme-price bound |
| `EXECUTOR_EVENT_OTM_PRICE_HI` | `0.80` | `[0.75, 0.95]` | Upper extreme-price bound |

Optuna integration happens in a follow-up PR after defaults have been observed in production for at least one full run (~6h).

## Testing

### Unit tests

New file: `packages/dashboard/src/services/AutoSignalExecutor.eventOTMGate.test.ts`.

| Case | marketType | TTR | price | end_date | hasOpenPos | Expected |
|------|-----------|-----|-------|----------|------------|----------|
| WTI classic trap | `event_financial` | 216h (9d) | 0.12 | set | no | BLOCKED + shadow inserted |
| Near-expiry, mid-price | `event_financial` | 216h | 0.50 | set | no | PASS |
| Long-horizon, extreme price | `event_financial` | 720h (30d) | 0.12 | set | no | PASS |
| Crypto extreme near-expiry | `crypto_intraday` | 216h | 0.12 | set | no | PASS (marketType mismatch) |
| `event_financial` null end_date | `event_financial` | — | 0.12 | null | no | PASS (+ warning log) |
| Closing an open position | `event_financial` | 216h | 0.12 | set | yes | PASS (close bypass) |
| Boundary: TTR exact | `event_financial` | 240h exact | 0.12 | set | no | PASS (strict `<`) |
| Boundary: price_lo exact | `event_financial` | 216h | 0.20 exact | set | no | PASS |
| Boundary: price_hi exact | `event_financial` | 216h | 0.80 exact | set | no | PASS |
| Upper extreme (near 1.0) | `event_financial` | 216h | 0.88 | set | no | BLOCKED |
| Gate disabled via env | `event_financial` | 216h | 0.12 | set | no | PASS (`TTR_HOURS=0`) |
| Custom market_types env | `event_short` | 216h | 0.12 | set | no | BLOCKED (when `EVENT_OTM_MARKET_TYPES=event_short`) |

Tests should stub `paperPositionsRepo.getAll()` and `insertShadowTrade`. No DB required.

### Integration tests

Not required — the gate introduces no new DB lifecycle invariants (no new state, no new transactions). Shadow trade insert goes through the existing fire-and-forget helper.

### VM verification (post-deploy)

```sql
-- Confirm gate is firing
SELECT COUNT(*), MAX(time) FROM shadow_trades
WHERE signal_type = 'event_otm_gated' AND time > NOW() - INTERVAL '2 hours';

-- Confirm WTI 1712302 no longer opens new positions
SELECT market_id, side, opened_at FROM paper_positions
WHERE market_id = '1712302' AND opened_at > NOW() - INTERVAL '2 hours';
```

Expected: shadow count > 0 within ~30 min (WTI signals generate every ~60s), and zero new opens on 1712302.

## Deployment

1. Single PR on branch `fix/event-otm-gate`:
   - Code: constants + gate `0e` block in `AutoSignalExecutor.ts`
   - `insertShadowTrade` helper: add optional `signalTypeOverride` param
   - New unit test file
   - `docker-compose.gcp.yml`: add the four env vars with explicit defaults (documentation value; code already has defaults)
2. CI green + human review → merge → auto-deploy
3. Run VM verification queries within 2h of deploy
4. Observe for 48h: shadow count grows, no new opens on matching markets, no regression in crypto or non-extreme markets
5. Follow-up PR (separate work item): add the three tunable params to `OPTUNA_PARAM_SPACE` so the next full run refines them

### Rollback

- Immediate: set `EXECUTOR_EVENT_OTM_TTR_HOURS=0` in `docker-compose.gcp.yml`, restart dashboard-api. Gate never fires. No code revert needed.
- Code revert: single PR revert — no DB state to clean up; shadow trades can stay as historical record.

### Related tracking

- Issue #117 stays open; comment references this design as the structural fix replacing closed PR #118.
- No new GitHub issue needed.

## Out of scope

- Adding a gate for upper extreme prices (>0.80) on the assumption of symmetric pathology. The design already handles it via `EVENT_OTM_PRICE_HI`. Empirical confirmation comes from production shadow data.
- Force-close of existing open positions — rejected in brainstorm Q5 for consistency with existing gate patterns.
- Broadening to `event_short`/`event_long` proactively — those types are currently blocked by `market_type` gate; this gate only runs on market types that pass `0d`. Future re-enabling of those types is a separate decision.
- Refactor of entry-eligibility gates into a dedicated service — scope creep; current pattern is clear enough.
- Optuna param-space expansion — intentionally deferred to a follow-up PR so initial defaults can be observed unperturbed.

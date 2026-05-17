# resolution_prior_v2 — design

## Motivation

The existing `ResolutionPriorGenerator` (v1) emits a directional signal whenever price ≠ 0.5 and `daysToResolution ≤ cutoffDays`. Direction is always `price > 0.5 ? LONG : SHORT`, magnitude scales with `|price - 0.5| × (1 - TTR/cutoff)`. It assumes the *current* price is a trustworthy probability — i.e. the market knows.

That assumption breaks down when:
1. The market has very thin liquidity (single-LP regime, the price moves on small flow rather than information).
2. There's information cascade lag — a recent news event hasn't propagated yet, so price hasn't caught up.
3. Early in the market's life when the LP is still bootstrapping price discovery (price set by initial quotes rather than belief).

`resolution_prior_v2` (RPv2) is the generator we want when the v1 anchor (`0.5`) is no longer the right reference. Per the research doc:

> *"En lugar de comparar precio con SMA, comparar con time-decayed prior. Default prior: 0.5 + (precio inicial market - 0.5) × decay_factor(time_to_end). Si precio actual está N std fuera del prior decayed → mispricing. Foco en TTR (time-to-resolution) < 7 días (donde la información ya está digerida)."*

That sentence is dense. This doc unpacks it into concrete model choices.

## The four design decisions

### 1. What is the prior?

Three candidates:

**(A) Static initial price.**
```
prior(t) = initialPrice
```
Initial price = price observed when the market was first ingested. The prior is what the market originally thought. As time passes, current price either confirms (drift small) or contradicts (drift big) the original belief.

Pros: easy to compute (stored on market creation), gives a fixed anchor.
Cons: stale on long markets — initial price from 6 months ago doesn't reflect new information.

**(B) Time-decayed convex combination toward 0.5.**
```
decay(t)   = 1 - daysToResolution / cutoffDays   ∈ [0, 1]    (0 early, 1 late)
prior(t)   = 0.5 + (initialPrice - 0.5) × (1 - decay(t))
           = decay(t) × 0.5 + (1 - decay(t)) × initialPrice
```
Early in life: prior ≈ initialPrice. Late in life: prior ≈ 0.5.

This is the literal reading of the research doc, but the direction is backwards from what you'd naively expect: it makes the prior MORE agnostic as resolution approaches. The intuition would have to be: "early, we trust the initial belief; late, we know less and let the price decide".

Pros: matches the research-doc spec verbatim.
Cons: counter-intuitive. Most Bayesian frameworks have the prior tighten with time, not loosen.

**(C) Time-decayed convex combination toward terminal extremes.**
```
decay(t)   = 1 - daysToResolution / cutoffDays
terminalEstimate(t) = currentPrice > 0.5 ? 1.0 : 0.0
prior(t)   = decay(t) × terminalEstimate(t) + (1 - decay(t)) × 0.5
```
Early: prior = 0.5. Late: prior approaches the terminal extreme. The prior converges to YES/NO as the market matures.

Pros: matches Bayesian intuition — the posterior becomes more informative.
Cons: terminalEstimate depends on currentPrice — circular if currentPrice is what we're testing.

**Recommendation: (A) — static initial price**. Cleanest semantics, no decay-direction ambiguity, and the v2's value-add over v1 is exactly *the* anchor that the SMA-based generators miss. We can revisit (B) or (C) as RPv2.1 if (A)'s edge is real but limited.

### 2. What is the volatility estimate?

Two candidates:

**(I) Rolling stddev of price returns.**
```
returns = [ (priceBars[i] - priceBars[i-1]) / priceBars[i-1] for i in 1..N ]
σ       = stddev(returns)
```

**(II) Rolling stddev of price levels.**
```
σ = stddev(closes_last_N_days)
```

**Recommendation: (II)** — for binary prediction markets prices are themselves probabilities, so the natural scale is the price itself, not returns. `(price - prior) / σ_levels` reads as "how many σ-units does the price differ from where we thought it should be?".

### 3. What is the deviation threshold?

The generator should NOT emit on tiny deviations — noise eats those signals. A reasonable z-score threshold lives somewhere in [1.5, 3.0]. Below 1.5 produces too many false positives; above 3.0 produces too few.

**Recommendation: default `minZScore = 2.0`**. Tuneable via params + Optuna.

### 4. What is the focus window (TTR)?

The research doc says "foco en TTR < 7 días". Generators with broad TTR coverage (the v1 has `cutoffDays = 14`) emit lots of weak signals where the prior isn't actually informative.

**Recommendation: `cutoffDays = 7` for RPv2 default**. Tighter than v1, focused on the "information already digested" window.

## Concrete RPv2 spec

```typescript
export interface ResolutionPriorV2Params {
  cutoffDays: number;        // default 7
  lookbackBars: number;      // default 20 — bars for σ computation
  minZScore: number;         // default 2.0
  minStrength: number;       // default 0.05
}

// pseudocode
compute(context) {
  if (daysToResolution > cutoffDays || daysToResolution <= 0) return null;
  if (priceBars.length < lookbackBars) return null;

  const initialPrice = priceBars[0].close;      // first observed price for this market
  const currentPrice = priceBars[last].close;
  const σ = stddev(priceBars.slice(-lookbackBars).map(b => b.close));
  if (σ <= 0) return null;                        // no variation — no usable signal

  const prior = initialPrice;                     // Decision (A)
  const deviation = currentPrice - prior;
  const z = deviation / σ;
  if (Math.abs(z) < minZScore) return null;

  // Direction: price below prior → expect mean-revert UP → LONG
  //            price above prior → expect mean-revert DOWN → SHORT
  const direction = z < 0 ? 'LONG' : 'SHORT';
  const magnitude = Math.min(1, (Math.abs(z) - minZScore) / 3);   // saturates at z ≈ 5
  if (magnitude < minStrength) return null;

  const strength = direction === 'LONG' ? magnitude : -magnitude;
  const confidence = 0.4 + 0.5 * magnitude;
  return createOutput(direction, strength, confidence, { z, deviation, prior, σ });
}
```

## What this gives us

- A SECOND directional voice from the resolution-aware family, distinct from v1.
- A direct test of the *mean-reversion in prediction markets* hypothesis using a stable anchor (initial price), not the rolling SMA which mean_reversion already uses.
- An additive signal to the combiner — when v1 and v2 agree, consensus discount rewards. When they disagree, the combiner downweights both.

## What this does NOT solve

- It assumes the initial price is meaningful. If the market opens with a noisy LP quote (e.g., 0.50 placeholder), the prior is no better than v1's 0.5 anchor.
- It still depends on the rotator selecting markets where this generator can fire. Market 1323366 ("Ukraine ceasefire", price 0.08) — the longshot we tried to verify favorite_longshot_bias against today — is NOT in the SignalEngine's active set. RPv2 would have the same blocker.

## Risks / open items

1. **Initial price source**: where in the DB do we read it from? The earliest `price_history` row per market is the simplest answer, but if a market was already trading before the data-collector started snapshotting, that "initial" is post-discovery. Mitigation: clip to bars within the first N hours of ingestion.
2. **σ for short-history markets**: a brand-new market has < `lookbackBars` bars. Generator returns null — fine, but means RPv2 is silent on the markets that v1 fires on most aggressively. Net effect: less coverage, not necessarily a problem.
3. **dm interaction**: RPv2 emits LONG when price is below prior (mean-revert UP). That's the OPPOSITE of v1, which emits SHORT when price < 0.5. The combiner with per-direction weights handles this — but the optimizer needs both signals in its param space (we'd need to add `combiner.resolutionPriorV2Weight` analogous to `combiner.resolutionPriorWeight`).

## Rollout plan

PR-A: `ResolutionPriorV2Generator.ts` + 25-ish unit tests. Default weight 0.0 (bootstrapped via server.ts). Wired into SignalEngine, BacktestService. Optuna param-space entry.

PR-B (later): observation period — let Pilar 1 cron measure cost-aware t-stat for ~7 days. If positive cell appears, optimizer ratchets weight; otherwise, decision-time on whether to keep or kill.

Estimated PR-A: ~250 LoC + 100 LoC tests. One session.

## Open questions before coding PR-A

1. **Accept decision (A) for the prior?** I argued for static initial price. Alternative is (B) or (C) — flag if you want to revisit.
2. **Accept `cutoffDays=7` default?** Tighter than v1's 14. Could go even tighter (3 days).
3. **Initial price source**: earliest `price_history.close` for the market OR a snapshot column on `markets` table? The former is easier; the latter would need a migration.
4. **σ floor**: what's the minimum σ below which we don't fire? Default proposed: `σ > 0`, but if σ is tiny (< 0.001) the z-score blows up artificially. Reasonable floor: `σ ≥ 0.005` (0.5% on a 0–1 scale).

## Acceptance criteria

When PR-A lands and Pilar 1 measures for 7 days:

- ✅ generator_predictions has rows with `signal_id = 'resolution_prior_v2'`.
- ✅ generator_edge has a cell for at least one (market_type, direction) pair, with `n ≥ 30`.
- ⏳ If t_net > 0 in any cell, hand off to the optimizer to ratchet the weight up. Quitting criteria: if all cells negative after 14 days, kill the generator (revert PR or set weight to 0 permanently).

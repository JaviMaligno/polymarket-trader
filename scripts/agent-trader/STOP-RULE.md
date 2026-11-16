# Stop rule — does the agent forecast better than the market? (pre-registered 2026-11-16)

Operator-only. Not referenced by the prompt or `rules.md`.

## Why

From Run 23 to Run 28 (2026-11-02 → 2026-11-16) the agent placed no bets, so the bet-level verdict
(`metrics.py`, ≥20 resolved bets, ~60 to detect +$5/bet) cannot be reached at this pace. It
records a probability for every candidate it declines (`declines.jsonl`, since
#355), though. Scoring those against resolution asks the underlying question directly: does the
agent know more than the price? It does not change the agent's behaviour, the entry bar or the
stake.

## What is scored

- **Unit:** one forecast per market: the earliest receipt in `declines.jsonl` with a stated
  `p_hat_yes`. Later revisits are ignored, so the agent cannot improve a forecast by waiting
  for news. Evidence vetoes without a probability are not forecasts.
- **Agent:** `p_hat_yes` (the point estimate, not `conservative_p_yes`).
- **Market:** the YES mid `(best_bid + best_ask) / 2` of the same receipt's quote: same moment,
  same information.
- **Outcome:** Gamma `closed` and `outcomePrices[0] ≥ 0.99` → YES, `≤ 0.01` → NO. Any other
  closed price (split/50-50) is VOID and excluded. Final outcomes are appended once to
  `forecast_outcomes.jsonl` by `forecast_score.py update` (run in the workflow after the
  agent's turn).
- **Statistic:** paired difference `d = (p_agent − y)² − (p_market − y)²`. Negative = the
  agent beats the market.
- **Stories (clusters):** forecasts on one real-world story resolve together (four of the nine
  Run 28 candidates were the Iran war; many expire on 2026-12-31), so they are not independent.
  Each forecast belongs to a story: the operator map `forecast_clusters.json` (market id or
  Polymarket event id → label) if it lists it, else its Polymarket event (stored by `update`),
  else the market itself. The CI is a **cluster bootstrap**: resample whole stories, 4000
  resamples, seed 0. The operator extends the map at each review. Merging correlated stories
  widens the interval to its honest width; never split a story to tighten it.

## The rule

| Resolved forecasts and distinct stories | Condition | Status |
|---|---|---|
| < 50 forecasts or < 25 stories | — | `collecting` |
| ≥ 50 and ≥ 25 stories (look 1) | CI upper bound < 0 | `agent_beats_market` → decide the next phase (sizing, entry bar) |
| ≥ 50 and ≥ 25 stories (look 1) | mean d < 0, CI includes 0 | `continue` → wait for look 2 |
| ≥ 50 and ≥ 25 stories (look 1) | mean d ≥ 0 | `stop` → close the experiment |
| ≥ 100 and ≥ 50 stories (look 2, final) | CI upper bound < 0 | `agent_beats_market` |
| ≥ 100 and ≥ 50 stories (look 2, final) | otherwise | `stop` |

Each look uses a **97.5%** CI, so the two looks together keep the chance of a false
`agent_beats_market` at or below 5% (Bonferroni). `stop` needs no significance: the experiment
exists to show the agent is better. An agent that is not better on average after 50 forecasts
is not worth continuing.

`stop` and `agent_beats_market` change nothing automatically. They mark the weekly email
subject and the run log, and the operator decides.

## Known limits (accepted, not corrected)

- The story map is a judgement. Stories that are correlated but not merged (two elections
  that move with one national swing) still understate the variance somewhat. When in doubt,
  merge.
- The Brier comparison measures information, not profit. It ignores spread and fees, and the
  bet-level verdict in `metrics.py` still governs money. An agent that beats the market by a
  margin smaller than the costs would still not make money.
- Placed bets are scored by `metrics.py`, not here, unless a decline receipt also exists for
  the same market.

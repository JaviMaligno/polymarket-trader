# H-INE-3 Sub-project B — news-lag validator (price-continuation core)

**Date:** 2026-06-23
**Program:** H-INE-* informational edge. Parent: `project_h_ine_program_2026-06-23`.
**Status:** design approved, ready for plan.
**Depends on:** Sub-project A census (`news_linkability.py`) — forward GO, ~51 active linkable
lag-candidate markets (geopolitical 9 lead, commodity/macro 34 control, crypto/tech 8).

## Why

H-INE-3 hypothesis: after a news event on a market's entity, the market UNDERreacts — the
initial price move continues (a lag we can capture). Before spending LLM/sentiment effort,
answer the cheap prerequisite **does lag exist at all** on the 4-second price history we
already collect. If the market reprices instantly (efficient) or not at all, the direction
question is moot and the hypothesis dies cheap. So this sub-project builds the lag-detection
core + the price-continuation direction arm, evaluated as a **semi-backtest on existing 4s
history** (no resolution needed — the underreaction is measured as post-burst mark-to-market
drift). The sentiment-LLM arm + hybrid comparison + full hold-to-resolution PnL are gated on
this core showing lag exists (Sub-project C).

## Decisions locked in brainstorming

- Direction: user wants sentiment to lead but a **hybrid compared to price-continuation**.
  Build order: price-continuation core first (cheap, computable now); sentiment + hybrid gated
  on lag existing.
- Evaluate as a semi-backtest NOW (existing 4s history) + forward later (hold-to-resolution).

## Architecture — `scripts/edge-research/news_lag.py`

Pure-Python, harness conventions, offline-testable on synthetic fixtures. The live data
(news event times + 4s price series per market) is pulled into local CSVs by a thin loader;
all logic is unit-tested without network.

### Data contracts

- `news_events`: per market, sorted list of unix-second timestamps where a news title matched
  the market's entities (from the census classifier + `_news_titles.csv`).
- `price_series`: per market, sorted list of `(t_unix, price)` (Yes price), 4s or downsampled.

### Components

1. **Burst detector** — `detect_bursts(event_times, baseline_win=86400, spike_win=3600,
   min_ratio=3.0, min_count=3) -> list[int]`. A burst at time t = a `spike_win` window whose
   article count ≥ `min_count` AND ≥ `min_ratio`× the trailing-`baseline_win` rate. Returns
   de-duplicated burst start times (one per cluster; suppress re-triggers within `spike_win`).

2. **Price-window mover** — `price_at(series, t) -> float|None` (last price at/before t) and
   `move(series, t0, dt) -> float|None` = `price_at(t0+dt) - price_at(t0)` (signed Yes-price
   change). Used to measure the lag shape across `dt ∈ {300, 3600, 14400}` s.

3. **Continuation signal** — `continuation(series, burst_t, react_win=900, hold_win=14400)
   -> dict`. Direction = sign of the nascent move over `[burst_t, burst_t+react_win]`. Entry at
   `burst_t+react_win` at that price; the **underreaction proxy edge** = further signed move
   over `[burst_t+react_win, burst_t+react_win+hold_win]` in the entry direction, MINUS one-way
   cost. Returns `{direction, entry_price, nascent_move, continuation_move, edge_net}`. A burst
   with no nascent move (|move|<eps) → direction 0, skipped.

4. **Lag-shape diagnostic** — `lag_shape(moves_5m, moves_1h, moves_4h) -> dict`: fraction of the
   4h move already realised by 5m vs 1h. >~0.8 by 5m = efficient (no lag); a rising profile =
   lag. This is the cheap "does lag exist" read, independent of direction.

5. **Scorer** — `score_continuation(results, cost=0.0054) -> Verdict`. Aggregates the
   per-burst `edge_net`, bootstrap CI (reuse `validators/base.bootstrap_ci`), **clustered by
   market** (one market's bursts are not independent — block-bootstrap by market_id). Emits a
   harness `Verdict` (hypothesis_id H-INE-3, class inefficiency). status=pass iff mean>0 and
   bootstrap_lo>0 and n_bursts≥floor (default 100).

### Loader + CLI

- `pull` (separate, run by controller): for a market subset (LEAD = geopolitical, 9 markets,
  to keep the fragile VM light), pull news-event times (entity matches) + 5-min-bucketed price
  series over the news window → `datasets/_lag_<subset>.csv`.
- CLI runs detect_bursts → continuation per market → score, prints lag_shape + the verdict.

## Error handling

- Markets with no price series or no bursts are skipped and logged (no silent drops).
- `price_at` before the series start → None; bursts whose windows fall outside the price series
  are dropped (logged).

## Testing (TDD, synthetic fixtures, no network)

- `detect_bursts`: flat low-rate stream → no burst; an injected spike (≥min_count, ≥ratio) →
  one burst; two spikes spaced > spike_win → two bursts; a spike below min_count → none.
- `price_at`/`move`: step series → correct last-value lookup and signed move; before-start → None.
- `continuation`: a series that drifts UP after a burst → direction +1, positive continuation
  edge; an instantly-repriced series (jump then flat) → ~0 continuation edge (efficient, fails);
  a mean-reverting series → negative continuation edge.
- `lag_shape`: instant-jump moves → ~1.0 realised-by-5m (efficient); gradual → rising profile.
- `score_continuation`: synthetic positive-edge bursts clustered in 1 market → wide CI (n
  effectively small); spread across many markets → tighter; all-zero → fail.

## Out of scope (Sub-project C, gated on lag existing)

- Sentiment-LLM (Haiku) direction arm + hybrid (price∧sentiment) comparison.
- Full hold-to-resolution PnL (needs resolutions, weeks out).
- registry/run.py wiring as a standing forward job.

## Success criteria

- `news_lag.py` with all components, unit tests green on synthetic fixtures.
- A semi-backtest run on the geopolitical subset printing `lag_shape` (does lag exist?) and the
  price-continuation `Verdict`. An explicit read: lag exists (→ proceed to sentiment/hybrid C) or
  not (→ H-INE-3 underreaction hypothesis fails cheap, document like the others).

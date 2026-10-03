# Pre-registration — the side-bias hypothesis

Registered **2026-09-21**, from the weekly review of Run 18. Nothing below may be edited
except the *Observations* table and the *Verdict* section, and only by adding rows.

The point of writing it down before collecting the data is that this is a **post-hoc
split**: the record was cut by side *after* seeing that one side looked bad. On a sample
of 15 there are many such cuts — by side, by confidence label, by market family, by
horizon, by fee status — and the most extreme one always looks significant. So the split
below is a **hypothesis to test on future bets**, not a finding, and this file fixes the
prediction, the bar and the stopping rule in advance so the answer cannot be negotiated
after the fact.

## The observation that motivated it (frozen at n=15)

Record as of 2026-09-21, from `metrics.jsonl` (`date: 2026-09-21`):

| side | n | record | P&L | mean/bet | bootstrap 95% CI |
|------|---|--------|-----|----------|------------------|
| NO   | 6 | 5-1    | +$43.98  | +7.33   | [−6.72, +18.31] |
| YES  | 9 | 3-6    | −$116.81 | −12.98  | **[−25.18, −0.54]** |

Seven of the eight losses are YES bets. The YES subset is the first in this experiment
whose bootstrap CI excludes zero. Overall: 15 resolved, 8-7, −$72.83, verdict `too_few`.

## The hypothesis

**H1.** The agent's edge is concentrated in bets that a **strict formal criterion will
NOT be met inside the window**, and it loses on bets that a **discrete event WILL
happen inside the window**. On this market structure those map almost exactly onto NO
and YES respectively.

The mechanism it claims: the agent's documented wins are Family (i) — Bolojan, the
Israel–Hezbollah "permanent" wording, Sulyok's effective date, the US–Iran MOU
extension — all of which are NO bets on a market pricing the casual reading of a
question. Its losses are forecasts that something specific happens by a date. If H1 is
true, "Family (i) edge" and "NO-side edge" are the same statement, and the YES bleed is
the agent paying for the privilege of forecasting events.

**H0.** The split is sampling noise. The true mean P&L per bet does not differ
materially by side, and the 2026-09-21 gap is what a post-hoc cut of 15 observations
looks like.

## Rival explanations that must be ruled out before H1 is believed

These are not separate hypotheses; they are ways H1 could be **right about the numbers
and wrong about the cause**. Each is checked at the decision point.

1. **Family, not side.** If the wins are Family (i) regardless of side, the rule to draw
   is about criterion-reading, not about YES/NO. Check: tabulate resolved bets by
   declared family × side. A NO bet that is *not* Family (i) losing, or a YES Family (i)
   bet winning, argues for family.
2. **Price level, not side.** NO bets here tend to sit at high held-prices (0.62–0.86),
   i.e. short-odds favourites, which win more often by construction and pay less. If the
   split is really "favourites vs longshots", the edge is a payoff-profile artefact and
   does not survive. Check: mean entry(held) by side, and P&L against entry price.
3. **One bet carrying the result.** Check: remove the single largest loser and the
   single largest winner and re-run the CI on each side.
4. **Fee asymmetry.** 7 of the first 16 markets charge no fee. Check: whether fee-paying
   markets cluster on one side.
5. **Model, not side** (added 2026-10-03, before any bet from another model existed). All
   bets so far are Sonnet 4.6. The move to Sonnet 5.5 (with a different search backend,
   `search_mcp.py`) changes two things at once; if it lands mid-sample, a different YES/NO
   record may be the model or the search changing, not
   the side effect being real or false. Check: every bet carries `model` (absent = 4.6);
   report the split within one model and do not pool across models to reach the threshold.

## Decision rule (fixed in advance)

Evaluated **only on bets resolved after 2026-09-21** — the 15 above are the motivating
sample and cannot also be the test.

- **Minimum sample:** 20 further resolved bets, with **n ≥ 8 on each side**. Below that,
  no verdict, regardless of how the numbers look. If a side has fewer than 8 because the
  agent stopped taking it, see *Contamination* below.
- **H1 supported** if, on the new sample alone, the YES mean P&L/bet is negative with a
  bootstrap upper bound **below zero**, AND the NO mean is positive, AND none of the four
  rival explanations accounts for the gap.
- **H1 rejected** if the two sides' CIs overlap materially, or if the YES mean is not
  negative.
- **Indeterminate** otherwise — which is a real outcome, and keeps the experiment blind
  for another cycle rather than promoting a coin flip to a rule.

Only on **H1 supported** does anything change in how bets are selected. The change would
then be argued and written down as its own design note, not applied from this file.

## Contamination rule — why the agent is not told

Telling the agent "your YES bets lose" would make it stop taking YES bets. The future
sample would then contain no YES bets to test, and any improvement could not be
separated from "the agent was told". So the split is computed and persisted for the
operator and kept out of every surface the agent reads:

- `metrics.render_text` — the agent-facing view (`python metrics.py`, and the
  `agent_trader.py metrics` snapshot print) — **does not** carry it.
- `metrics.render_operator_text` (`python metrics.py --operator`) and the weekly email
  **do**. The workflow prints the operator view only after the agent's turn has ended.
- `tests/test_side_bias.py` pins that separation, so it cannot drift into the agent's
  view on a later edit to the renderer.

This is blind by construction, not by secrecy: the agent has `bets.jsonl` and could
compute the split itself. Nothing in the prompt asks it to, and no output hands it over.
If a future `lessons.md` section shows the agent has derived it independently, the blind
is broken — record that date in *Observations* and treat every bet after it as
contaminated.

## Observations

One row per weekly run, from the `yes_*` / `no_*` columns of `metrics.jsonl`. Only bets
resolved after 2026-09-21 count toward the decision rule.

| run date | new resolved | YES n / P&L (new only) | NO n / P&L (new only) | blind intact? | note |
|----------|--------------|------------------------|-----------------------|---------------|------|
| 2026-09-21 | — | baseline 9 / −$116.81 | baseline 6 / +$43.98 | **no** (see below) | pre-registration; counters start at zero |
| 2026-10-02 | 1 | 0 / $0.00 | 1 / +$5.12 | **no** | Bet 16 (Iran blockade Sep-30 NO), Sonnet 4.6. The 09-28 run was null (reviewer backgrounded); Run 19 came from the day-2 catch-up |

**The blind was broken before this file was written.** Found 2026-10-03. The human review
of Run 15 (commit `b30ef29`, 2026-08-31) appended to `lessons.md` — which the agent reads in
full every run — "NO 5-0, YES 3-6 — all six losses are YES bets … Treat a YES bet as needing
a higher bar than a NO bet of the same nominal edge." Every run from Run 16 (2026-09-07) on
has seen it. The 2026-10-03 rehearsal shows it is used: the agent declined a YES candidate
because "all 6 track-record losses are YES bets". So every bet placed from 2026-09-07 is
contaminated under the rule above, and the 20-bet test cannot run as designed until the
agent's memory is blind again. What to do about it is an open operator decision.

## Verdict

Not reached, and not reachable as pre-registered while the agent's memory carries the split.

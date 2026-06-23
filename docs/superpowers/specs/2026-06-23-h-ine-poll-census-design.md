# H-INE-POLL Sub-project A — Poll-supply census + transform calibration

**Date:** 2026-06-23
**Program:** H-INE-* informational edge (post market-making). Parent: `project_h_ine_program_2026-06-23` memory.
**Status:** design approved, ready for plan.

## Why this exists

The conditional/dependent-staleness route (H-INE-4) just closed **NO-SUPPLY** — an
exhaustive pairing pass over the 1,721-market political catalog found **0** clean
primary→general conditional pairs (Polymarket does not list candidate-level general
markets for the same US races where it lists nominee/primary markets). The binding
constraint was *supply*, discovered only after the code was built.

H-INE-POLL is the surviving informational-edge route: compare an **external
poll-implied probability** to the Polymarket price, enter the mispriced side, hold to
resolution, score cost-aware OOS. It needs no second market, so the no-pair-supply
blocker does not apply. But poll *data* must be sourced externally, and the same
supply question that killed the conditional route applies here: **does n≥200 actually
exist?**

The lesson made into process: **census first, build the engine only once fuel is
confirmed.** This sub-project (A) is that census. The full validator + price backfill
+ verdict is sub-project B, gated on A's result.

## Goal

Produce, with data, a go/no-go for sub-project B:
1. The **reachable n** for poll-anchored political edge, broken down by coverage tier.
2. A **validated `margin → win-prob` transform** (fit + calibration check) on the
   subset of races that have both an aggregator win-prob and raw poll shares.

## Decisions locked in brainstorming

- **Edge thesis:** measure poll-vs-price across *all* races with polls and let the
  cost-aware scoreboard cohorts reveal where (if anywhere) net edge lives; add a
  timing/lag dimension if it contributes. (Not pre-committing to down-ballot-only.)
- **Poll→prob mapping:** *both, compared* — use aggregator win-probs as ground truth
  to calibrate a `margin→win-prob` transform on raw poll shares, then apply the
  validated transform to races that have only raw polls (down-ballot). Mitigates the
  model risk of a home-grown transform with the aggregator anchor.
- **Universe:** decided by the census, not a priori.

## Architecture

A single self-contained tool, `scripts/edge-research/poll_census.py`, following the
existing harness conventions (offline-CSV friendly, pure-Python, pandas, pytest).
No DB dependency for the census itself (reads the catalog CSV already on disk).

### Components

1. **Race parser** — `parse_race(question, end_date, resolved_at) -> Race`.
   Maps each catalog row to a structured race:
   `Race(country, office, race_id, candidate, resolution_date, stage)` where
   `stage ∈ {primary, nominee, advance, general, other}`. Country/office are
   extracted by keyword + seat-code regex (US `XX-NN`, "<place> Governor/Senate",
   country names for parliamentary/presidential). Unknowns labelled `other`/`unknown`
   rather than guessed.

2. **Coverage classifier** — `classify_coverage(race, verifier) -> Coverage`.
   Assigns a tier prior from (country, office), then optionally upgrades/confirms it
   with a `verifier` callback that does a real web lookup (WebSearch/WebFetch against
   Wikipedia "Opinion polling for the … election" and a Silver/Economist spot-check).
   Output label per race: `aggregator` (has published win-prob), `raw_polls` (has a
   Wikipedia polling table but no win-prob aggregator), `none`. The verifier is
   injected so the classifier is unit-testable offline (pass a stub verifier).

3. **Census report** — aggregates per (country, office, tier). Reports **two n's**,
   because a hold-to-resolution obs is per candidate-market but the candidate markets
   of one race are a correlated negRisk set (shares sum to ~1), so they are *not*
   independent: (a) **distinct races** = conservative independent n; (b)
   **candidate-markets** = optimistic raw n. The GO/NO-GO bar is read against the
   conservative count. Writes
   `scripts/edge-research/datasets/poll_supply_census.csv` (one row per race:
   `race_id, country, office, stage, candidate, resolution_date, tier, source_url`)
   plus a printed summary with reachable-n by tier. **This is the go/no-go artifact.**

4. **Transform calibrator** (gated — only runs if dual-coverage races ≥ a floor,
   default 30) — `fit_margin_to_winprob(samples) -> Transform`. Fits a logistic
   `win_prob = sigmoid(a * margin / sigma(days_to_election))` on (margin, outcome)
   from dual-coverage races, validates against the aggregator's published win-prob
   via Brier score and a calibration-by-decile table, persists params to
   `datasets/poll_transform_params.json`. If the dual-coverage floor is not met, the
   calibrator is skipped and the census report says so (transform deferred to B).

### Data flow

```
conditional_catalog_political.csv  (1,721 rows, on disk)
        │  parse_race
        ▼
   Race records  ──classify_coverage(verifier=web)──►  tier per race
        │                                                    │
        ▼                                                    ▼
 poll_supply_census.csv  ◄──── census report ────  reachable-n by tier  ──► GO / NO-GO
        │
        ▼ (if dual-coverage ≥ floor)
 fit_margin_to_winprob ──► poll_transform_params.json  + Brier/calibration check
```

## Error handling

- Web verifier failures (timeouts, missing articles) downgrade a race to its prior
  tier and record `source_url=null`; they never crash the census. The census is
  resumable — already-classified races are read back from the partial CSV on re-run.
- Races the parser cannot resolve to (country, office) are emitted with
  `tier=unknown` and counted separately, not silently dropped (the conditional lesson:
  no silent caps — `log` what was excluded).

## Testing

- **Race parser:** table of ~15 known catalog questions → expected
  (country, office, stage). Includes US House (`KY-04`), US Senate ("Senate in
  Illinois"), US Gov ("Alabama Governor"), foreign parliamentary ("Hungarian
  Parliamentary"), foreign gubernatorial ("Gyeonggi Province"), and a placeholder/
  noise row (`Person A`) → `unknown`.
- **Coverage classifier:** with a stub verifier, assert tier priors by (country,
  office); assert verifier-confirmed upgrade path; assert a verifier exception
  downgrades to prior, not crash.
- **Transform calibrator:** synthetic (margin, outcome) drawn from a known logistic →
  fit recovers params within tolerance and Brier is below an unconditional-base
  baseline; degenerate input (all same outcome) returns a defined "uninformative"
  result rather than NaN.
- **Census integration:** end-to-end on a 20-row fixture with a stub verifier →
  expected per-tier counts and a written census CSV.

## Out of scope (sub-project B, gated on this)

- Polymarket price-series backfill for the political markets (hourly, LOGGED
  `flb_backtest_prices`).
- The actual poll *time series* scrape (this census only checks coverage existence
  and fits the transform on a dual-coverage subset; B does the full scrape).
- The `PollValidator` (level signal + timing/lag dimension), its cohorts, and the
  cost-aware OOS verdict on the harness scoreboard.
- Registry entry `H-INE-POLL` and `run.py` wiring (added in B when the validator exists).

## Success criteria

- `poll_supply_census.csv` exists and classifies every one of the 1,721 catalog rows
  (no silent drops; `unknown` counted).
- A printed reachable-n table by tier that supports an explicit GO (n≥200 plausible in
  `aggregator`+`raw_polls`) or NO-GO (document the shortfall, like conditional).
- If GO: `poll_transform_params.json` with a Brier score beating the unconditional
  base rate on the dual-coverage validation set; else an explicit "transform deferred,
  insufficient dual-coverage" note.
- All unit + integration tests green.
